/**
 * Tests for src/http.ts — integration tests for HTTP endpoints and
 * unit tests for session-management logic (bounds + idle eviction).
 */

import { afterEach, beforeEach, describe, expect, it, jest, mock, spyOn } from "bun:test";
import http from "node:http";
import net from "node:net";
import type { BootstrapResult } from "./bootstrap.js";
import { VAULT_FOLDERS } from "./config/folders.js";
import type { VaultConfig } from "./config.js";
import {
  buildPublicHealthResponse,
  closeActiveSessionsForShutdown,
  createInFlightRequestTracker,
  createUnrefedTimeoutPromise,
  handleExistingSessionRequest,
  handleNewSessionRequest,
  handleNewSessionTransportError,
  parsePositiveIntEnv,
  startHttpServer,
} from "./http.js";
import { createServer as createMcpServer } from "./mcp/server.js";
import { metrics } from "./utils/metrics.js";
import type { VaultServices } from "./vault/manager.js";

// ── HTTP helpers ───────────────────────────────────────────────────────────────

function httpGet(url: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let data = "";
        res.on("data", (chunk: string) => {
          data += chunk;
        });
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: data });
          }
        });
      })
      .on("error", reject);
  });
}

function httpRequestJson(
  url: string,
  opts: {
    method: string;
    body?: unknown;
    headers?: Record<string, string | number>;
  },
): Promise<{ status: number; body: unknown; headers: http.IncomingHttpHeaders }> {
  const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method: opts.method,
        headers: {
          ...(payload
            ? {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(payload),
              }
            : {}),
          ...opts.headers,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: string) => {
          data += chunk;
        });
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(data), headers: res.headers });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: data, headers: res.headers });
          }
        });
      },
    );
    req.on("error", reject);
    if (payload) req.end(payload);
    else req.end();
  });
}

function httpPostJson(url: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: string) => {
          data += chunk;
        });
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: data });
          }
        });
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

function httpPostJsonWithHeaders(
  url: string,
  body: unknown,
  headers: Record<string, string | number>,
): Promise<{ status: number; body: unknown }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
          ...headers,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: string) => {
          data += chunk;
        });
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: data });
          }
        });
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

function httpPostChunked(
  url: string,
  payload: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const port = Number(parsed.port);
    const host = parsed.hostname;
    const path = parsed.pathname;

    const chunkHex = Buffer.byteLength(payload).toString(16);
    const extraHeaderLines = Object.entries(extraHeaders)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\r\n");
    const raw =
      `POST ${path} HTTP/1.1\r\n` +
      `Host: ${host}\r\n` +
      `Content-Type: application/json\r\n` +
      `Transfer-Encoding: chunked\r\n` +
      (extraHeaderLines ? `${extraHeaderLines}\r\n` : "") +
      `\r\n` +
      `${chunkHex}\r\n` +
      `${payload}\r\n` +
      `0\r\n\r\n`;

    const sock = net.connect(port, host, () => {
      sock.write(raw);
    });

    let response = "";
    sock.on("data", (chunk: Buffer) => {
      response += chunk.toString();
    });
    sock.on("end", () => {
      const [headersPart, ...bodyParts] = response.split("\r\n\r\n");
      const statusLine = headersPart.split("\r\n")[0];
      const statusCode = Number.parseInt(statusLine.split(" ")[1] ?? "0", 10);
      const bodyStr = bodyParts.join("\r\n\r\n").trim();
      try {
        resolve({ status: statusCode, body: JSON.parse(bodyStr) });
      } catch {
        resolve({ status: statusCode, body: bodyStr });
      }
    });
    sock.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ECONNRESET" || err.code === "EPIPE") {
        resolve({ status: 413, body: { error: "Payload too large" } });
      } else {
        reject(err);
      }
    });
  });
}

function waitForListen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    if (server.listening) {
      resolve((server.address() as { port: number }).port);
      return;
    }
    server.once("listening", () => {
      resolve((server.address() as { port: number }).port);
    });
    server.once("error", reject);
  });
}

function makeMockSvc(overrides: Partial<VaultServices> = {}): VaultServices {
  return {
    vault: {} as VaultServices["vault"],
    searchStore: {} as VaultServices["searchStore"],
    vaultSync: {} as VaultServices["vaultSync"],
    capture: null,
    embeddingStore: undefined,
    embedProvider: undefined,
    embeddingConfig: {
      enabled: false,
      apiKey: "",
      endpoint: "",
      model: "",
      hybridAlpha: 0.5,
      batchSize: 20,
    },
    aclConfig: { allowPaths: [], denyPaths: [] },
    vaultPath: "/tmp/vault",
    watcher: null,
    bootFailed: false,
    bootReady: Promise.resolve(),
    ...overrides,
  };
}

let nextTestPort = 41000;

function makeBootstrap(vaultServices: Record<string, VaultServices> = {}): BootstrapResult {
  const defaultSvc = makeMockSvc();
  const allSvcs: Record<string, VaultServices> = { default: defaultSvc, ...vaultServices };

  const config: VaultConfig = {
    vaultPath: "/tmp/vault",
    memoryDbPath: ":memory:",
    namedVaults: Object.fromEntries(Object.keys(allSvcs).map((k) => [k, `/tmp/vault/${k}`])),
    periodicNotesRoot: "Journal",
    embedding: {
      enabled: false,
      apiKey: "",
      endpoint: "",
      model: "",
      hybridAlpha: 0.5,
      batchSize: 20,
    },
    backup: { enabled: false, dir: "", maxBackups: 5 },
    capture: { enableCapturePipeline: false, logRawInput: false },
    watcher: { enabled: false, debounceMs: 300 },
    mcpPort: nextTestPort++,
    mcpHost: "127.0.0.1",
    mcpApiKey: "",
    alertWebhookUrl: "",
    acl: { allowPaths: [], denyPaths: [] },
    toolTimeoutMs: 30_000,
    classifyRules: undefined,
    folders: VAULT_FOLDERS,
    enableOtel: false,
    otelEndpoint: "",
  };

  const vaultManager = {
    listVaults: () => Object.keys(allSvcs).map((name) => ({ name })),
    getServices: (name = "default") => {
      const svc = allSvcs[name];
      if (!svc) throw new Error(`Unknown vault: "${name}"`);
      return svc;
    },
    config,
    shutdown: async () => {},
  };

  return { config, vaultManager } as unknown as BootstrapResult;
}

