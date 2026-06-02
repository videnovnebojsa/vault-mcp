#!/usr/bin/env bun
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import {
  assertOkResponse,
  buildSmokeEnv,
  drainTextStream,
  parseToolsListResponse,
  type ToolsListResponse,
} from "./smoke-test-lib.js";

const binary = process.argv[2];
if (!binary) {
  console.error("Usage: bun run scripts/smoke-test.ts <binary-path>");
  process.exit(1);
}

const vaultPath = join(tmpdir(), `vault-smoke-${Date.now()}`);
mkdirSync(vaultPath);
writeFileSync(join(vaultPath, "test.md"), "# Smoke Test\nHello from smoke test.");

const proc = spawn([binary], {
  env: buildSmokeEnv(process.env, vaultPath),
  stdout: "pipe",
  stderr: "pipe",
});

const stdoutDrain = drainTextStream(proc.stdout, (chunk) => process.stdout.write(chunk));
const stderrDrain = drainTextStream(proc.stderr, (chunk) => process.stderr.write(chunk));

const cleanup = () => {
  try {
    proc.kill();
  } catch {
    /* already dead */
  }
  try {
    rmSync(vaultPath, { recursive: true });
  } catch {
    /* best effort */
  }
};

// Poll health endpoint with retries (up to 10s)
let healthy = false;
for (let i = 0; i < 20; i++) {
  await Bun.sleep(500);
  try {
    const r = await fetch("http://localhost:3783/health");
    if (r.ok) {
      healthy = true;
      break;
    }
  } catch {
    /* not up yet */
  }
}

if (!healthy) {
  cleanup();
  console.error("FAIL: health endpoint did not respond within 10s");
  process.exit(1);
}
console.log("OK: health endpoint");

const mcpHeaders = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

// MCP requires initialize before tools/list
const initRes = await fetch("http://localhost:3783/mcp", {
  method: "POST",
  headers: mcpHeaders,
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "1" } },
  }),
});
try {
  await assertOkResponse(initRes, "initialize");
} catch (err) {
  cleanup();
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
console.log("OK: initialize");

// Test MCP tools/list via HTTP (response is SSE: parse the first data: line)
const mcpRes = await fetch("http://localhost:3783/mcp", {
  method: "POST",
  headers: mcpHeaders,
  body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
});
try {
  await assertOkResponse(mcpRes, "tools/list");
} catch (err) {
  cleanup();
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

const mcpText = await mcpRes.text();
let mcpBody: ToolsListResponse;
try {
  mcpBody = parseToolsListResponse(mcpText);
} catch (err) {
  cleanup();
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

if (!mcpBody.result?.tools?.length) {
  cleanup();
  console.error("FAIL: tools/list returned no tools");
  process.exit(1);
}
console.log(`OK: tools/list (${mcpBody.result.tools.length} tools)`);

cleanup();
await Promise.race([Promise.allSettled([stdoutDrain, stderrDrain]), Bun.sleep(500)]);
console.log("PASS: smoke test complete");
