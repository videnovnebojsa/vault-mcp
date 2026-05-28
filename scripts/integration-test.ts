#!/usr/bin/env bun
/**
 * Full integration test for the vault-mcp binary.
 *
 * Creates an isolated temp vault and config dir, starts the binary so it reads
 * its configuration from a real .env file (same path as an installed instance),
 * and exercises the MCP tool API end-to-end.
 *
 * Usage:
 *   bun run scripts/integration-test.ts [binary-path]
 *
 * binary-path defaults to ~/.local/bin/vault-mcp
 *
 * Exit code: 0 = all tests passed, 1 = one or more failures.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";

// ─── Config ───────────────────────────────────────────────────────────────────

const BINARY = process.argv[2] ?? join(homedir(), ".local", "bin", "vault-mcp");
const STARTUP_TIMEOUT_MS = 20_000;

// Pick a random high port to avoid collisions with other running instances.
// Re-use a port passed via env var so CI can pin it if needed.
const PORT = process.env["INTEGRATION_TEST_PORT"]
  ? parseInt(process.env["INTEGRATION_TEST_PORT"], 10)
  : 30000 + Math.floor(Math.random() * 5000);
const BASE_URL = `http://localhost:${PORT}`;

// ─── Vault seed data ──────────────────────────────────────────────────────────
// Deterministic content makes assertions stable across runs.
// "xyzzy-unique-marker" appears only in note-beta — search results are unambiguous.

const SEED_NOTES: Record<string, string> = {
  "note-alpha.md": `---
tags: [integration, alpha]
type: note
---
# Alpha Note

This is the alpha note for integration testing.
It links to [[note-beta]].

## Details

Some details about alpha.
`,
  "note-beta.md": `---
tags: [integration, beta]
---
# Beta Note

xyzzy-unique-marker content lives here.
This note is linked from note-alpha.
`,
  "subfolder/note-nested.md": `---
tags: [nested]
---
# Nested Note

A note inside a subfolder.
`,
};

// ─── Setup ────────────────────────────────────────────────────────────────────

const vaultPath = mkdtempSync(join(tmpdir(), "vault-integration-"));
const cfgDir = mkdtempSync(join(tmpdir(), "vault-mcp-cfg-"));

// Seed vault notes
for (const [relPath, content] of Object.entries(SEED_NOTES)) {
  const abs = join(vaultPath, relPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

// Write .env — the binary reads config from here (cwd-based .env loading).
// This is the key thing we're testing: the binary correctly reads OBSIDIAN_VAULT_PATH.
const envContent =
  [`OBSIDIAN_VAULT_PATH="${vaultPath}"`, `MCP_PORT=${PORT}`, "ENABLE_EMBEDDINGS=false"].join("\n") + "\n";
writeFileSync(join(cfgDir, ".env"), envContent);

// ─── Binary lifecycle ─────────────────────────────────────────────────────────

const proc = spawn([BINARY], {
  cwd: cfgDir, // Bun auto-loads .env from cwd
  env: {
    // Minimal env — no OBSIDIAN_VAULT_PATH or MCP_PORT passed directly.
    // Forces the binary to read them from the .env file we wrote above.
    PATH: process.env["PATH"] ?? "",
    HOME: process.env["HOME"] ?? homedir(),
  },
  stdout: "pipe",
  stderr: "pipe",
});

// Drain stdout/stderr so the process doesn't block on full buffers
const drainLog = async (stream: ReadableStream<Uint8Array> | null, prefix: string) => {
  if (!stream) return;
  const reader = stream.getReader();
  const dec = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (process.env["VERBOSE"]) process.stderr.write(`[${prefix}] ${dec.decode(value)}`);
    }
  } catch {
    /* stream closed */
  }
};
void drainLog(proc.stdout, "out");
void drainLog(proc.stderr, "err");

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
  try {
    rmSync(cfgDir, { recursive: true });
  } catch {
    /* best effort */
  }
};

