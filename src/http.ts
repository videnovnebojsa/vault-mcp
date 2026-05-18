import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer as createHttpServer } from "node:http";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { BootstrapResult } from "./bootstrap.js";
import { createServer } from "./mcp/server.js";
import { getAllCircuits } from "./utils/circuits.js";
import { logger } from "./utils/logger.js";
import { metrics } from "./utils/metrics.js";
import { isValidToken } from "./utils/token.js";

const httpLogger = logger.child("http");

const MAX_SESSION_ID_LENGTH = 256;
const DEFAULT_HTTP_BODY_LIMIT_BYTES = 1024 * 1024;

function firstHeader(h: string | string[] | undefined): string | undefined {
  return Array.isArray(h) ? h[0] : h;
}

export function parsePositiveIntEnv(name: string, defaultValue: number): number {
  const raw = process.env[name] ?? String(defaultValue);
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || String(parsed) !== raw.trim()) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

const MAX_SESSIONS = parsePositiveIntEnv("MCP_MAX_SESSIONS", 100);
const SESSION_IDLE_MS = parsePositiveIntEnv("MCP_SESSION_IDLE_MS", 30 * 60 * 1000);

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastActivityAt: number;
}

export type ShutdownSessionEntry = Pick<SessionEntry, "server">;

export interface HttpServerHandle {
  httpServer: Server;
  close(): Promise<void>;
}

export interface HttpServerOptions {
  maxSessions?: number;
  sessionIdleMs?: number;
  bodyLimitBytes?: number;
}

