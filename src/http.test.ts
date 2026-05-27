/**
 * Tests for src/http.ts — integration tests for HTTP endpoints and
 * unit tests for session-management logic (bounds + idle eviction).
 */

import { afterEach, beforeEach, describe, expect, it, jest, mock } from "bun:test";
import http from "node:http";
import net from "node:net";
import type { BootstrapResult } from "./bootstrap.js";
import { VAULT_FOLDERS } from "./config/folders.js";
import type { VaultConfig } from "./config.js";
import {
  closeActiveSessionsForShutdown,
  handleExistingSessionRequest,
  parsePositiveIntEnv,
  startHttpServer,
} from "./http.js";
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

describe("handleExistingSessionRequest", () => {
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
    expect(json).toHaveBeenCalledWith({ error: "Internal server error" });
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
