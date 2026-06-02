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

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import { drainTextStream, parseSseResponse } from "./smoke-test-lib.js";

// ─── Config ───────────────────────────────────────────────────────────────────

const BINARY = process.argv[2] ?? join(homedir(), ".local", "bin", "vault-mcp");
const STARTUP_TIMEOUT_MS = 20_000;

// Pick a random high port to avoid collisions with other running instances.
// Re-use a port passed via env var so CI can pin it if needed.
const rawPort = process.env["INTEGRATION_TEST_PORT"];
const PORT = rawPort ? Number.parseInt(rawPort, 10) : 30000 + Math.floor(Math.random() * 5000);
if (rawPort && (!Number.isFinite(PORT) || String(PORT) !== rawPort.trim())) {
  console.error("FAIL: INTEGRATION_TEST_PORT must be a number");
  process.exit(1);
}
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
  [
    `OBSIDIAN_VAULT_PATH="${vaultPath}"`,
    `MCP_PORT=${PORT}`,
    "ENABLE_EMBEDDINGS=false",
    "ENABLE_CAPTURE_PIPELINE=true",
  ].join("\n") + "\n";
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

async function getBinaryExitCode(): Promise<number | null> {
  if (proc.exitCode !== null) return proc.exitCode;
  return Promise.race([proc.exited, Bun.sleep(0).then(() => null)]);
}

// Drain stdout/stderr so the process doesn't block on full buffers
void drainTextStream(proc.stdout, (chunk) => {
  if (process.env["VERBOSE"]) process.stderr.write(`[out] ${chunk}`);
});
void drainTextStream(proc.stderr, (chunk) => {
  if (process.env["VERBOSE"]) process.stderr.write(`[err] ${chunk}`);
});

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

let exiting = false;
function cleanupAndExit(code: number): never {
  if (!exiting) {
    exiting = true;
    cleanup();
  }
  process.exit(code);
}

process.on("SIGINT", () => cleanupAndExit(130));
process.on("SIGTERM", () => cleanupAndExit(143));

// ─── Startup: wait for /ready ─────────────────────────────────────────────────
// /ready returns 200 only after the vault finishes initial indexing.
// This guarantees FTS search results are available before we start asserting.

