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
const MCP_JSON_RPC_ERROR_CODE = -32000;

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
const MAX_CONCURRENT_REQUESTS = parsePositiveIntEnv("MCP_MAX_CONCURRENT_REQUESTS", 100);

export interface ActiveSessionEntry {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastActivityAt: number;
}

export type ShutdownSessionEntry = Pick<ActiveSessionEntry, "server">;

export interface RequestTransport {
  sessionId?: string;
  onclose?: () => void;
  onerror?: (err: Error) => void;
  handleRequest(req: IncomingMessage, res: ServerResponse, body?: unknown): Promise<void>;
}

export interface NewSessionRequestArgs {
  boot: BootstrapResult;
  createMcpServer: typeof createServer;
  createTransport?: (options: ConstructorParameters<typeof StreamableHTTPServerTransport>[0]) => RequestTransport;
  sessions: Map<string, ActiveSessionEntry>;
  req: IncomingMessage & {
    method?: string;
    headers: Record<string, string | string[] | undefined>;
    body?: unknown;
  };
  res: ServerResponse & { status(code: number): ServerResponse & { json(body: unknown): void } };
  requestId: string;
}

export interface HttpServerHandle {
  httpServer: Server;
  close(): Promise<void>;
}

export interface HttpServerOptions {
  maxSessions?: number;
  sessionIdleMs?: number;
  bodyLimitBytes?: number;
  maxConcurrentRequests?: number;
  createMcpServer?: typeof createServer;
  createNodeServer?: typeof createHttpServer;
}

export function buildPublicHealthResponse(
  uptimeSeconds: number,
  sessions: number,
): {
  status: "ok";
  uptimeSeconds: number;
  sessions: number;
} {
  return {
    status: "ok",
    uptimeSeconds,
    sessions,
  };
}

export interface InFlightRequestTracker {
  track<T>(request: Promise<T>): Promise<T>;
  drain(): Promise<void>;
}

export function createUnrefedTimeoutPromise<T>(ms: number, value: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(value), ms);
    if (typeof timer === "object" && timer !== null && "unref" in timer && typeof timer.unref === "function") {
      timer.unref();
    }
  });
}

export function createInFlightRequestTracker(): InFlightRequestTracker {
  const inFlight = new Set<Promise<unknown>>();

  return {
    track<T>(request: Promise<T>): Promise<T> {
      inFlight.add(request);
      request.finally(() => {
        inFlight.delete(request);
      });
      return request;
    },
    async drain(): Promise<void> {
      while (inFlight.size > 0) {
        await Promise.allSettled([...inFlight]);
      }
    },
  };
}

export async function buildAuthenticatedHealthResponse({
  boot,
  uptimeSeconds,
  sessions,
  getCircuits = getAllCircuits,
  getMetrics = () => metrics.snapshot(),
  logDetailedHealthError = (extra: Record<string, unknown>) => {
    httpLogger.warn("authenticated health details failed", extra);
  },
}: {
  boot: BootstrapResult;
  uptimeSeconds: number;
  sessions: number;
  getCircuits?: typeof getAllCircuits;
  getMetrics?: () => ReturnType<typeof metrics.snapshot>;
  logDetailedHealthError?: (extra: Record<string, unknown>) => void;
}): Promise<Record<string, unknown>> {
  try {
    const circuits: Record<string, unknown> = {};
    for (const [name, cb] of getCircuits()) {
      circuits[name] = cb.snapshot();
    }

    const vaultStates = Object.fromEntries(
      await Promise.all(
        boot.vaultManager.listVaults().map(async ({ name }) => {
          try {
            const svc = boot.vaultManager.getServices(name);
            const ready = await Promise.race([
              svc.bootReady.then(() => !svc.bootFailed).catch(() => false),
              createUnrefedTimeoutPromise(50, false),
            ]);
            return [name, { bootFailed: svc.bootFailed, ready }] as const;
          } catch {
            return [name, { bootFailed: true, ready: false }] as const;
          }
        }),
      ),
    );

    return {
      ...buildPublicHealthResponse(uptimeSeconds, sessions),
      transport: "http",
      vaults: vaultStates,
      circuits,
      metrics: getMetrics(),
    };
  } catch (err) {
    logDetailedHealthError({ err: err instanceof Error ? err.message : String(err) });
    return buildPublicHealthResponse(uptimeSeconds, sessions);
  }
}