export async function handleExistingSessionRequest(
  entry: SessionEntry,
  req: IncomingMessage,
  res: ServerResponse & { status(code: number): ServerResponse & { json(body: unknown): void } },
  body: unknown,
): Promise<void> {
  entry.lastActivityAt = Date.now();
  try {
    await entry.transport.handleRequest(req, res, body);
  } catch (err) {
    httpLogger.error("existing session transport error", {
      err: err instanceof Error ? err.message : String(err),
    });
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
}

export async function closeActiveSessionsForShutdown(sessions: Map<string, ShutdownSessionEntry>): Promise<void> {
  for (const [sid, entry] of sessions) {
    try {
      await entry.server.close();
    } catch (err) {
      httpLogger.warn("session close failed during shutdown", {
        sid: sid.slice(0, 8),
        err: err instanceof Error ? err.message : String(err),
      });
    } finally {
      sessions.delete(sid);
    }
  }
}

export async function startHttpServer(boot: BootstrapResult, opts: HttpServerOptions = {}): Promise<HttpServerHandle> {
  const { config } = boot;
  const sessions = new Map<string, SessionEntry>();
  const maxSessions = opts.maxSessions ?? MAX_SESSIONS;
  const sessionIdleMs = opts.sessionIdleMs ?? SESSION_IDLE_MS;
  const bodyLimitBytes =
    opts.bodyLimitBytes ?? parsePositiveIntEnv("MCP_HTTP_BODY_LIMIT_BYTES", DEFAULT_HTTP_BODY_LIMIT_BYTES);

  // Periodic idle session cleanup — every 5 minutes
  const idleCleanupInterval = setInterval(
    () => {
      const now = Date.now();
      for (const [sid, entry] of sessions) {
        if (now - entry.lastActivityAt > sessionIdleMs) {
          entry.server
            .close()
            .then(() => {
              sessions.delete(sid);
              httpLogger.info("session evicted (idle)", { sid: sid.slice(0, 8) });
            })
            .catch((err: unknown) => {
              sessions.delete(sid);
              httpLogger.warn("session close failed during idle eviction", {
                sid: sid.slice(0, 8),
                err: err instanceof Error ? err.message : String(err),
              });
            });
        }
      }
    },
    5 * 60 * 1000,
  ).unref();

  const app = createMcpExpressApp({ host: config.mcpHost });

  const startedAt = Date.now();
  // GET /health — returns {status,uptimeSeconds} to all callers.
  // When MCP_API_KEY is set, an authenticated request (Authorization: Bearer <key>)
  // additionally returns circuit-breaker state, session count, and metrics.
  app.get(
    "/health",
    async (
      req: IncomingMessage & { headers: Record<string, string | string[] | undefined> },
      res: ServerResponse & { json(body: unknown): void },
    ) => {
      const uptimeSeconds = Math.floor((Date.now() - startedAt) / 1000);
      // When an API key is configured, require it for detailed health data to avoid
      // leaking circuit names, session counts, and metrics to unauthenticated callers.
      if (config.mcpApiKey) {
        const auth = firstHeader(req.headers.authorization);
        const token = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
        if (!isValidToken(token, config.mcpApiKey)) {
          res.json({ status: "ok", uptimeSeconds });
          return;
        }
      }
      const circuits: Record<string, unknown> = {};
      for (const [name, cb] of getAllCircuits()) {
        circuits[name] = cb.snapshot();
      }
      // Surface vault boot states for authenticated callers
      const vaultStates: Record<string, { bootFailed: boolean; ready: boolean }> = {};
      for (const { name } of boot.vaultManager.listVaults()) {
        try {
          const svc = boot.vaultManager.getServices(name);
          const ready = await Promise.race([
            svc.bootReady.then(() => !svc.bootFailed).catch(() => false),
            new Promise<boolean>((r) => setTimeout(() => r(false), 50)),
          ]);
          vaultStates[name] = { bootFailed: svc.bootFailed, ready };
        } catch {
          vaultStates[name] = { bootFailed: true, ready: false };
        }
      }
      res.json({
        status: "ok",
        transport: "http",
        sessions: sessions.size,
        uptimeSeconds,
        vaults: vaultStates,
        circuits,
        metrics: metrics.snapshot(),
      });
    },
  );

  app.get(
    "/ready",
    async (
      _req: IncomingMessage,
      res: ServerResponse & {
        status(code: number): ServerResponse & { json(body: unknown): void };
        json(body: unknown): void;
      },
    ) => {
      const vaults = boot.vaultManager.listVaults();
      const unready: string[] = [];

      for (const { name } of vaults) {
        try {
          const svc = boot.vaultManager.getServices(name);
          if (svc.bootFailed) {
            unready.push(name);
            continue;
          }
          // Check with a short timeout so the probe is always bounded
          const isReady = await Promise.race([
            svc.bootReady.then(() => true).catch(() => false),
            new Promise<boolean>((r) => setTimeout(() => r(false), 200)),
          ]);
          if (!isReady) unready.push(name);
        } catch {
          unready.push(name);
        }
      }

      if (unready.length > 0) {
        res.status(503).json({ ready: false, vaultCount: vaults.length, unreadyCount: unready.length });
        return;
      }
      res.json({ ready: true, vaultCount: vaults.length });
    },
  );

  app.all(
    "/mcp",
    async (
      req: IncomingMessage & {
        method?: string;
        headers: Record<string, string | string[] | undefined>;
        body?: unknown;
      },
      res: ServerResponse & { status(code: number): ServerResponse & { json(body: unknown): void } },
    ) => {
      if (config.mcpApiKey) {
        const auth = firstHeader(req.headers.authorization);
        const token = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
        if (!isValidToken(token, config.mcpApiKey)) {
          res.status(401).json({ error: "Unauthorized" });
          return;
        }
      }

      const sessionId = firstHeader(req.headers["mcp-session-id"]);

      if (req.method === "POST" && !sessionId) {
        // Enforce session limit before creating a new session
        if (sessions.size >= maxSessions) {
          res.status(429).json({
            error: "Too many sessions",
          });
          return;
        }

        // Create server FIRST so it's guaranteed to be defined when onsessioninitialized fires
        const server = createServer({
          vaultManager: boot.vaultManager,
          mcpHost: config.mcpHost,
          mcpPort: config.mcpPort,
        });

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid: string) => {
            sessions.set(sid, { transport, server, lastActivityAt: Date.now() });
            transport.onclose = () => {
              sessions.delete(sid);
              httpLogger.info("session closed", { sid: sid.slice(0, 8), remaining: sessions.size });
            };
            httpLogger.info("session created", { sid: sid.slice(0, 8), active: sessions.size });
          },
        });

        try {
          // @ts-expect-error -- MCP SDK StreamableHTTPServerTransport uses T|undefined for onclose, incompatible with exactOptionalPropertyTypes
          await server.connect(transport);
          await transport.handleRequest(req, res, req.body);

          if (!transport.sessionId) {
            await server.close();
          }
        } catch (err) {
          if (transport.sessionId) sessions.delete(transport.sessionId);
          await server.close().catch((closeErr: unknown) => {
            httpLogger.warn("session close failed after transport error", {
              err: closeErr instanceof Error ? closeErr.message : String(closeErr),
            });
          });
          throw err;
        }
        return;
      }

      if (sessionId) {
        if (sessionId.length > MAX_SESSION_ID_LENGTH) {
          res.status(400).json({ error: "Invalid mcp-session-id header" });
          return;
        }
        const entry = sessions.get(sessionId);
        if (!entry) {
          res.status(404).json({ error: "Session not found" });
          return;
        }
        await handleExistingSessionRequest(entry, req, res, req.body);
        return;
      }

      res.status(400).json({ error: "Missing mcp-session-id header" });
    },
  );

  const httpServer = createHttpServer((req, res) => {
    const contentLength = firstHeader(req.headers["content-length"]);
    const parsedContentLength = contentLength === undefined ? 0 : Number.parseInt(contentLength, 10);
    if (
      contentLength !== undefined &&
      Number.isFinite(parsedContentLength) &&
      String(parsedContentLength) === contentLength.trim() &&
      parsedContentLength > bodyLimitBytes
    ) {
      res.writeHead(413, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Payload too large" }));
      return;
    }
    if (contentLength === undefined) {
      let byteCount = 0;
      req.on("data", (chunk: Buffer) => {
        byteCount += chunk.length;
        if (byteCount > bodyLimitBytes && !res.headersSent) {
          res.writeHead(413, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Payload too large" }));
          req.destroy();
        }
      });
    }
    app(req, res);
  });

  httpServer.on("error", (err) => {
    httpLogger.error("server error", { err: err instanceof Error ? err.message : String(err) });
  });

  httpServer.listen(config.mcpPort, config.mcpHost, () => {
    httpLogger.info("listening", { url: `http://${config.mcpHost}:${config.mcpPort}/mcp` });
    httpLogger.info("health", { url: `http://${config.mcpHost}:${config.mcpPort}/health` });
    httpLogger.info("ready", { url: `http://${config.mcpHost}:${config.mcpPort}/ready` });
  });

  const close = async () => {
    clearInterval(idleCleanupInterval);
    await closeActiveSessionsForShutdown(sessions);
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err?: Error) => (err ? reject(err) : resolve()));
    });
  };

  return { httpServer, close };
}