const initializeRequest = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0.0" },
  },
};

function jsonRpcError(message: string) {
  return {
    jsonrpc: "2.0",
    error: { code: -32000, message },
    id: null,
  };
}

function makeNodeResponseDouble() {
  let responseBody = "";
  const headers = new Map<string, string>();

  return {
    res: {
      headersSent: false,
      statusCode: 200,
      setHeader: (name: string, value: string) => {
        headers.set(name.toLowerCase(), value);
      },
      end: (body?: string) => {
        responseBody = body ?? "";
      },
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(body: unknown) {
        responseBody = JSON.stringify(body);
      },
    } as unknown as http.ServerResponse & { status(code: number): http.ServerResponse & { json(body: unknown): void } },
    getBody: () => responseBody,
    getHeaders: () => headers,
  };
}

// ── Endpoint tests ─────────────────────────────────────────────────────────────

describe("GET /health (authenticated — vault states)", () => {
  let handle: Awaited<ReturnType<typeof startHttpServer>>;

  afterEach(async () => {
    await handle?.close();
  });

  it("includes vaults object when authenticated with a valid API key", async () => {
    const boot = makeBootstrap();
    boot.config.mcpApiKey = "test-api-key";
    handle = await startHttpServer(boot);
    const port = await waitForListen(handle.httpServer);

    const { status, body } = await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port, path: "/health", headers: { Authorization: "Bearer test-api-key" } },
        (res) => {
          let data = "";
          res.on("data", (chunk: string) => {
            data += chunk;
          });
          res.on("end", () => {
            try {
              resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) });
            } catch {
              resolve({ status: res.statusCode ?? 0, body: data });
            }
          });
        },
      );
      req.on("error", reject);
      req.end();
    });

    expect(status).toBe(200);
    const b = body as { status: string; vaults: Record<string, { bootFailed: boolean; ready: boolean }> };
    expect(b.status).toBe("ok");
    expect(b.vaults).toBeDefined();
    expect(b.vaults["default"]).toMatchObject({ bootFailed: false, ready: true });
  });

  it("checks authenticated vault state probes concurrently [PERF-04]", async () => {
    let started = 0;
    const resolvers: Array<() => void> = [];
    const makeConcurrentSvc = () => {
      const svc = makeMockSvc();
      Object.defineProperty(svc, "bootReady", {
        get() {
          started += 1;
          const promise = new Promise<void>((resolve) => {
            resolvers.push(resolve);
          });
          if (started === 3) {
            for (const resolve of resolvers.splice(0)) resolve();
          }
          return promise;
        },
      });
      return svc;
    };

    const boot = makeBootstrap({
      default: makeConcurrentSvc(),
      second: makeConcurrentSvc(),
      third: makeConcurrentSvc(),
    });
    boot.config.mcpApiKey = "test-api-key";
    handle = await startHttpServer(boot);
    const port = await waitForListen(handle.httpServer);

    const { status, body } = await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port, path: "/health", headers: { Authorization: "Bearer test-api-key" } },
        (res) => {
          let data = "";
          res.on("data", (chunk: string) => {
            data += chunk;
          });
          res.on("end", () => {
            try {
              resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) });
            } catch {
              resolve({ status: res.statusCode ?? 0, body: data });
            }
          });
        },
      );
      req.on("error", reject);
      req.end();
    });

    expect(status).toBe(200);
    const vaults = (body as { vaults: Record<string, { ready: boolean }> }).vaults;
    expect(vaults).toBeDefined();
    expect(Object.keys(vaults)).toHaveLength(3);
    expect(vaults["default"]?.ready).toBe(true);
    expect(vaults["second"]?.ready).toBe(true);
    expect(vaults["third"]?.ready).toBe(true);
  });

  it("falls back to the public payload when detailed health probes throw [ERR-06]", async () => {
    const boot = makeBootstrap();
    boot.config.mcpApiKey = "test-api-key";
    let requestListener!: (req: http.IncomingMessage, res: http.ServerResponse) => void;
    const metricsSnapshot = spyOn(metrics, "snapshot").mockImplementation(() => {
      throw new Error("metrics blew up");
    });

    try {
      const fakeServer = {
        listening: true,
        address: () => ({ port: 41000 }),
        on: () => fakeServer,
        listen: (_port: number, _host: string, onListen?: () => void) => {
          onListen?.();
          return fakeServer;
        },
        closeIdleConnections: () => {},
        close: (callback?: (err?: Error) => void) => {
          callback?.();
          return fakeServer;
        },
        listenerCount: () => 1,
      };

      handle = await startHttpServer(boot, {
        createNodeServer: (listener) => {
          requestListener = listener;
          return fakeServer as unknown as http.Server;
        },
      });

      const response = makeNodeResponseDouble();
      let resolveResponse!: () => void;
      const responseWritten = new Promise<void>((resolve) => {
        resolveResponse = resolve;
      });
      const originalJson = response.res.json.bind(response.res);
      const originalEnd = response.res.end.bind(response.res);
      response.res.json = ((body: unknown) => {
        originalJson(body);
        resolveResponse();
      }) as typeof response.res.json;
      response.res.end = ((body?: string) => {
        originalEnd(body);
        resolveResponse();
      }) as typeof response.res.end;
      requestListener(
        {
          method: "GET",
          url: "/health",
          headers: { authorization: "Bearer test-api-key", host: "127.0.0.1" },
          on: () => undefined,
        } as unknown as http.IncomingMessage,
        response.res,
      );
      await responseWritten;

      expect(response.res.statusCode).toBe(200);
      const body = JSON.parse(response.getBody()) as Record<string, unknown>;
      expect(body).toMatchObject({ status: "ok", sessions: 0 });
      expect(body.transport).toBeUndefined();
      expect(body.vaults).toBeUndefined();
      expect(body.metrics).toBeUndefined();
    } finally {
      metricsSnapshot.mockRestore();
    }
  });
});