// ─── Startup: wait for /ready ─────────────────────────────────────────────────
// /ready returns 200 only after the vault finishes initial indexing.
// This guarantees FTS search results are available before we start asserting.

process.stdout.write(`Starting binary on port ${PORT}. Waiting for /ready`);
let ready = false;
const deadline = Date.now() + STARTUP_TIMEOUT_MS;
while (Date.now() < deadline) {
  await Bun.sleep(500);
  process.stdout.write(".");

  // Bail out immediately if the binary exited (port conflict, bad config, etc.)
  if (proc.exitCode !== null) {
    process.stdout.write("\n");
    cleanup();
    console.error(`FAIL: binary exited with code ${proc.exitCode} before becoming ready`);
    process.exit(1);
  }

  try {
    const r = await fetch(`${BASE_URL}/ready`);
    if (r.ok) {
      ready = true;
      break;
    }
  } catch {
    /* not up yet */
  }
}
process.stdout.write("\n");

if (!ready) {
  cleanup();
  console.error(`FAIL: /ready did not return 200 within ${STARTUP_TIMEOUT_MS / 1000}s`);
  process.exit(1);
}
console.log("OK  /ready");

// Give the vault watcher a moment to settle after initial sync
await Bun.sleep(300);

// ─── MCP session ─────────────────────────────────────────────────────────────

const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

let sessionId: string | null = null;
let msgId = 0;

/** POST a JSON-RPC message to /mcp. */
async function rpc(method: string, params: Record<string, unknown>): Promise<Response> {
  const id = ++msgId;
  return fetch(`${BASE_URL}/mcp`, {
    method: "POST",
    headers: sessionId ? { ...MCP_HEADERS, "mcp-session-id": sessionId } : MCP_HEADERS,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
}

/** Parse the first SSE `data:` line as JSON. */
function parseSse(text: string): unknown {
  const line = text.split("\n").find((l) => l.startsWith("data:"));
  if (!line) throw new Error("No SSE data line in response");
  return JSON.parse(line.slice(5).trim());
}

type ToolResult = {
  ok: boolean;
  data?: unknown;
  items?: unknown[];
  total?: number;
  hasMore?: boolean;
  error?: { code: string; message: string };
};

/**
 * Call a vault-mcp tool and return the decoded result envelope.
 * Throws on HTTP error, RPC error, empty content, or tool-level error (ok:false).
 */
async function callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const res = await rpc("tools/call", { name, arguments: args });
  if (!res.ok) throw new Error(`HTTP ${res.status} calling ${name}`);

  const rawText = await res.text();
  const envelope = parseSse(rawText) as {
    result?: { content?: Array<{ text: string }>; isError?: boolean };
    error?: { code: number; message: string };
  };

  if (envelope.error) {
    throw new Error(`RPC error ${envelope.error.code}: ${envelope.error.message}`);
  }

  const contentText = envelope.result?.content?.[0]?.text;
  if (!contentText) throw new Error(`Empty content from ${name}`);

  // When isError=true the content text is a plain error string, not JSON
  if (envelope.result?.isError) {
    throw new Error(`Tool error from ${name}: ${contentText}`);
  }

  const result = JSON.parse(contentText) as ToolResult;
  if (!result.ok) {
    throw new Error(
      `${name} returned ok:false — ${result.error?.code ?? "?"}: ${result.error?.message ?? contentText}`,
    );
  }
  return result;
}

// ─── MCP initialize ───────────────────────────────────────────────────────────

const initRes = await rpc("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "integration-test", version: "1" },
});
if (!initRes.ok) {
  cleanup();
  console.error(`FAIL: initialize returned HTTP ${initRes.status}`);
  process.exit(1);
}
sessionId = initRes.headers.get("mcp-session-id");
console.log("OK  initialize");

// ─── Test runner ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function okMsg(label: string) {
  console.log(`OK  ${label}`);
  passed++;
}

function failMsg(label: string, detail: string) {
  console.error(`FAIL ${label}: ${detail}`);
  failed++;
}

