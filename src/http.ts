import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer as createHttpServer } from "node:http";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { BootstrapResult } from "./bootstrap.js";
import { createServer } from "./mcp/server.js";
import { getAllCircuits } from "./utils/circuits.js";
import { logger } from "./utils/logger.js";
import { metrics } from "./utils/metrics.js";
import { isValidToken } from "./utils/token.js";

const httpLogger = logger.child("http");

const DEFAULT_HTTP_BODY_LIMIT_BYTES = 1024 * 1024;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 100;

function firstHeader(h: string | string[] | undefined): string | undefined {
  return Array.isArray(h) ? h[0] : h;
}

function getJsonRpcLogContext(body: unknown): { method?: string; id?: string | number | null } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return {};
  }
  const candidate = body as { method?: unknown; id?: unknown };
  const context: { method?: string; id?: string | number | null } = {};
  if (typeof candidate.method === "string") {
    context.method = candidate.method;
  }
  if (typeof candidate.id === "string" || typeof candidate.id === "number" || candidate.id === null) {
    context.id = candidate.id;
  }
  return context;
}

async function safeCloseRequestResource(
  name: "transport.close" | "server.close",
  close: () => Promise<void>,
): Promise<void> {
  try {
    await close();
  } catch (err) {
    httpLogger.error(`${name} failed`, {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

export function parsePositiveIntEnv(name: string, defaultValue: number): number {
  const raw = process.env[name] ?? String(defaultValue);
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || String(parsed) !== raw.trim()) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export interface HttpServerHandle {
  httpServer: Server;
  close(): Promise<void>;
}

export interface HttpServerOptions {
  bodyLimitBytes?: number;
  maxConcurrentRequests?: number;
}

export async function startHttpServer(boot: BootstrapResult, opts: HttpServerOptions = {}): Promise<HttpServerHandle> {
  const { config } = boot;
  const bodyLimitBytes =
    opts.bodyLimitBytes ?? parsePositiveIntEnv("MCP_HTTP_BODY_LIMIT_BYTES", DEFAULT_HTTP_BODY_LIMIT_BYTES);
  const maxConcurrentRequests =
    opts.maxConcurrentRequests ?? parsePositiveIntEnv("MCP_MAX_CONCURRENT_REQUESTS", DEFAULT_MAX_CONCURRENT_REQUESTS);
  const idleRequestServers: Array<ReturnType<typeof createServer>> = [];
  const inFlightRequests = new Set<Promise<void>>();
  let createdRequestServers = 0;

  const acquireRequestServer = (): ReturnType<typeof createServer> | null => {
    const idleServer = idleRequestServers.pop();
    if (idleServer) return idleServer;
    if (createdRequestServers >= maxConcurrentRequests) return null;
    const server = createServer({
      vaultManager: boot.vaultManager,
      mcpHost: config.mcpHost,
      mcpPort: config.mcpPort,
    });
    createdRequestServers += 1;
    return server;
  };

  const releaseRequestServer = (server: ReturnType<typeof createServer>): void => {
    if (idleRequestServers.length < maxConcurrentRequests) {
      idleRequestServers.push(server);
    }
  };

  const waitForInFlightRequests = async (): Promise<void> => {
    while (inFlightRequests.size > 0) {
      await Promise.allSettled(Array.from(inFlightRequests));
    }
  };

  const app = createMcpExpressApp({ host: config.mcpHost });

  const startedAt = Date.now();
  // GET /health — returns {status,uptimeSeconds} to all callers.
  // When MCP_API_KEY is set, an authenticated request (Authorization: Bearer <key>)
  // additionally returns vault boot state, circuit-breaker state, and metrics.
  app.get(
    "/health",
    async (
      req: IncomingMessage & { headers: Record<string, string | string[] | undefined> },
      res: ServerResponse & { json(body: unknown): void },
    ) => {
      const uptimeSeconds = Math.floor((Date.now() - startedAt) / 1000);
      // When an API key is configured, require it for detailed health data to avoid
      // leaking circuit names, vault state, and metrics to unauthenticated callers.
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

      // This server is request/response-only: it only accepts POST (request/response) and
      // DELETE (session teardown). Every other method gets 405 + an Allow header, matching the
      // advertised method contract. In particular this declines the optional standalone GET SSE
      // stream — this server never sends server-initiated messages (no notifications,
      // subscriptions, or list-changed events), so SDK clients (including the stdio bridge) must
      // not open a long-lived idle GET stream that times out and then wedges on 409 reconnect
      // races. Per the MCP spec the GET stream is optional, and the SDK client treats 405 as the
      // canonical "no SSE at GET" signal — it stops cleanly without reconnecting.
      if (req.method !== "POST" && req.method !== "DELETE") {
        res.setHeader("Allow", "POST, DELETE");
        metrics.record("http_mcp_method_not_allowed", 0, false);
        httpLogger.info("declined unsupported method", { method: req.method, status: 405 });
        res.status(405).json({
          error:
            req.method === "GET" ? "Method Not Allowed: server does not offer a GET SSE stream" : "Method Not Allowed",
        });
        return;
      }

      // DELETE — stateless mode has no session to tear down. Acknowledge so a client's
      // terminateSession() call never surfaces as an error.
      if (req.method === "DELETE") {
        res.status(200).json({ ok: true });
        return;
      }

      const server = acquireRequestServer();
      if (!server) {
        res.status(429).json({ error: "Too Many Requests" });
        return;
      }

      // POST — stateless request/response. Reuse a warmed McpServer when one is idle, but always
      // create a fresh transport per request (sessionIdGenerator: undefined), so no
      // mcp-session-id is ever issued or required, and a stale session id from a reconnecting
      // client is simply ignored. This removes the entire session lifecycle: no in-memory session
      // map, no idle eviction, and no "Session not found" after an idle gap or a server restart.
      // The SDK forbids transport reuse across requests, but the heavy vault state lives in
      // boot.vaultManager, so a bounded server pool is enough to avoid per-request tool
      // re-registration. See docs/adr/0003-stateless-http-sessions.md.
      // Omitting sessionIdGenerator selects the SDK's stateless mode (it reads as `undefined`
      // internally); we omit rather than pass `undefined` to satisfy exactOptionalPropertyTypes.
      const transport = new StreamableHTTPServerTransport({});
      let resolveRequestDrain!: () => void;
      const requestDrainPromise = new Promise<void>((resolve) => {
        resolveRequestDrain = resolve;
      });
      inFlightRequests.add(requestDrainPromise);
      let requestDrainResolved = false;
      const settleRequestDrain = (): void => {
        if (requestDrainResolved) return;
        requestDrainResolved = true;
        inFlightRequests.delete(requestDrainPromise);
        resolveRequestDrain();
      };
      let closeRequestResourcesPromise: Promise<void> | null = null;
      const closeRequestResources = (): Promise<void> => {
        if (closeRequestResourcesPromise) return closeRequestResourcesPromise;
        closeRequestResourcesPromise = (async () => {
          try {
            await safeCloseRequestResource("transport.close", () => transport.close());
            await safeCloseRequestResource("server.close", () => server.close());
          } finally {
            releaseRequestServer(server);
          }
        })().finally(() => {
          settleRequestDrain();
        });
        return closeRequestResourcesPromise;
      };
      res.on("finish", () => {
        void closeRequestResources();
      });
      res.on("close", () => {
        void closeRequestResources();
      });

      try {
        // @ts-expect-error -- MCP SDK StreamableHTTPServerTransport uses T|undefined for onclose, incompatible with exactOptionalPropertyTypes
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (err) {
        httpLogger.error("stateless request transport error", {
          err: err instanceof Error ? err.message : String(err),
          ...getJsonRpcLogContext(req.body),
        });
        if (!res.headersSent) {
          res.status(500).json({ error: "Internal server error" });
        } else if (!res.writableEnded) {
          res.end();
        }
        await closeRequestResources();
      }
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
    const closeHttpServerPromise = new Promise<void>((resolve, reject) => {
      httpServer.close((err?: Error) => (err ? reject(err) : resolve()));
    });
    await Promise.all([closeHttpServerPromise, waitForInFlightRequests()]);
  };

  return { httpServer, close };
}