process.stdout.write(`Starting binary on port ${PORT}. Waiting for /ready`);
let ready = false;
const deadline = Date.now() + STARTUP_TIMEOUT_MS;
while (Date.now() < deadline) {
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
  process.stdout.write(".");
  await Bun.sleep(500);
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

let msgId = 0;

/** POST a JSON-RPC message to /mcp. */
async function rpc(method: string, params: Record<string, unknown>): Promise<Response> {
  const id = ++msgId;
  return fetch(`${BASE_URL}/mcp`, {
    method: "POST",
    headers: MCP_HEADERS,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
}

async function notify(method: string, params: Record<string, unknown> = {}): Promise<Response> {
  return fetch(`${BASE_URL}/mcp`, {
    method: "POST",
    headers: MCP_HEADERS,
    body: JSON.stringify({ jsonrpc: "2.0", method, params }),
  });
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
  const { result, contentText } = await callToolRaw(name, args);

  if (result.isError) {
    throw new Error(`Tool error from ${name}: ${contentText}`);
  }

  const toolResult = JSON.parse(contentText) as ToolResult;
  if (!toolResult.ok) {
    throw new Error(
      `${name} returned ok:false — ${toolResult.error?.code ?? "?"}: ${toolResult.error?.message ?? contentText}`,
    );
  }
  return toolResult;
}

async function callToolExpectError(
  name: string,
  args: Record<string, unknown>,
  expectedCode: string,
): Promise<ToolResult> {
  const { result, contentText } = await callToolRaw(name, args);
  const toolResult = JSON.parse(contentText) as ToolResult;

  if (!result.isError) {
    throw new Error(`Expected tool error from ${name}, got isError=false`);
  }
  if (toolResult.ok !== false) {
    throw new Error(`Expected ok:false from ${name}, got ${JSON.stringify(toolResult)}`);
  }
  assertEqual(toolResult.error?.code, expectedCode, `${name} error code`);
  assertTruthy(toolResult.error?.message, `${name} error message`);
  return toolResult;
}

async function callToolRaw(
  name: string,
  args: Record<string, unknown>,
): Promise<{ result: { content?: Array<{ text: string }>; isError?: boolean }; contentText: string }> {
  const beforeExitCode = await getBinaryExitCode();
  if (beforeExitCode !== null) throw new Error(`binary exited during ${name} before request (code ${beforeExitCode})`);

  let res: Response;
  try {
    res = await rpc("tools/call", { name, arguments: args });
  } catch (err) {
    const afterExitCode = await getBinaryExitCode();
    if (afterExitCode !== null) throw new Error(`binary exited during ${name} (code ${afterExitCode})`);
    throw err;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} calling ${name}`);

  const rawText = await res.text();
  const envelope = parseSseResponse(rawText, name) as {
    result?: { content?: Array<{ text: string }>; isError?: boolean };
    error?: { code: number; message: string };
  };

  if (envelope.error) {
    throw new Error(`RPC error ${envelope.error.code}: ${envelope.error.message}`);
  }

  const result = envelope.result;
  const contentText = result?.content?.[0]?.text;
  if (!contentText) throw new Error(`Empty content from ${name}`);
  return { result, contentText };
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
console.log("OK  initialize");

const initializedRes = await notify("notifications/initialized");
if (!initializedRes.ok) {
  cleanup();
  console.error(`FAIL: notifications/initialized returned HTTP ${initializedRes.status}`);
  process.exit(1);
}
console.log("OK  notifications/initialized");

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

function assertNoItemPathIncludes(items: Array<{ path: string }> | undefined, needle: string, ctx: string) {
  if (!Array.isArray(items)) throw new Error(`${ctx}: expected item array, got ${JSON.stringify(items)}`);
  assertTruthy(!items.some((i) => i.path.includes(needle)), ctx);
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

// 4. Missing note returns the standard tool error envelope
await test("vault_read_note (missing note error contract)", async () => {
  await callToolExpectError("vault_read_note", { path: "missing-note" }, "NOT_FOUND");
});

// 5. Keyword search — unique marker only in note-beta
await test("vault_search (keyword, unique phrase)", async () => {
  const r = await callTool("vault_search", { query: "xyzzy-unique-marker", mode: "keyword" });
  const items = r.items as Array<{ path: string }>;
  assertTruthy(items?.length > 0, "at least one result");
  assertTruthy(
    items.some((i) => i.path.includes("note-beta")),
    "note-beta in results",
  );
});

// 6. Search with tag filter — alpha tag should match note-alpha, exclude note-beta
await test("vault_search (tag filter)", async () => {
  const r = await callTool("vault_search", { query: "integration", mode: "keyword", tags: ["alpha"] });
  const items = r.items as Array<{ path: string }>;
  assertTruthy(
    items?.some((i) => i.path.includes("note-alpha")),
    "note-alpha in filtered results",
  );
  assertNoItemPathIncludes(items, "note-beta", "note-beta excluded by tag filter");
});

// 7. Write a new note
await test("vault_write_note", async () => {
  await callTool("vault_write_note", {
    path: "test-write",
    content: "# Written by integration test\n\nThis note was created by the test suite.",
    frontmatter: { tags: ["test-generated"] },
  });
});

// 8. Read back the written note
await test("vault_read_note (verify write)", async () => {
  const r = await callTool("vault_read_note", { path: "test-write" });
  const d = r.data as { content: string; frontmatter: { tags: string[] } };
  assertIncludes(d.content, "Written by integration test", "heading");
  assertTruthy(d.frontmatter.tags?.includes("test-generated"), "tag=test-generated");
});

// 9. Update frontmatter properties (merge — does not replace existing fields)
await test("vault_update_properties", async () => {
  await callTool("vault_update_properties", {
    path: "note-alpha",
    properties: { status: "reviewed", priority: 1 },
  });
});

// 10. Verify updated properties persisted and original fields are intact
await test("vault_read_note (verify properties merged)", async () => {
  const r = await callTool("vault_read_note", { path: "note-alpha" });
  const fm = (r.data as { frontmatter: Record<string, unknown> }).frontmatter;
  assertEqual(fm["status"] as string, "reviewed", "status=reviewed");
  assertEqual(fm["priority"] as number, 1, "priority=1");
  assertTruthy((fm["tags"] as string[])?.includes("alpha"), "original tag preserved after merge");
});

// 11. Read note with linked notes expanded inline
await test("vault_read_note_with_links (linked notes expanded)", async () => {
  const r = await callTool("vault_read_note_with_links", { path: "note-alpha" });
  const d = r.data as { note: { path: string }; linked_notes: Array<{ path: string }> };
  assertTruthy(d.note?.path?.includes("note-alpha"), "root note is note-alpha");
  assertTruthy(
    d.linked_notes?.some((n) => n.path.includes("note-beta")),
    "note-beta in linked notes",
  );
});

// 12. Read a specific heading section — reduces context for large notes
await test("vault_read_section (heading)", async () => {
  const r = await callTool("vault_read_section", { path: "note-alpha", heading: "Details" });
  const d = r.data as { content: string };
  assertIncludes(d.content, "Some details about alpha", "section content");
});

// 13. List all tags — vault-wide inventory with counts
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

// 14. Move a note (also rewrites wikilinks in other notes)
await test("vault_move_note", async () => {
  await callTool("vault_move_note", {
    from_path: "test-write",
    to_path: "subfolder/test-moved",
  });
});

// 15. Verify note is accessible at new path after move
await test("vault_read_note (verify content preserved after move)", async () => {
  const r = await callTool("vault_read_note", { path: "subfolder/test-moved" });
  const d = r.data as { content: string };
  assertIncludes(d.content, "Written by integration test", "content preserved after move");
});

// 16. Verify original path is absent after move
await test("vault_read_note (verify original path absent after move)", async () => {
  await callToolExpectError("vault_read_note", { path: "test-write" }, "NOT_FOUND");
});

// 17. Soft-delete the moved note to .trash/
await test("vault_delete_note (soft delete to .trash)", async () => {
  const r = await callTool("vault_delete_note", { path: "subfolder/test-moved", trash: true });
  const d = r.data as { trashName: string };
  assertTruthy(d.trashName?.length > 0, "trashName returned");
  assertTruthy(existsSync(join(vaultPath, ".trash", d.trashName)), ".trash entry exists");
});

// 18. Confirm deleted note is gone from folder listing
await test("vault_list_folder (deleted note absent)", async () => {
  const r = await callTool("vault_list_folder", { folder: "subfolder", recursive: false });
  const items = r.items as Array<{ path: string }>;
  assertNoItemPathIncludes(items, "test-moved", "deleted note absent");
});

// 19. Permanently delete a note with explicit confirmation
await test("vault_delete_note (hard delete with confirmation)", async () => {
  await callTool("vault_write_note", {
    path: "hard-delete-target",
    content: "# Delete me permanently\n",
  });
  await callTool("vault_delete_note", { path: "hard-delete-target", trash: false, confirm: true });
});

// 20. Confirm hard-deleted note is gone from root folder listing
await test("vault_list_folder (hard-deleted note absent)", async () => {
  const r = await callTool("vault_list_folder", { folder: "/", recursive: false });
  const items = r.items as Array<{ path: string }>;
  assertNoItemPathIncludes(items, "hard-delete-target", "hard-deleted note absent");
});

// 21. Classify text — tests the capture pipeline keyword heuristics
await test("vault_classify (returns folder and title suggestions)", async () => {
  const r = await callTool("vault_classify", {
    text: "Meeting notes with John about Q3 product roadmap and upcoming sprint planning.",
  });
  const d = r.data as { suggested_folder: string; suggested_title: string; tags?: string[] };
  assertEqual(d.suggested_folder, "10_Projects", "project text routes to projects folder");
  assertTruthy(d.suggested_title.includes("Meeting notes with John"), "title derived from input");
  assertTruthy(d.tags?.includes("project"), "project tag set");
});

// 22. List all configured vaults
await test("vault_list_vaults (at least one vault returned)", async () => {
  const r = await callTool("vault_list_vaults", {});
  const d = r.data as { vaults: Array<{ name: string }> };
  assertTruthy(Array.isArray(d.vaults), "vaults is array");
  assertTruthy(d.vaults.length >= 1, `at least one vault (got ${d.vaults.length})`);
  assertTruthy(d.vaults[0]?.name?.length > 0, "vault has a name");
});

// 23. Trigger a full vault sync and verify statistics are returned
await test("vault_sync (returns sync statistics)", async () => {
  const r = await callTool("vault_sync", {});
  const d = r.data as { scanned: number; upserted: number; deletedStale: number; durationMs: number };
  assertTruthy(typeof d.scanned === "number", "scanned is a number");
  assertTruthy(d.scanned >= 3, `scanned at least 3 seeded notes (got ${d.scanned})`);
  assertTruthy(typeof d.durationMs === "number", "durationMs is a number");
});

// 24. Backup the search database (enabled by default)
await test("vault_backup_db (returns backup filename)", async () => {
  const r = await callTool("vault_backup_db", {});
  const d = r.data as { ok: boolean; outputFile?: string };
  assertTruthy(d.outputFile?.length > 0, "outputFile returned");
  assertTruthy(d.outputFile?.endsWith(".db") || d.outputFile?.endsWith(".sqlite"), "outputFile has db extension");
});

// 25. Capture text via the capture pipeline — requires ENABLE_CAPTURE_PIPELINE=true
await test("vault_capture (text is filed into vault and path returned)", async () => {
  const r = await callTool("vault_capture", {
    text: "Reminder: finish the integration test coverage for vault-mcp before the sprint ends.",
  });
  const d = r.data as { path?: string; message?: string };
  assertTruthy(d.path?.length > 0, "path returned after capture");
});

// 26. Triage inbox in dry-run mode — verifies result shape without mutating vault
await test("vault_triage_inbox (dry_run returns result shape)", async () => {
  const r = await callTool("vault_triage_inbox", {
    dry_run: true,
    auto_move_threshold: 0.8,
    suggest_threshold: 0.5,
  });
  const d = r.data as { moved: unknown[]; suggested: unknown[]; skipped: unknown[] };
  assertTruthy(Array.isArray(d.moved), "moved is array");
  assertTruthy(Array.isArray(d.suggested), "suggested is array");
  assertTruthy(Array.isArray(d.skipped), "skipped is array");
});

// 27. Open or create a daily periodic note
await test("vault_periodic_note (creates daily note and returns path)", async () => {
  const r = await callTool("vault_periodic_note", {
    period: "daily",
    date: "2024-01-15",
    create_if_missing: true,
  });
  const d = r.data as { path: string; content: string };
  assertTruthy(d.path?.length > 0, "path returned");
  assertTruthy(d.path.includes("2024-01-15"), "path includes date");
});

// 28. Periodic note with create_if_missing=false on a non-existent date returns NOT_FOUND
await test("vault_periodic_note (create_if_missing=false, missing note returns NOT_FOUND)", async () => {
  await callToolExpectError(
    "vault_periodic_note",
    { period: "daily", date: "1990-01-01", create_if_missing: false },
    "NOT_FOUND",
  );
});

// 29. Batch operations — update_properties on two notes in one call
await test("vault_batch (update_properties on two notes)", async () => {
  const r = await callTool("vault_batch", {
    operations: [
      { type: "update_properties", path: "note-alpha", properties: { batch_tested: true } },
      { type: "update_properties", path: "note-beta", properties: { batch_tested: true } },
    ],
    continue_on_error: false,
  });
  const d = r.data as { operations: Array<{ ok: boolean; type: string }>; processedCount: number };
  assertTruthy(Array.isArray(d.operations), "operations is array");
  assertEqual(d.processedCount, 2, "processedCount=2");
  assertTruthy(
    d.operations.every((op) => op.ok),
    "all operations succeeded",
  );
});

// 30. Batch with invalid move (missing to_path) returns error for that operation
await test("vault_batch (invalid move without to_path returns operation error)", async () => {
  const r = await callTool("vault_batch", {
    operations: [{ type: "move", path: "note-alpha" }],
    continue_on_error: true,
  });
  const d = r.data as { operations: Array<{ ok: boolean; code?: string }>; processedCount: number };
  assertEqual(d.processedCount, 1, "processedCount=1");
  assertEqual(d.operations[0]?.ok, false, "operation ok=false");
  assertEqual(d.operations[0]?.code, "VALIDATION", "code=VALIDATION");
});

// ─── Results ──────────────────────────────────────────────────────────────────

cleanup();
console.log("");
console.log(`${passed + failed} tests: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exit(1);
}
console.log("PASS integration test complete");