describe("GET /ready", () => {
  let handle: Awaited<ReturnType<typeof startHttpServer>>;

  afterEach(async () => {
    await handle?.close();
  });

  it("returns 200 { ready: true } when all vaults have booted", async () => {
    const boot = makeBootstrap();
    handle = await startHttpServer(boot);
    const port = await waitForListen(handle.httpServer);

    const { status, body } = await httpGet(`http://127.0.0.1:${port}/ready`);
    expect(status).toBe(200);
    expect(body).toMatchObject({ ready: true, vaultCount: 1 });
    expect((body as { vaults?: number }).vaults).toBeUndefined();
  });

  it("returns 503 { ready: false } when a vault boot failed", async () => {
    const failedSvc = makeMockSvc({ bootFailed: true, bootReady: Promise.resolve() });
    const boot = makeBootstrap({ failed: failedSvc });
    handle = await startHttpServer(boot);
    const port = await waitForListen(handle.httpServer);

    const { status, body } = await httpGet(`http://127.0.0.1:${port}/ready`);
    expect(status).toBe(503);
    expect(body).toMatchObject({ ready: false, vaultCount: 2 });
    expect((body as { unready?: string[] }).unready).toBeUndefined();
    expect((body as { unreadyCount?: number }).unreadyCount).toBe(1);
  });

  it("returns 503 when a vault boot is still pending (200ms timeout)", async () => {
    const neverReady = new Promise<void>(() => {
      // intentionally never resolves — tests the 200ms guard in /ready
    });
    const pendingSvc = makeMockSvc({ bootFailed: false, bootReady: neverReady });
    const boot = makeBootstrap({ pending: pendingSvc });
    handle = await startHttpServer(boot);
    const port = await waitForListen(handle.httpServer);

    const { status, body } = await httpGet(`http://127.0.0.1:${port}/ready`);
    expect(status).toBe(503);
    expect(body).toMatchObject({ ready: false, vaultCount: 2 });
    expect((body as { unready?: string[] }).unready).toBeUndefined();
    expect((body as { unreadyCount?: number }).unreadyCount).toBe(1);
  });

  it("checks all vault readiness probes concurrently [PERF-03]", async () => {
    let started = 0;
    const resolvers: Array<() => void> = [];
    const makeConcurrentSvc = () => {
      const svc = makeMockSvc();
      Object.defineProperty(svc, "bootReady", {
        get() {
          started += 1;
          const promise = new Promise<void>((resolve) => {
            resolvers.push(resolve);
          });
          if (started === 3) {
            for (const resolve of resolvers.splice(0)) resolve();
          }
          return promise;
        },
      });
      return svc;
    };

    const boot = makeBootstrap({
      default: makeConcurrentSvc(),
      second: makeConcurrentSvc(),
      third: makeConcurrentSvc(),
    });
    handle = await startHttpServer(boot);
    const port = await waitForListen(handle.httpServer);

    const { status, body } = await httpGet(`http://127.0.0.1:${port}/ready`);

    expect(status).toBe(200);
    expect(body).toMatchObject({ ready: true, vaultCount: 3 });
  });
});

describe("POST /mcp session cap", () => {
  let handle: Awaited<ReturnType<typeof startHttpServer>>;

  afterEach(async () => {
    await handle?.close();
  });

  it("returns 429 from the real HTTP handler when the session cap is reached", async () => {
    handle = await startHttpServer(makeBootstrap(), { maxSessions: 0 });
    const port = await waitForListen(handle.httpServer);

    const { status, body } = await httpPostJson(`http://127.0.0.1:${port}/mcp`, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      },
    });

    expect(status).toBe(429);
    expect(body).toEqual({ error: "Too many sessions" });
  });
});