function sendMcpError(
  res: ServerResponse & { status(code: number): ServerResponse & { json(body: unknown): void } },
  statusCode: number,
  message: string,
): void {
  res.status(statusCode).json({
    jsonrpc: "2.0",
    error: { code: MCP_JSON_RPC_ERROR_CODE, message },
    id: null,
  });
}

export async function handleExistingSessionRequest(
  entry: ActiveSessionEntry,
  req: IncomingMessage,
  res: ServerResponse & { status(code: number): ServerResponse & { json(body: unknown): void } },
  body: unknown,
  requestId?: string,
): Promise<void> {
  entry.lastActivityAt = Date.now();
  try {
    await entry.transport.handleRequest(req, res, body);
  } catch (err) {
    httpLogger.error("existing session transport error", {
      err: err instanceof Error ? err.message : String(err),
      ...(requestId ? { requestId } : {}),
    });
    if (!res.headersSent) {
      sendMcpError(res, 500, "Internal server error");
    }
  }
}

export async function handleNewSessionTransportError(
  sessionId: string | undefined,
  sessions: Map<string, unknown>,
  server: Pick<McpServer, "close"> | undefined,
  res: ServerResponse & { status(code: number): ServerResponse & { json(body: unknown): void } },
  err: unknown,
  requestId?: string,
): Promise<void> {
  if (sessionId) sessions.delete(sessionId);
  httpLogger.error("new session transport error", {
    err: err instanceof Error ? err.message : String(err),
    ...(requestId ? { requestId } : {}),
  });
  if (server) {
    await server.close().catch((closeErr: unknown) => {
      httpLogger.warn("session close failed after transport error", {
        err: closeErr instanceof Error ? closeErr.message : String(closeErr),
        ...(requestId ? { requestId } : {}),
      });
    });
  }
  if (!res.headersSent) {
    sendMcpError(res, 500, "Internal server error");
  }
}