async function test(label: string, fn: () => Promise<void>) {
  try {
    await fn();
    okMsg(label);
  } catch (err) {
    failMsg(label, err instanceof Error ? err.message : String(err));
  }
}

function assertIncludes(haystack: string, needle: string, ctx: string) {
  if (!haystack.includes(needle)) {
    throw new Error(`${ctx}: expected "${needle}" in "${haystack.slice(0, 120)}"`);
  }
}

function assertTruthy(val: unknown, ctx: string) {
  if (!val) throw new Error(`${ctx}: expected truthy, got ${JSON.stringify(val)}`);
}

function assertEqual<T>(actual: T, expected: T, ctx: string) {
  if (actual !== expected) {
    throw new Error(`${ctx}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

// 1. List root folder — all seeded notes visible
await test("vault_list_folder (root, all seeded notes present)", async () => {
  const r = await callTool("vault_list_folder", { folder: "/", recursive: true });
  const items = r.items as Array<{ path: string }>;
  assertTruthy(items?.length >= 3, `at least 3 items (got ${items?.length})`);
  const paths = items.map((i) => i.path);
  assertTruthy(
    paths.some((p) => p.includes("note-alpha")),
    "note-alpha present",
  );
  assertTruthy(
    paths.some((p) => p.includes("note-beta")),
    "note-beta present",
  );
  assertTruthy(
    paths.some((p) => p.includes("note-nested")),
    "note-nested present",
  );
});

// 2. List a specific subfolder
await test("vault_list_folder (subfolder)", async () => {
  const r = await callTool("vault_list_folder", { folder: "subfolder", recursive: false });
  const items = r.items as Array<{ path: string }>;
  assertTruthy(
    items?.some((i) => i.path.includes("note-nested")),
    "note-nested present",
  );
});

// 3. Read a note — content and frontmatter
await test("vault_read_note (content and frontmatter)", async () => {
  const r = await callTool("vault_read_note", { path: "note-alpha" });
  const d = r.data as { content: string; frontmatter: { tags: string[]; type: string } };
  assertIncludes(d.content, "Alpha Note", "heading");
  assertIncludes(d.content, "[[note-beta]]", "wikilink");
  assertTruthy(d.frontmatter.tags?.includes("alpha"), "tag=alpha");
  assertEqual(d.frontmatter.type, "note", "type=note");
});

// 4. Keyword search — unique marker only in note-beta
await test("vault_search (keyword, unique phrase)", async () => {
  const r = await callTool("vault_search", { query: "xyzzy-unique-marker", mode: "keyword" });
  const items = r.items as Array<{ path: string }>;
  assertTruthy(items?.length > 0, "at least one result");
  assertTruthy(
    items.some((i) => i.path.includes("note-beta")),
    "note-beta in results",
  );
});

// 5. Search with tag filter — alpha tag should match note-alpha, exclude note-beta
await test("vault_search (tag filter)", async () => {
  const r = await callTool("vault_search", { query: "integration", mode: "keyword", tags: ["alpha"] });
  const items = r.items as Array<{ path: string }>;
  assertTruthy(
    items?.some((i) => i.path.includes("note-alpha")),
    "note-alpha in filtered results",
  );
  assertTruthy(!items?.some((i) => i.path.includes("note-beta")), "note-beta excluded by tag filter");
});

// 6. Write a new note
await test("vault_write_note", async () => {
  await callTool("vault_write_note", {
    path: "test-write",
    content: "# Written by integration test\n\nThis note was created by the test suite.",
    frontmatter: { tags: ["test-generated"] },
  });
});

// 7. Read back the written note
await test("vault_read_note (verify write)", async () => {
  const r = await callTool("vault_read_note", { path: "test-write" });
  const d = r.data as { content: string; frontmatter: { tags: string[] } };
  assertIncludes(d.content, "Written by integration test", "heading");
  assertTruthy(d.frontmatter.tags?.includes("test-generated"), "tag=test-generated");
});

// 8. Update frontmatter properties (merge — does not replace existing fields)
await test("vault_update_properties", async () => {
  await callTool("vault_update_properties", {
    path: "note-alpha",
    properties: { status: "reviewed", priority: 1 },
  });
});

// 9. Verify updated properties persisted and original fields are intact
await test("vault_read_note (verify properties merged)", async () => {
  const r = await callTool("vault_read_note", { path: "note-alpha" });
  const fm = (r.data as { frontmatter: Record<string, unknown> }).frontmatter;
  assertEqual(fm["status"] as string, "reviewed", "status=reviewed");
  assertEqual(fm["priority"] as number, 1, "priority=1");
  assertTruthy((fm["tags"] as string[])?.includes("alpha"), "original tag preserved after merge");
});

// 10. Read note with linked notes expanded inline
await test("vault_read_note_with_links (linked notes expanded)", async () => {
  const r = await callTool("vault_read_note_with_links", { path: "note-alpha" });
  const d = r.data as { note: { path: string }; linked_notes: Array<{ path: string }> };
  assertTruthy(d.note?.path?.includes("note-alpha"), "root note is note-alpha");
  assertTruthy(
    d.linked_notes?.some((n) => n.path.includes("note-beta")),
    "note-beta in linked notes",
  );
});

// 11. Read a specific heading section — reduces context for large notes
await test("vault_read_section (heading)", async () => {
  const r = await callTool("vault_read_section", { path: "note-alpha", heading: "Details" });
  const d = r.data as { content: string };
  assertIncludes(d.content, "Some details about alpha", "section content");
});

// 12. List all tags — vault-wide inventory with counts
await test("vault_list_tags", async () => {
  const r = await callTool("vault_list_tags", {});
  const items = r.items as Array<{ tag: string; count: number }>;
  assertTruthy(items?.length > 0, "tags returned");
  assertTruthy(
    items.some((t) => t.tag === "alpha"),
    "tag=alpha",
  );
  assertTruthy(
    items.some((t) => t.tag === "integration"),
    "tag=integration",
  );
  assertTruthy(
    items.some((t) => t.tag === "nested"),
    "tag=nested",
  );
});

// 13. Move a note (also rewrites wikilinks in other notes)
await test("vault_move_note", async () => {
  await callTool("vault_move_note", {
    from_path: "test-write",
    to_path: "subfolder/test-moved",
  });
});

// 14. Verify note is accessible at new path after move
await test("vault_read_note (verify content preserved after move)", async () => {
  const r = await callTool("vault_read_note", { path: "subfolder/test-moved" });
  const d = r.data as { content: string };
  assertIncludes(d.content, "Written by integration test", "content preserved after move");
});

// 15. Soft-delete the moved note to .trash/
await test("vault_delete_note (soft delete to .trash)", async () => {
  await callTool("vault_delete_note", { path: "subfolder/test-moved", trash: true });
});

// 16. Confirm deleted note is gone from folder listing
await test("vault_list_folder (deleted note absent)", async () => {
  const r = await callTool("vault_list_folder", { folder: "subfolder", recursive: false });
  const items = r.items as Array<{ path: string }>;
  assertTruthy(!items?.some((i) => i.path.includes("test-moved")), "deleted note absent");
});

// 17. Classify text — tests the capture pipeline keyword heuristics
await test("vault_classify (returns folder and title suggestions)", async () => {
  const r = await callTool("vault_classify", {
    text: "Meeting notes with John about Q3 product roadmap and upcoming sprint planning.",
  });
  const d = r.data as { suggested_folder: string; suggested_title: string };
  assertTruthy(typeof d.suggested_folder === "string" && d.suggested_folder.length > 0, "suggested_folder set");
  assertTruthy(typeof d.suggested_title === "string" && d.suggested_title.length > 0, "suggested_title set");
});

// ─── Results ──────────────────────────────────────────────────────────────────

cleanup();
console.log("");
console.log(`${passed + failed} tests: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exit(1);
}
console.log("PASS integration test complete");
