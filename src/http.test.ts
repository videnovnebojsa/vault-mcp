/**
 * Tests for src/http.ts — integration tests for the HTTP endpoints in
 * stateless transport mode (no sessions). See docs/adr/0003-stateless-http-sessions.md.
 */

import { afterEach, describe, expect, it } from "bun:test";
import http from "node:http";
import net from "node:net";
import type { BootstrapResult } from "./bootstrap.js";
import { VAULT_FOLDERS } from "./config/folders.js";
import type { VaultConfig } from "./config.js";
import { parsePositiveIntEnv, startHttpServer } from "./http.js";
import type { VaultServices } from "./vault/manager.js";

// ── HTTP helpers ───────────────────────────────────────────────────────────────

function httpGet(url: string): Promise<{ status: number; body: unknown }> {
  return httpGetWithHeaders(url).then(({ status, body }) => ({ status, body }));
}

function httpGetWithHeaders(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, { headers }, (res) => {
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
      })
      .on("error", reject);
  });
}

function httpRequestMethod(
  method: string,
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
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
    });
    req.on("error", reject);
    req.end();
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

function httpPostJsonFull(
  url: string,
  body: unknown,
  headers: Record<string, string | number> = {},
): Promise<{ status: number; body: unknown; headers: http.IncomingHttpHeaders }> {
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
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(data), headers: res.headers });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: data, headers: res.headers });
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
    mcpPort: 0,
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
});

