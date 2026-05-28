# TODO — Review 2026-05-28

Base: `review/2026-05-28`
Fix branch: `fix/2026-05-28`

Uncheck items as you fix them. Each fix commit should reference the ID.
Example: `fix: shutdown idempotency guard [ERR-01]`

## P0

- [ ] **[PERF-01]** (Performance) — Full McpServer+transport created per POST
- [x] **[ERR-01]** (Observability) — `transport.onerror` never wired — SDK errors silently dropped
- [x] **[ERR-02]** (Error Handling) — `createServer()` outside `try` — resource leak + stack trace exposure
- [x] **[SEC-01]** (Security) — No concurrency cap — DoS via request flooding
- [ ] **[API-01]** (API Design) — Stateful→stateless breaking change; no migration path
- [x] **[QA-01]** (QA) — `headersSent: true` catch branch untested
- [x] **[QA-02]** (QA) — `server.connect()` throw path untested

## P1

- [ ] **[ARCH-01]** (Architecture) — Three docs files describe removed session model as current
- [x] **[ERR-03]** (Error Handling) — `httpServer.close()` hangs silently on keep-alive connections
- [x] **[API-02]** (API Design) — 405 missing required `Allow` header
- [x] **[API-03]** (API Design) — `DELETE /mcp` blocked — unreachable per-spec endpoint
- [x] **[PERF-03]** (Performance) — `/ready` probes vaults sequentially (N × 200 ms worst case)
- [x] **[PERF-04]** (Performance) — `/health` probes vaults sequentially (N × 50 ms worst case)
- [x] **[QA-03]** (QA) — `server.close()` failure in `finally` untested
- [x] **[API-06]** (API Design) — 405/401/500 bodies not JSON-RPC 2.0 compliant

## P2

- [x] **[ARCH-02]** (Architecture) — `close()` does not drain in-flight per-request handlers
- [x] **[ERR-04]** (Observability) — No request-scoped correlation ID on error logs
- [x] **[API-04]** (API Design) — `sessions` field silently removed from `/health` response
- [x] **[QA-08]** (QA) — No concurrent-request test for stateless isolation

## P3

- [x] **[SEC-04]** (Security) — Stale `mcp-session-id` passed through rather than stripped
- [x] **[ARCH-04]** (Architecture) — `@ts-expect-error` suppressions lack upstream issue reference
- [ ] **[ARCH-05–07]** (Architecture) — Diagram and log entries still show session-map
- [x] **[ERR-05]** (Error Handling) — `void shutdown()` discards promise
- [x] **[ERR-06]** (Error Handling) — `/health` auth path missing `try/catch` around `circuits`/`metrics`
- [x] **[ERR-07]** (Error Handling) — `setTimeout` promises not `.unref()`'d
- [x] **[QA-04]** (QA) — 405 response body not asserted
- [x] **[QA-05]** (QA) — `MCP_HTTP_BODY_LIMIT_BYTES` env-var path not tested end-to-end
- [x] **[QA-11]** (QA) — CFG-28/29 removal leaves gap in sequential test IDs
