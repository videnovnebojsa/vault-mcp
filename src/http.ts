import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
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

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
}

export interface HttpServerHandle {
  httpServer: Server;
  close(): Promise<void>;
}

export async function startHttpServer(boot: BootstrapResult): Promise<HttpServerHandle> {
  const { config } = boot;
  const sessions = new Map<string, SessionEntry>();

  const app = createMcpExpressApp({ host: config.mcpHost });

  const startedAt = Date.now();
  // GET /health — returns {status,uptimeSeconds} to all callers.
  // When MCP_API_KEY is set, an authenticated request (Authorization: Bearer <key>)
  // additionally returns circuit-breaker state, session count, and metrics.
  app.get(
    "/health",
    (
      req: IncomingMessage & { headers: Record<string, string | string[] | undefined> },
      res: ServerResponse & { json(body: unknown): void },
    ) => {
      const uptimeSeconds = Math.floor((Date.now() - startedAt) / 1000);
      // When an API key is configured, require it for detailed health data to avoid
      // leaking circuit names, session counts, and metrics to unauthenticated callers.
      if (config.mcpApiKey) {
        const auth = req.headers.authorization as string | undefined;
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
      res.json({
        status: "ok",
        transport: "http",
        sessions: sessions.size,
        uptimeSeconds,
        circuits,
        metrics: metrics.snapshot(),
      });
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
        const auth = req.headers.authorization as string | undefined;
        const token = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
        if (!isValidToken(token, config.mcpApiKey)) {
          res.status(401).json({ error: "Unauthorized" });
          return;
        }
      }

      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      if (req.method === "POST" && !sessionId) {
        let server: McpServer;
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid: string) => {
            sessions.set(sid, { transport, server });
            transport.onclose = () => {
              sessions.delete(sid);
              httpLogger.info("session closed", { sid, remaining: sessions.size });
            };
            httpLogger.info("session created", { sid, active: sessions.size });
          },
        });

        server = createServer({
          vaultManager: boot.vaultManager,
          mcpHost: config.mcpHost,
          mcpPort: config.mcpPort,
        });

        // @ts-expect-error -- MCP SDK StreamableHTTPServerTransport uses T|undefined for onclose, incompatible with exactOptionalPropertyTypes
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);

        if (!transport.sessionId) {
          await server.close();
        }
        return;
      }

      if (sessionId) {
        const entry = sessions.get(sessionId);
        if (!entry) {
          res.status(404).json({ error: "Session not found" });
          return;
        }
        await entry.transport.handleRequest(req, res, req.body);
        return;
      }

      res.status(400).json({ error: "Missing mcp-session-id header" });
    },
  );

  const httpServer = app.listen(config.mcpPort, config.mcpHost, () => {
    httpLogger.info("listening", { url: `http://${config.mcpHost}:${config.mcpPort}/mcp` });
    httpLogger.info("health", { url: `http://${config.mcpHost}:${config.mcpPort}/health` });
  });

  const close = async () => {
    for (const [sid, entry] of sessions) {
      await entry.server.close();
      sessions.delete(sid);
    }
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err?: Error) => (err ? reject(err) : resolve()));
    });
  };

  return { httpServer, close };
}
