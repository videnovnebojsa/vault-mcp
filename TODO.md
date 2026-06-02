# TODO — Review 2026-06-02

Base: `review/2026-06-02`
Fix branch: `fix/2026-06-02`

Uncheck items as you fix them. Each fix commit should reference the ID.
Example: `fix: shutdown idempotency guard [ERR-01]`

## P0


## P1

- [x] **[ERR-01]** (Error Handling) — `res.on("close")` discards `close()` rejections; `unhandledRejection` → full `shutdown()`
- [x] **[QA-01]** (Test Quality) — Per-request `res.on("close")` teardown (leak-prevention path) is untested
- [x] **[QA-02]** (Test Quality) — Inlined transport-error 500 branch lost its test, no replacement

## P2

- [x] **[SEC-01]** (Security) — Removed `MAX_SESSIONS` left no concurrency/rate cap; `MCP_MAX_CONCURRENT_REQUESTS` enforces nothing
- [x] **[PERF-01]** (Performance) — 21-tool Zod re-registration on every POST; "cheap" claim unmeasured
- [x] **[AGY-02]** (Correctness) — Error after headers sent → response never ended, client hangs + socket leak
- [x] **[QA-03]** (Test Quality) — `DELETE /mcp` auth-ordering (401 when key set) is untested

## P3

- [x] **[API-01]** (API / Docs) — Stale `/health` comment advertises removed `sessions` field
- [x] **[ERR-04]** (Observability) — Stateless error log omits JSON-RPC `method`/`id` (only correlation point)
- [x] **[ERR-02]** (Error Handling) — No explicit in-flight drain on shutdown; relies on socket close + `res.on("close")`
- [x] **[ARCH-02]** (Architecture) — Dead `mcp-session-id` capture in out-of-tree scripts
- [x] **[API-02]** (API) — Stateless contract verified only for `initialize`, not a session-less `tools/call`