export async function handleNewSessionRequest({
  boot,
  createMcpServer,
  // @ts-expect-error -- StreamableHTTPServerTransport.sessionId is string|undefined, not string; exactOptionalPropertyTypes incompatibility
  createTransport = (options) => new StreamableHTTPServerTransport(options),
  sessions,
  req,
  res,
  requestId,
}: NewSessionRequestArgs): Promise<void> {
  let server: McpServer | undefined;
  const transport = createTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sid: string) => {
      if (!server) return;
      sessions.set(sid, {
        transport: transport as StreamableHTTPServerTransport,
        server,
        lastActivityAt: Date.now(),
      });
      transport.onclose = () => {
        sessions.delete(sid);
        httpLogger.info("session closed", { sid: sid.slice(0, 8), remaining: sessions.size });
      };
      httpLogger.info("session created", { sid: sid.slice(0, 8), active: sessions.size });
    },
  });
  transport.onerror = (err: Error) => {
    httpLogger.warn("transport error", { err: err.message, requestId });
  };

  try {
    server = createMcpServer({
      vaultManager: boot.vaultManager,
      mcpHost: boot.config.mcpHost,
      mcpPort: boot.config.mcpPort,
    });
    // @ts-expect-error -- MCP SDK StreamableHTTPServerTransport uses T|undefined for onclose, incompatible with exactOptionalPropertyTypes
    await server.connect(transport);
    const transportReq = Object.assign(Object.create(req), {
      headers: { ...req.headers, "mcp-session-id": undefined },
    }) as IncomingMessage;
    await transport.handleRequest(transportReq, res, req.body);

    if (!transport.sessionId) {
      await server.close();
    }
  } catch (err) {
    await handleNewSessionTransportError(transport.sessionId, sessions, server, res, err, requestId);
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
  const sessions = new Map<string, ActiveSessionEntry>();
  const maxSessions = opts.maxSessions ?? MAX_SESSIONS;
  const sessionIdleMs = opts.sessionIdleMs ?? SESSION_IDLE_MS;
  const maxConcurrentRequests = opts.maxConcurrentRequests ?? MAX_CONCURRENT_REQUESTS;
  const bodyLimitBytes =
    opts.bodyLimitBytes ?? parsePositiveIntEnv("MCP_HTTP_BODY_LIMIT_BYTES", DEFAULT_HTTP_BODY_LIMIT_BYTES);
  const createMcpServer = opts.createMcpServer ?? createServer;
  const createNodeServer = opts.createNodeServer ?? createHttpServer;
  const inFlightRequests = createInFlightRequestTracker();
  let activeRequestCount = 0;
  let shuttingDown = false;

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
          res.json(buildPublicHealthResponse(uptimeSeconds, sessions.size));
          return;
        }
      }
      res.json(await buildAuthenticatedHealthResponse({ boot, uptimeSeconds, sessions: sessions.size }));
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
      const readiness = await Promise.all(
        vaults.map(async ({ name }) => {
          try {
            const svc = boot.vaultManager.getServices(name);
            if (svc.bootFailed) return false;
            // Check with a short timeout so the probe is always bounded.
            return await Promise.race([
              svc.bootReady.then(() => true).catch(() => false),
              createUnrefedTimeoutPromise(200, false),
            ]);
          } catch {
            return false;
          }
        }),
      );
      const unready = vaults.filter((_vault, index) => !readiness[index]).map(({ name }) => name);

      if (unready.length > 0) {
        res.status(503).json({ ready: false, vaultCount: vaults.length, unreadyCount: unready.length });
        return;
      }
      res.json({ ready: true, vaultCount: vaults.length });
    },
  );

  const handleMcpRequest = async (
    req: IncomingMessage & {
      method?: string;
      headers: Record<string, string | string[] | undefined>;
      body?: unknown;
    },
    res: ServerResponse & { status(code: number): ServerResponse & { json(body: unknown): void } },
  ) => {
    const requestId = randomUUID();

    if (shuttingDown) {
      sendMcpError(res, 503, "Server shutting down");
      return;
    }

    if (config.mcpApiKey) {
      const auth = firstHeader(req.headers.authorization);
      const token = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
      if (!isValidToken(token, config.mcpApiKey)) {
        sendMcpError(res, 401, "Unauthorized");
        return;
      }
    }

    if (req.method !== "POST" && req.method !== "DELETE") {
      res.setHeader("Allow", "POST, DELETE");
      sendMcpError(res, 405, "Method not allowed");
      return;
    }

    const sessionId = firstHeader(req.headers["mcp-session-id"]);
    if (req.method === "DELETE" && !sessionId) {
      res.status(200).json({});
      return;
    }

    if (req.method === "POST" && activeRequestCount >= maxConcurrentRequests) {
      res.status(503).json({ error: "Server busy" });
      return;
    }

    const countsTowardConcurrencyLimit = req.method === "POST";
    if (countsTowardConcurrencyLimit) activeRequestCount += 1;
    try {
      if (req.method === "POST" && !sessionId) {
        // Enforce session limit before creating a new session
        if (sessions.size >= maxSessions) {
          res.status(429).json({
            error: "Too many sessions",
          });
          return;
        }
        await handleNewSessionRequest({ boot, createMcpServer, sessions, req, res, requestId });
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
        await handleExistingSessionRequest(entry, req, res, req.body, requestId);
        return;
      }

      res.status(400).json({ error: "Missing mcp-session-id header" });
    } finally {
      if (countsTowardConcurrencyLimit) activeRequestCount -= 1;
    }
  };

  app.all(
    "/mcp",
    async (
      req: IncomingMessage & {
        method?: string;
        headers: Record<string, string | string[] | undefined>;
        body?: unknown;
      },
      res: ServerResponse & { status(code: number): ServerResponse & { json(body: unknown): void } },
    ) => await inFlightRequests.track(handleMcpRequest(req, res)),
  );

  const httpServer = createNodeServer((req, res) => {
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
    shuttingDown = true;
    clearInterval(idleCleanupInterval);
    if ("closeIdleConnections" in httpServer && typeof httpServer.closeIdleConnections === "function") {
      httpServer.closeIdleConnections();
    }
    const serverClosed = new Promise<void>((resolve, reject) => {
      httpServer.close((err?: Error) => (err ? reject(err) : resolve()));
    });
    await inFlightRequests.drain();
    await closeActiveSessionsForShutdown(sessions);
    await serverClosed;
  };

  return { httpServer, close };
}