describe("POST /mcp (stateless transport)", () => {
  let handle: Awaited<ReturnType<typeof startHttpServer>>;

  const initBody = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0.0" },
    },
  };

  afterEach(async () => {
    await handle?.close();
  });

  it("handles initialize without issuing an mcp-session-id header", async () => {
    handle = await startHttpServer(makeBootstrap());
    const port = await waitForListen(handle.httpServer);

    const { status, body, headers } = await httpPostJsonFull(`http://127.0.0.1:${port}/mcp`, initBody, {
      Accept: "application/json, text/event-stream",
    });

    expect(status).toBe(200);
    const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
    expect(bodyStr).toContain("protocolVersion");
    // Stateless: the server must never hand back a session id.
    expect(headers["mcp-session-id"]).toBeUndefined();
  });

  it("accepts a request carrying a stale mcp-session-id (no 404) [the reported bug]", async () => {
    // Reproduces the incident: a client reconnects with a session id the server no longer knows.
    // In stateless mode there is no session to miss, so this must succeed instead of 404'ing.
    handle = await startHttpServer(makeBootstrap());
    const port = await waitForListen(handle.httpServer);

    const { status, body } = await httpPostJsonFull(`http://127.0.0.1:${port}/mcp`, initBody, {
      Accept: "application/json, text/event-stream",
      "mcp-session-id": "00000000-0000-0000-0000-stale00000000",
    });

    expect(status).toBe(200);
    const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
    expect(bodyStr).toContain("protocolVersion");
  });

  it("serves independent POSTs — each request stands alone with no shared session", async () => {
    handle = await startHttpServer(makeBootstrap());
    const port = await waitForListen(handle.httpServer);

    const first = await httpPostJsonFull(`http://127.0.0.1:${port}/mcp`, initBody, {
      Accept: "application/json, text/event-stream",
    });
    const second = await httpPostJsonFull(`http://127.0.0.1:${port}/mcp`, initBody, {
      Accept: "application/json, text/event-stream",
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });

  it("reuses a single pooled McpServer across sequential POSTs against the real SDK [PERF-01]", async () => {
    // Cap the pool at one server so the second POST can only succeed if that single
    // McpServer was torn down (server.close()) and then successfully re-connect()ed to a
    // fresh transport — i.e. real-SDK reuse-after-close works (mock-injected pool tests
    // can't prove this against SDK 1.29.0). Until the first request's async teardown
    // releases the pooled server, the cap returns 429, so poll until it frees up; a broken
    // reuse path would surface as a 500 here, failing the 200 assertion.
    handle = await startHttpServer(makeBootstrap(), { maxConcurrentRequests: 1 });
    const port = await waitForListen(handle.httpServer);

    const first = await httpPostJsonFull(`http://127.0.0.1:${port}/mcp`, initBody, {
      Accept: "application/json, text/event-stream",
    });
    expect(first.status).toBe(200);

    let second: Awaited<ReturnType<typeof httpPostJsonFull>> | undefined;
    for (let attempt = 0; attempt < 50; attempt++) {
      second = await httpPostJsonFull(`http://127.0.0.1:${port}/mcp`, initBody, {
        Accept: "application/json, text/event-stream",
      });
      if (second.status !== 429) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(second?.status).toBe(200);
    const bodyStr = typeof second?.body === "string" ? second.body : JSON.stringify(second?.body);
    expect(bodyStr).toContain("protocolVersion");
  });
});

describe("GET /mcp (standalone SSE stream declined)", () => {
  let handle: Awaited<ReturnType<typeof startHttpServer>>;

  afterEach(async () => {
    await handle?.close();
  });

  it("returns 405 with an Allow header — server offers no GET SSE stream", async () => {
    handle = await startHttpServer(makeBootstrap());
    const port = await waitForListen(handle.httpServer);

    const { status, body, headers } = await httpGetWithHeaders(`http://127.0.0.1:${port}/mcp`);
    expect(status).toBe(405);
    expect(headers["allow"]).toBe("POST, DELETE");
    expect((body as { error: string }).error).toMatch(/does not offer a GET SSE stream/);
  });

  it("returns 405 (with Allow header + body) even when a mcp-session-id header is present [QA-04]", async () => {
    handle = await startHttpServer(makeBootstrap());
    const port = await waitForListen(handle.httpServer);

    const { status, body, headers } = await httpGetWithHeaders(`http://127.0.0.1:${port}/mcp`, {
      "mcp-session-id": "00000000-0000-0000-0000-000000000000",
    });
    expect(status).toBe(405);
    expect(headers["allow"]).toBe("POST, DELETE");
    expect((body as { error: string }).error).toMatch(/does not offer a GET SSE stream/);
  });

  it("enforces the API key before the 405 guard (GET without auth → 401)", async () => {
    const boot = makeBootstrap();
    boot.config.mcpApiKey = "secret-key";
    handle = await startHttpServer(boot);
    const port = await waitForListen(handle.httpServer);

    const { status, body } = await httpGetWithHeaders(`http://127.0.0.1:${port}/mcp`);
    expect(status).toBe(401);
    expect((body as { error: string }).error).toBe("Unauthorized");
  });

  it("still returns 405 for an authenticated GET — auth passes, then the guard fires [QA-01]", async () => {
    const boot = makeBootstrap();
    boot.config.mcpApiKey = "secret-key";
    handle = await startHttpServer(boot);
    const port = await waitForListen(handle.httpServer);

    const { status, body, headers } = await httpGetWithHeaders(`http://127.0.0.1:${port}/mcp`, {
      Authorization: "Bearer secret-key",
    });
    expect(status).toBe(405);
    expect(headers["allow"]).toBe("POST, DELETE");
    expect((body as { error: string }).error).toMatch(/does not offer a GET SSE stream/);
  });

  it("records a metric for the 405 rejection, observable via /health [ERR-01]", async () => {
    const boot = makeBootstrap();
    boot.config.mcpApiKey = "secret-key";
    handle = await startHttpServer(boot);
    const port = await waitForListen(handle.httpServer);

    // Trigger the rejection
    const rejected = await httpGetWithHeaders(`http://127.0.0.1:${port}/mcp`, {
      Authorization: "Bearer secret-key",
    });
    expect(rejected.status).toBe(405);

    // The rejection must be observable in the authenticated /health metrics snapshot
    const { body } = await httpGetWithHeaders(`http://127.0.0.1:${port}/health`, {
      Authorization: "Bearer secret-key",
    });
    const metrics = (body as { metrics: Record<string, { count: number }> }).metrics;
    expect(metrics["http_mcp_method_not_allowed"]?.count).toBeGreaterThanOrEqual(1);
  });
});

describe("/mcp unsupported methods (PUT/PATCH → 405)", () => {
  let handle: Awaited<ReturnType<typeof startHttpServer>>;

  afterEach(async () => {
    await handle?.close();
  });

  it.each(["PUT", "PATCH"])("returns 405 with an Allow header for %s [API-04]", async (method) => {
    handle = await startHttpServer(makeBootstrap());
    const port = await waitForListen(handle.httpServer);

    const { status, body, headers } = await httpRequestMethod(method, `http://127.0.0.1:${port}/mcp`);
    expect(status).toBe(405);
    expect(headers["allow"]).toBe("POST, DELETE");
    expect((body as { error: string }).error).toBe("Method Not Allowed");
  });
});

describe("DELETE /mcp (advertised in Allow)", () => {
  let handle: Awaited<ReturnType<typeof startHttpServer>>;

  afterEach(async () => {
    await handle?.close();
  });

  it("returns 200 no-op — stateless mode has no session to tear down [QA-02]", async () => {
    handle = await startHttpServer(makeBootstrap());
    const port = await waitForListen(handle.httpServer);

    const { status, body } = await httpRequestMethod("DELETE", `http://127.0.0.1:${port}/mcp`, {
      "mcp-session-id": "00000000-0000-0000-0000-000000000000",
    });
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true });
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
});

describe("POST /mcp auth + body limits", () => {
  let handle: Awaited<ReturnType<typeof startHttpServer>>;

  afterEach(async () => {
    await handle?.close();
  });

  const initBody = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0.0" },
    },
  };

  it("returns 401 when Authorization header is missing and API key is configured", async () => {
    const boot = makeBootstrap();
    boot.config.mcpApiKey = "secret-key";
    handle = await startHttpServer(boot);
    const port = await waitForListen(handle.httpServer);

    const { status, body } = await httpPostJson(`http://127.0.0.1:${port}/mcp`, initBody);
    expect(status).toBe(401);
    expect((body as { error: string }).error).toBe("Unauthorized");
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

describe("GET /health unauthenticated response shape", () => {
  let handle: Awaited<ReturnType<typeof startHttpServer>>;

  afterEach(async () => {
    await handle?.close();
  });

  it("returns stripped response (no vaults/circuits/sessions) when API key is set and token is missing", async () => {
    const boot = makeBootstrap();
    boot.config.mcpApiKey = "secret";
    handle = await startHttpServer(boot);
    const port = await waitForListen(handle.httpServer);

    const { status, body } = await httpGet(`http://127.0.0.1:${port}/health`);
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b["status"]).toBe("ok");
    expect(b["vaults"]).toBeUndefined();
    expect(b["circuits"]).toBeUndefined();
    expect(b["sessions"]).toBeUndefined();
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
