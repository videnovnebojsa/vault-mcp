#!/usr/bin/env npx tsx

/**
 * stdio-to-HTTP bridge for MCP clients that only support stdio transport
 * (e.g., Claude Desktop). Bridges stdin/stdout to the always-on HTTP server.
 *
 * Usage:
 *   npx tsx bin/stdio-bridge.ts
 *
 * Configure in Claude Desktop:
 *   { "command": "npx", "args": ["tsx", "/path/to/vault-service/bin/stdio-bridge.ts"] }
 *
 * Environment:
 *   VAULT_MCP_URL - HTTP server URL (default: http://localhost:3782/mcp)
 *   MCP_API_KEY   - Bearer token for auth (optional, must match server)
 */

import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { StdioHttpBridge } from "../src/bridge/stdio-http-bridge.js";
import { logger } from "../src/utils/logger.js";

const log = logger.child("stdio-bridge");

const url = process.env.VAULT_MCP_URL ?? "http://localhost:3782/mcp";
const apiKey = process.env.MCP_API_KEY;

const httpTransport = new StreamableHTTPClientTransport(
  new URL(url),
  apiKey ? { requestInit: { headers: { Authorization: `Bearer ${apiKey}` } } } : undefined,
);
const stdioTransport = new StdioServerTransport();

const bridge = new StdioHttpBridge(httpTransport, stdioTransport);
await bridge.start();

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals, exitCode: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("shutting down", { signal });
  try {
    await bridge.close();
  } catch (err) {
    log.error("error during shutdown", { err: err instanceof Error ? err.message : String(err) });
  }
  process.exit(exitCode);
}

process.on("SIGINT", () => void shutdown("SIGINT", 0));
process.on("SIGTERM", () => void shutdown("SIGTERM", 0));
process.on("SIGHUP", () => void shutdown("SIGHUP", 0));

process.on("unhandledRejection", (reason) => {
  log.error("unhandledRejection", { reason: reason instanceof Error ? reason.message : String(reason) });
  void shutdown("SIGTERM", 1);
});

process.on("uncaughtException", (err) => {
  log.error("uncaughtException", { err: err.message });
  void shutdown("SIGTERM", 1);
});