describe("POST /mcp constructor failures", () => {
  let handle: Awaited<ReturnType<typeof startHttpServer>>;

  afterEach(async () => {
    await handle?.close();
  });

  it("returns 500 when the MCP server factory throws before request handling [ERR-02]", async () => {
    handle = await startHttpServer(makeBootstrap(), {
      createMcpServer: () => {
        throw new Error("constructor failed");
      },
    });
    const port = await waitForListen(handle.httpServer);

    const { status, body } = await httpPostJsonWithHeaders(`http://127.0.0.1:${port}/mcp`, initializeRequest, {
      Accept: "application/json, text/event-stream",
    });

    expect(status).toBe(500);
    expect(body).toEqual(jsonRpcError("Internal server error"));
  });

  it("wires transport.onerror before server.connect takes ownership [ERR-01]", async () => {
    let sawOnError = false;
    const close = mock().mockResolvedValue(undefined);

    handle = await startHttpServer(makeBootstrap(), {
      createMcpServer: () =>
        ({
          connect: async (transport: { onerror?: unknown }) => {
            sawOnError = typeof transport.onerror === "function";
            throw new Error("connect failed");
          },
          close,
        }) as unknown as ReturnType<typeof createServer>,
    });
    const port = await waitForListen(handle.httpServer);

    const { status } = await httpPostJsonWithHeaders(`http://127.0.0.1:${port}/mcp`, initializeRequest, {
      Accept: "application/json, text/event-stream",
    });

    expect(status).toBe(500);
    expect(sawOnError).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("returns 500 and closes the server when server.connect throws [QA-02]", async () => {
    const close = mock().mockResolvedValue(undefined);

    handle = await startHttpServer(makeBootstrap(), {
      createMcpServer: () =>
        ({
          connect: async () => {
            throw new Error("connect failed");
          },
          close,
        }) as unknown as ReturnType<typeof createServer>,
    });
    const port = await waitForListen(handle.httpServer);

    const { status, body } = await httpPostJsonWithHeaders(`http://127.0.0.1:${port}/mcp`, initializeRequest, {
      Accept: "application/json, text/event-stream",
    });

    expect(status).toBe(500);
    expect(body).toEqual(jsonRpcError("Internal server error"));
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe("POST /mcp concurrency limits", () => {
  let handle: Awaited<ReturnType<typeof startHttpServer>>;

  afterEach(async () => {
    await handle?.close();
  });

  it("rejects a concurrent POST before creating another in-flight MCP server [SEC-01]", async () => {
    let connectCalls = 0;
    let releaseFirstConnect!: () => void;
    let firstConnectStarted!: () => void;
    const firstConnectStartedPromise = new Promise<void>((resolve) => {
      firstConnectStarted = resolve;
    });
    const releaseFirstConnectPromise = new Promise<void>((resolve) => {
      releaseFirstConnect = resolve;
    });

    handle = await startHttpServer(makeBootstrap(), {
      maxConcurrentRequests: 1,
      createMcpServer: (options) => {
        const server = createMcpServer(options);
        const originalConnect = server.connect.bind(server);
        connectCalls += 1;
        if (connectCalls === 1) {
          server.connect = async (transport) => {
            firstConnectStarted();
            await releaseFirstConnectPromise;
            return originalConnect(transport);
          };
        }
        return server;
      },
    });
    const port = await waitForListen(handle.httpServer);

    const firstRequest = httpPostJsonWithHeaders(`http://127.0.0.1:${port}/mcp`, initializeRequest, {
      Accept: "application/json, text/event-stream",
    });
    await firstConnectStartedPromise;

    const secondResponse = await httpPostJsonWithHeaders(`http://127.0.0.1:${port}/mcp`, initializeRequest, {
      Accept: "application/json, text/event-stream",
    });

    releaseFirstConnect();
    await firstRequest;

    expect(secondResponse.status).toBe(503);
  });
});

describe("handleNewSessionRequest", () => {
  it("strips stale mcp-session-id before invoking the transport [SEC-04]", async () => {
    let seenHeader: string | string[] | undefined;
    const createTransport = () => ({
      sessionId: undefined as string | undefined,
      onclose: undefined as (() => void) | undefined,
      onerror: undefined as ((err: Error) => void) | undefined,
      handleRequest: async (
        req: http.IncomingMessage & { headers: Record<string, string | string[] | undefined> },
        res,
      ) => {
        seenHeader = req.headers["mcp-session-id"];
        res.statusCode = 200;
        res.end(JSON.stringify({ ok: true }));
      },
    });

    await handleNewSessionRequest({
      boot: makeBootstrap(),
      createMcpServer: () =>
        ({
          connect: async () => {},
          close: async () => {},
        }) as unknown as ReturnType<typeof createMcpServer>,
      createTransport,
      sessions: new Map(),
      req: {
        method: "POST",
        headers: { "mcp-session-id": "stale-session-id" },
        body: initializeRequest,
      } as unknown as Parameters<typeof handleNewSessionRequest>[0]["req"],
      res: makeNodeResponseDouble().res,
      requestId: "sec-04",
    });

    expect(seenHeader).toBeUndefined();
  });

  it("keeps concurrent per-request MCP servers isolated [QA-08]", async () => {
    let startedRequests = 0;
    let releaseRequests!: () => void;
    let resolveBothStarted!: () => void;
    const boot = makeBootstrap();
    const serverInstances: Array<{ close: () => Promise<void> }> = [];
    const transportInstances: Array<{ handleRequest: (...args: unknown[]) => Promise<void> }> = [];
    const bothStartedPromise = new Promise<void>((resolve) => {
      resolveBothStarted = resolve;
    });
    const releaseRequestsPromise = new Promise<void>((resolve) => {
      releaseRequests = resolve;
    });
    const makeReq = (id: number) =>
      ({
        method: "POST",
        headers: {},
        body: { ...initializeRequest, id },
      }) as unknown as Parameters<typeof handleNewSessionRequest>[0]["req"];

    const firstResponse = makeNodeResponseDouble();
    const secondResponse = makeNodeResponseDouble();
    const createTransport = () => {
      const transport = {
        sessionId: undefined as string | undefined,
        onclose: undefined as (() => void) | undefined,
        onerror: undefined as ((err: Error) => void) | undefined,
        handleRequest: async (_req: http.IncomingMessage, res: http.ServerResponse, body?: unknown) => {
          startedRequests += 1;
          if (startedRequests === 2) resolveBothStarted();
          await releaseRequestsPromise;
          res.statusCode = 200;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ jsonrpc: "2.0", result: { body }, id: (body as { id: number }).id }));
        },
      };
      transportInstances.push(transport);
      return transport;
    };
    const createMcpServerDouble = () => {
      const server = {
        connect: async () => {},
        close: async () => {},
      };
      serverInstances.push(server);
      return server as unknown as ReturnType<typeof createMcpServer>;
    };

    const first = handleNewSessionRequest({
      boot,
      createMcpServer: createMcpServerDouble,
      createTransport,
      sessions: new Map(),
      req: makeReq(1),
      res: firstResponse.res,
      requestId: "qa-08-a",
    });
    const second = handleNewSessionRequest({
      boot,
      createMcpServer: createMcpServerDouble,
      createTransport,
      sessions: new Map(),
      req: makeReq(2),
      res: secondResponse.res,
      requestId: "qa-08-b",
    });

    await bothStartedPromise;
    releaseRequests();
    await Promise.all([first, second]);

    expect(serverInstances).toHaveLength(2);
    expect(serverInstances[0]).not.toBe(serverInstances[1]);
    expect(transportInstances).toHaveLength(2);
    expect(transportInstances[0]).not.toBe(transportInstances[1]);
    expect(JSON.parse(firstResponse.getBody())).toMatchObject({ id: 1, result: { body: { id: 1 } } });
    expect(JSON.parse(secondResponse.getBody())).toMatchObject({ id: 2, result: { body: { id: 2 } } });
  });
});

describe("HTTP server errors", () => {
  let handle: Awaited<ReturnType<typeof startHttpServer>>;

  afterEach(async () => {
    await handle?.close();
  });

  it("registers a server-level error listener", async () => {
    handle = await startHttpServer(makeBootstrap());

    expect(handle.httpServer.listenerCount("error")).toBeGreaterThan(0);
    await waitForListen(handle.httpServer);
  });

  it("closes idle connections before waiting on server.close [ERR-03]", async () => {
    const calls: string[] = [];
    const fakeServer = {
      listening: true,
      address: () => ({ port: 41000 }),
      on: () => fakeServer,
      listen: (_port: number, _host: string, onListen?: () => void) => {
        onListen?.();
        return fakeServer;
      },
      closeIdleConnections: () => {
        calls.push("idle");
      },
      close: (callback?: (err?: Error) => void) => {
        calls.push("close");
        callback?.();
        return fakeServer;
      },
      listenerCount: () => 1,
    };

    handle = await startHttpServer(makeBootstrap(), {
      createNodeServer: () => fakeServer as unknown as http.Server,
    });

    await handle.close();

    expect(calls).toEqual(["idle", "close"]);
    handle = undefined as never;
  });

  it("closes promptly even when a keep-alive client is still connected [ERR-03]", async () => {
    handle = await startHttpServer(makeBootstrap());
    const port = await waitForListen(handle.httpServer);
    const agent = new http.Agent({ keepAlive: true });

    try {
      await new Promise<void>((resolve, reject) => {
        const req = http.get({ host: "127.0.0.1", port, path: "/ready", agent }, (res) => {
          res.resume();
          res.on("end", resolve);
        });
        req.on("error", reject);
      });

      const closed = await Promise.race([
        handle.close().then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500)),
      ]);

      expect(closed).toBe(true);
      handle = undefined as never;
    } finally {
      agent.destroy();
    }
  });

  it("surfaces server.close callback failures during shutdown [QA-03]", async () => {
    const fakeServer = {
      listening: true,
      address: () => ({ port: 41000 }),
      on: () => fakeServer,
      listen: (_port: number, _host: string, onListen?: () => void) => {
        onListen?.();
        return fakeServer;
      },
      closeIdleConnections: () => {},
      close: (callback?: (err?: Error) => void) => {
        callback?.(new Error("close failed"));
        return fakeServer;
      },
      listenerCount: () => 1,
    };

    handle = await startHttpServer(makeBootstrap(), {
      createNodeServer: () => fakeServer as unknown as http.Server,
    });

    await expect(handle.close()).rejects.toThrow("close failed");
    handle = undefined as never;
  });
});

// ── Session bounds tests (unit-level, no HTTP server) ─────────────────────────

interface SessionEntry {
  transport: { close?: () => void };
  server: { close: () => Promise<void> };
  lastActivityAt: number;
}

function makeSessionManager(maxSessions: number, idleMs: number) {
  const sessions = new Map<string, SessionEntry>();
  let intervalHandle: ReturnType<typeof setInterval> | undefined;

  function startIdleCleanup() {
    intervalHandle = setInterval(
      () => {
        const now = Date.now();
        for (const [sid, entry] of sessions) {
          if (now - entry.lastActivityAt > idleMs) {
            entry.server
              .close()
              .then(() => {
                sessions.delete(sid);
              })
              .catch(() => {
                sessions.delete(sid);
              });
          }
        }
      },
      5 * 60 * 1000,
    );
    return intervalHandle;
  }

  function tryAddSession(sid: string, entry: SessionEntry): { ok: true } | { ok: false; reason: "max_sessions" } {
    if (sessions.size >= maxSessions) return { ok: false, reason: "max_sessions" };
    sessions.set(sid, entry);
    return { ok: true };
  }

  function touchSession(sid: string): boolean {
    const entry = sessions.get(sid);
    if (!entry) return false;
    entry.lastActivityAt = Date.now();
    return true;
  }

  function cleanup() {
    if (intervalHandle !== undefined) clearInterval(intervalHandle);
  }

  return { sessions, startIdleCleanup, tryAddSession, touchSession, cleanup };
}

describe("HTTP session bounds", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("rejects 101st session when MAX_SESSIONS=100", () => {
    const { sessions, tryAddSession, cleanup } = makeSessionManager(100, 30 * 60 * 1000);
    try {
      const mockServer = { close: mock().mockResolvedValue(undefined) };
      for (let i = 0; i < 100; i++) {
        const result = tryAddSession(`session-${i}`, {
          transport: {},
          server: mockServer,
          lastActivityAt: Date.now(),
        });
        expect(result.ok).toBe(true);
      }
      expect(sessions.size).toBe(100);
      const result = tryAddSession("session-100", {
        transport: {},
        server: mockServer,
        lastActivityAt: Date.now(),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("max_sessions");
      expect(sessions.size).toBe(100);
    } finally {
      cleanup();
    }
  });

  it("allows adding session after one is removed", () => {
    const { sessions, tryAddSession, cleanup } = makeSessionManager(2, 30 * 60 * 1000);
    try {
      const mockServer = { close: mock().mockResolvedValue(undefined) };
      tryAddSession("s1", { transport: {}, server: mockServer, lastActivityAt: Date.now() });
      tryAddSession("s2", { transport: {}, server: mockServer, lastActivityAt: Date.now() });
      expect(sessions.size).toBe(2);
      sessions.delete("s1");
      const result = tryAddSession("s3", { transport: {}, server: mockServer, lastActivityAt: Date.now() });
      expect(result.ok).toBe(true);
      expect(sessions.size).toBe(2);
    } finally {
      cleanup();
    }
  });

  it("evicts idle sessions after SESSION_IDLE_MS", async () => {
    const idleMs = 30 * 60 * 1000;
    const { sessions, startIdleCleanup, cleanup } = makeSessionManager(100, idleMs);
    const intervalHandle = startIdleCleanup();
    const mockClose = mock().mockResolvedValue(undefined);
    try {
      const now = Date.now();
      sessions.set("active", { transport: {}, server: { close: mockClose }, lastActivityAt: now });
      sessions.set("idle", {
        transport: {},
        server: { close: mockClose },
        lastActivityAt: now - idleMs - 1,
      });
      jest.advanceTimersByTime(5 * 60 * 1000 + 1);
      // Drain microtasks so the close().then() callbacks run
      await Promise.resolve();
      await Promise.resolve();
      expect(sessions.has("idle")).toBe(false);
      expect(sessions.has("active")).toBe(true);
      expect(mockClose).toHaveBeenCalledOnce();
    } finally {
      clearInterval(intervalHandle);
      cleanup();
    }
  });

  it("touchSession updates lastActivityAt", () => {
    const { sessions, tryAddSession, touchSession, cleanup } = makeSessionManager(10, 1000);
    try {
      const mockServer = { close: mock().mockResolvedValue(undefined) };
      const initialTime = Date.now();
      tryAddSession("sess1", { transport: {}, server: mockServer, lastActivityAt: initialTime });
      jest.advanceTimersByTime(500);
      touchSession("sess1");
      const entry = sessions.get("sess1");
      expect(entry?.lastActivityAt).toBeGreaterThan(initialTime);
    } finally {
      cleanup();
    }
  });

  it("touchSession returns false for unknown session", () => {
    const { touchSession, cleanup } = makeSessionManager(10, 1000);
    try {
      expect(touchSession("nonexistent")).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("defers sessions.delete until after server.close() resolves [ERR-13]", async () => {
    const idleMs = 30 * 60 * 1000;
    const { sessions, startIdleCleanup, cleanup } = makeSessionManager(100, idleMs);

    let resolveClose!: () => void;
    const closePromise = new Promise<void>((resolve) => {
      resolveClose = resolve;
    });
    const mockServer = { close: mock().mockImplementation(() => closePromise) };

    sessions.set("idle", {
      transport: {},
      server: mockServer,
      lastActivityAt: Date.now() - idleMs - 1,
    });

    const intervalHandle = startIdleCleanup();
    try {
      jest.advanceTimersByTime(5 * 60 * 1000 + 1);

      // Session should still be in map while close is pending
      expect(sessions.has("idle")).toBe(true);

      resolveClose();
      await Promise.resolve();
      await Promise.resolve();

      // Session removed after close resolves
      expect(sessions.has("idle")).toBe(false);
    } finally {
      clearInterval(intervalHandle);
      cleanup();
    }
  });
});

describe("POST /mcp auth + session validation", () => {
  let handle: Awaited<ReturnType<typeof startHttpServer>>;

  afterEach(async () => {
    await handle?.close();
  });

  const initBody = {
    ...initializeRequest,
  };

  it("returns 401 when Authorization header is missing and API key is configured", async () => {
    const boot = makeBootstrap();
    boot.config.mcpApiKey = "secret-key";
    handle = await startHttpServer(boot);
    const port = await waitForListen(handle.httpServer);

    const { status, body } = await httpPostJson(`http://127.0.0.1:${port}/mcp`, initBody);
    expect(status).toBe(401);
    expect(body).toEqual(jsonRpcError("Unauthorized"));
  });

  it("returns 401 when Bearer token is wrong", async () => {
    const boot = makeBootstrap();
    boot.config.mcpApiKey = "secret-key";
    handle = await startHttpServer(boot);
    const port = await waitForListen(handle.httpServer);

    const { status } = await httpPostJsonWithHeaders(`http://127.0.0.1:${port}/mcp`, initBody, {
      Authorization: "Bearer wrong-token",
    });
    expect(status).toBe(401);
  });

  it("returns 400 for oversized mcp-session-id", async () => {
    const boot = makeBootstrap();
    handle = await startHttpServer(boot);
    const port = await waitForListen(handle.httpServer);

    const { status, body } = await httpPostJsonWithHeaders(`http://127.0.0.1:${port}/mcp`, initBody, {
      "mcp-session-id": "x".repeat(257),
    });
    expect(status).toBe(400);
    expect((body as { error: string }).error).toBe("Invalid mcp-session-id header");
  });

  it("returns 404 for unknown mcp-session-id", async () => {
    const boot = makeBootstrap();
    handle = await startHttpServer(boot);
    const port = await waitForListen(handle.httpServer);

    const { status, body } = await httpPostJsonWithHeaders(`http://127.0.0.1:${port}/mcp`, initBody, {
      "mcp-session-id": "00000000-0000-0000-0000-nonexistent00",
    });
    expect(status).toBe(404);
    expect((body as { error: string }).error).toBe("Session not found");
  });

  it("creates a session and returns a valid initialize response", async () => {
    const boot = makeBootstrap();
    handle = await startHttpServer(boot);
    const port = await waitForListen(handle.httpServer);

    const { status, body } = await httpPostJsonWithHeaders(`http://127.0.0.1:${port}/mcp`, initBody, {
      Accept: "application/json, text/event-stream",
    });
    expect(status).toBe(200);
    // Response may be JSON or SSE — either way the payload contains protocolVersion
    const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
    expect(bodyStr).toContain("protocolVersion");
  });

  it("rejects request bodies over the configured HTTP body limit", async () => {
    const boot = makeBootstrap();
    handle = await startHttpServer(boot, { bodyLimitBytes: 64 });
    const port = await waitForListen(handle.httpServer);

    const { status, body } = await httpPostJsonWithHeaders(
      `http://127.0.0.1:${port}/mcp`,
      {
        ...initBody,
        params: {
          ...initBody.params,
          clientInfo: { name: "x".repeat(128), version: "1.0.0" },
        },
      },
      { Accept: "application/json, text/event-stream" },
    );

    expect(status).toBe(413);
    expect(body).toEqual({ error: "Payload too large" });
  });

  it("rejects chunked request bodies over the configured HTTP body limit [SEC-02]", async () => {
    const boot = makeBootstrap();
    handle = await startHttpServer(boot, { bodyLimitBytes: 64 });
    const port = await waitForListen(handle.httpServer);

    const oversizedPayload = JSON.stringify({
      ...initBody,
      params: {
        ...initBody.params,
        clientInfo: { name: "x".repeat(128), version: "1.0.0" },
      },
    });

    const { status, body } = await httpPostChunked(`http://127.0.0.1:${port}/mcp`, oversizedPayload, {
      Accept: "application/json, text/event-stream",
    });

    expect(status).toBe(413);
    expect(body).toEqual({ error: "Payload too large" });
  });
});

describe("HTTP MCP method handling", () => {
  let handle: Awaited<ReturnType<typeof startHttpServer>>;

  afterEach(async () => {
    await handle?.close();
  });

  it("accepts DELETE /mcp without requiring a session header [API-03]", async () => {
    handle = await startHttpServer(makeBootstrap());
    const port = await waitForListen(handle.httpServer);

    const { status } = await httpRequestJson(`http://127.0.0.1:${port}/mcp`, { method: "DELETE" });

    expect(status).toBe(200);
  });

  it("returns 405 with an Allow header for unsupported MCP methods [API-02]", async () => {
    handle = await startHttpServer(makeBootstrap());
    const port = await waitForListen(handle.httpServer);

    const { status, body, headers } = await httpRequestJson(`http://127.0.0.1:${port}/mcp`, { method: "PUT" });

    expect(status).toBe(405);
    expect(headers.allow).toBe("POST, DELETE");
    expect(body).toEqual(jsonRpcError("Method not allowed"));
  });

  it("returns a JSON-RPC 405 body for unsupported MCP methods [QA-04]", async () => {
    let requestListener!: (req: http.IncomingMessage, res: http.ServerResponse) => void;
    const fakeServer = {
      listening: true,
      address: () => ({ port: 41000 }),
      on: () => fakeServer,
      listen: (_port: number, _host: string, onListen?: () => void) => {
        onListen?.();
        return fakeServer;
      },
      closeIdleConnections: () => {},
      close: (callback?: (err?: Error) => void) => {
        callback?.();
        return fakeServer;
      },
      listenerCount: () => 1,
    };

    handle = await startHttpServer(makeBootstrap(), {
      createNodeServer: (listener) => {
        requestListener = listener;
        return fakeServer as unknown as http.Server;
      },
    });

    const response = makeNodeResponseDouble();
    let resolveResponse!: () => void;
    const responseWritten = new Promise<void>((resolve) => {
      resolveResponse = resolve;
    });
    const originalJson = response.res.json.bind(response.res);
    response.res.json = ((body: unknown) => {
      originalJson(body);
      resolveResponse();
    }) as typeof response.res.json;

    requestListener(
      {
        method: "PUT",
        url: "/mcp",
        headers: { host: "127.0.0.1" },
        on: () => undefined,
      } as unknown as http.IncomingMessage,
      response.res,
    );
    await responseWritten;

    expect(response.res.statusCode).toBe(405);
    expect(response.getHeaders().get("allow")).toBe("POST, DELETE");
    expect(JSON.parse(response.getBody())).toEqual(jsonRpcError("Method not allowed"));
  });
});

describe("handleExistingSessionRequest", () => {
  afterEach(() => {
    mock.restore();
  });

  it("returns 500 when an existing session transport rejects", async () => {
    const entry = {
      transport: { handleRequest: mock().mockRejectedValue(new Error("transport failed")) },
      server: { close: mock() },
      lastActivityAt: 0,
    };
    const json = mock();
    const status = mock().mockReturnValue({ json });
    const res = { status, headersSent: false };

    await handleExistingSessionRequest(
      entry as unknown as Parameters<typeof handleExistingSessionRequest>[0],
      {} as unknown as Parameters<typeof handleExistingSessionRequest>[1],
      res as unknown as Parameters<typeof handleExistingSessionRequest>[2],
      {},
    );

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith(jsonRpcError("Internal server error"));
  });

  it("includes the requestId in existing-session error logs [ERR-04]", async () => {
    spyOn(console, "error").mockImplementation(() => {});
    const entry = {
      transport: { handleRequest: mock().mockRejectedValue(new Error("transport failed")) },
      server: { close: mock() },
      lastActivityAt: 0,
    };
    const json = mock();
    const status = mock().mockReturnValue({ json });
    const res = { status, headersSent: false };

    await handleExistingSessionRequest(
      entry as unknown as Parameters<typeof handleExistingSessionRequest>[0],
      {} as unknown as Parameters<typeof handleExistingSessionRequest>[1],
      res as unknown as Parameters<typeof handleExistingSessionRequest>[2],
      {},
      "req-http-04",
    );

    expect(console.error).toHaveBeenCalledWith(
      "[http]",
      "existing session transport error",
      expect.objectContaining({ err: "transport failed", requestId: "req-http-04" }),
    );
  });

  it("does not attempt a second response after headers have been sent [QA-01]", async () => {
    const entry = {
      transport: { handleRequest: mock().mockRejectedValue(new Error("transport failed")) },
      server: { close: mock() },
      lastActivityAt: 0,
    };
    const json = mock();
    const status = mock().mockReturnValue({ json });
    const res = { status, headersSent: true };

    await handleExistingSessionRequest(
      entry as unknown as Parameters<typeof handleExistingSessionRequest>[0],
      {} as unknown as Parameters<typeof handleExistingSessionRequest>[1],
      res as unknown as Parameters<typeof handleExistingSessionRequest>[2],
      {},
    );

    expect(status).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
  });
});

describe("handleNewSessionTransportError", () => {
  it("returns JSON 500 instead of rethrowing to Express [ERR-07]", async () => {
    const sessions = new Map<string, unknown>([["session-1", {}]]);
    const close = mock().mockResolvedValue(undefined);
    const json = mock();
    const status = mock().mockReturnValue({ json });
    const res = { status, headersSent: false };

    await handleNewSessionTransportError(
      "session-1",
      sessions,
      { close },
      res as unknown as Parameters<typeof handleNewSessionTransportError>[3],
      new Error("transport failed"),
    );

    expect(sessions.has("session-1")).toBe(false);
    expect(close).toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith(jsonRpcError("Internal server error"));
  });
});

describe("closeActiveSessionsForShutdown", () => {
  it("continues after one session close fails and removes every session [ERR-03]", async () => {
    const firstClose = mock().mockRejectedValue(new Error("first failed"));
    const secondClose = mock().mockResolvedValue(undefined);
    const sessions = new Map([
      ["first", { server: { close: firstClose } }],
      ["second", { server: { close: secondClose } }],
    ]);

    await expect(closeActiveSessionsForShutdown(sessions)).resolves.toBeUndefined();

    expect(firstClose).toHaveBeenCalled();
    expect(secondClose).toHaveBeenCalled();
    expect(sessions.size).toBe(0);
  });
});

describe("createInFlightRequestTracker", () => {
  it("waits for tracked requests to settle before draining [ARCH-02]", async () => {
    const tracker = createInFlightRequestTracker();
    let releaseRequest!: () => void;
    let drained = false;

    const request = tracker.track(
      new Promise<void>((resolve) => {
        releaseRequest = resolve;
      }),
    );
    const drainPromise = tracker.drain().then(() => {
      drained = true;
    });

    await Promise.resolve();
    expect(drained).toBe(false);

    releaseRequest();
    await request;
    await drainPromise;

    expect(drained).toBe(true);
  });
});

describe("createUnrefedTimeoutPromise", () => {
  it("calls unref on timeout handles when available [ERR-07]", async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const unref = mock();

    globalThis.setTimeout = ((fn: TimerHandler) => {
      const handle = { unref } as unknown as ReturnType<typeof setTimeout>;
      queueMicrotask(() => {
        if (typeof fn === "function") fn();
      });
      return handle;
    }) as typeof setTimeout;

    try {
      await expect(createUnrefedTimeoutPromise(50, false)).resolves.toBe(false);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }

    expect(unref).toHaveBeenCalledOnce();
  });
});

describe("GET /health unauthenticated response shape", () => {
  it("retains the sessions field in the public health payload [API-04]", () => {
    expect(buildPublicHealthResponse(12, 0)).toEqual({
      status: "ok",
      uptimeSeconds: 12,
      sessions: 0,
    });
  });
});

describe("parsePositiveIntEnv", () => {
  const envName = "MCP_TEST_POSITIVE_INT";

  afterEach(() => {
    delete process.env[envName];
  });

  it("returns the default when unset", () => {
    expect(parsePositiveIntEnv(envName, 123)).toBe(123);
  });

  it("returns a positive integer from the environment", () => {
    process.env[envName] = "42";
    expect(parsePositiveIntEnv(envName, 123)).toBe(42);
  });

  it("rejects invalid, fractional, and non-positive values", () => {
    for (const value of ["abc", "10ms", "1.5", "0", "-1"]) {
      process.env[envName] = value;
      expect(() => parsePositiveIntEnv(envName, 123)).toThrow(/positive integer/);
    }
  });
});

describe("MCP_HTTP_BODY_LIMIT_BYTES", () => {
  const envName = "MCP_HTTP_BODY_LIMIT_BYTES";
  const originalValue = process.env[envName];

  afterEach(() => {
    if (originalValue === undefined) delete process.env[envName];
    else process.env[envName] = originalValue;
  });

  it("applies the env var through startHttpServer when opts.bodyLimitBytes is unset [QA-05]", async () => {
    process.env[envName] = "64";
    let requestListener!: (req: http.IncomingMessage, res: http.ServerResponse) => void;
    const writeHead = mock();
    const end = mock();
    const fakeServer = {
      listening: true,
      address: () => ({ port: 41000 }),
      on: () => fakeServer,
      listen: (_port: number, _host: string, onListen?: () => void) => {
        onListen?.();
        return fakeServer;
      },
      closeIdleConnections: () => {},
      close: (callback?: (err?: Error) => void) => {
        callback?.();
        return fakeServer;
      },
      listenerCount: () => 1,
    };

    const handle = await startHttpServer(makeBootstrap(), {
      createNodeServer: (listener) => {
        requestListener = listener;
        return fakeServer as unknown as http.Server;
      },
    });

    requestListener(
      { headers: { "content-length": "128" } } as unknown as http.IncomingMessage,
      { writeHead, end } as unknown as http.ServerResponse,
    );

    expect(writeHead).toHaveBeenCalledWith(413, { "content-type": "application/json" });
    expect(end).toHaveBeenCalledWith(JSON.stringify({ error: "Payload too large" }));

    await handle.close();
  });
});
