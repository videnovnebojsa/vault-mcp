# Design Standards

> Living document. Every architectural decision, error-handling rule, observability requirement,
> and API contract belongs here. When something is wrong, fix it here first — then the code.
>
> **Status**: reflects the state after the v0.2 hardening sprint (May 2026).

---

## Table of Contents

1. [Architecture](#1-architecture)
2. [Error Handling](#2-error-handling)
3. [Observability](#3-observability)
4. [API Design & Validation](#4-api-design--validation)
5. [Testing](#5-testing)
6. [Security](#6-security)

---

## 1. Architecture

### 1.1 Layer Boundaries

```
┌─────────────────────────────────────────┐
│  MCP Transport (http.ts / bridge)       │  ← session management, auth
├─────────────────────────────────────────┤
│  Tool Registration (mcp/tools.ts)       │  ← Zod schemas, wrapHandler, getSvc
├─────────────────────────────────────────┤
│  Tool Handlers (mcp/handlers/*.ts)      │  ← pure business logic, no I/O wiring
├─────────────────────────────────────────┤
│  Domain Services                        │
│    vault/repository.ts (IVaultRepository)│
│    search/store.ts                      │
│    search/sync.ts                       │
│    capture/service.ts                   │
├─────────────────────────────────────────┤
│  Utilities (utils/)                     │  ← logger, errors, circuit-breaker, retry
└─────────────────────────────────────────┘
```

**Rule**: dependencies only flow downward. `search/` must not import from `vault/repository.ts`
(the concrete class). Use `IVaultRepository` from `vault/repository-interface.ts`.

### 1.2 Interfaces Over Concrete Classes

All cross-layer dependencies MUST go through interfaces, not concrete classes:

| Interface | File | Implemented by |
|-----------|------|---------------|
| `IVaultRepository` | `src/vault/repository-interface.ts` | `VaultRepository` |
| `EmbedProvider` | `src/search/embed-provider.ts` | `HttpEmbedProvider` |

When adding a new cross-layer dependency, create the interface first, then implement it.
This makes handler unit tests possible without touching the filesystem.

### 1.3 Dependency Injection

Constructor injection over global singletons:

```typescript
// ✅ Correct — injectable factory
export class VaultManager {
  constructor(
    private readonly namedVaults: Record<string, string>,
    private readonly baseConfig: VaultConfig,
    private readonly embedProviderFactory: EmbedProviderFactory = defaultEmbedProviderFactory,
  ) {}
}

// ❌ Wrong — hardcoded dependency, untestable
constructor(...) {
  this.embedProvider = new HttpEmbedProvider(...);
}
```

### 1.4 Tool Handler Decomposition

Each MCP tool has exactly one handler file in `src/mcp/handlers/`:

```
src/mcp/handlers/
  read-note.ts        → handleVaultReadNote(args, services)
  write-note.ts       → handleVaultWriteNote(args, services, vaultManager)
  search.ts           → handleVaultSearch(args, services)
  ...
  index.ts            → re-exports all handlers
```

**Handler contract:**
- Pure business logic — no `try/catch` (errors bubble to `wrapHandler`)
- No span creation (that's `wrapHandler`'s job)
- No `wrapHandler` calls inside handlers
- Accepts typed args, returns `Promise<ToolResult>`
- Testable with `MockVaultRepository` (no real FS needed)

> **Exception — `vault_batch`**: This is the only handler that creates per-operation child spans
> and uses `try/catch/finally` at the operation level. Both are required by §3.4 (per-operation
> child spans for distributed tracing). The `wrapHandler` boundary still wraps the entire batch
> call; the inner `try/catch` only gates individual operation errors so the batch can
> `continue_on_error`.

`src/mcp/tools.ts` is a thin dispatch file — Zod schemas + `wrapHandler` calls + `getSvc`.
No business logic. Line count grows linearly with tool count; that is expected.

### 1.5 Shutdown Safety

All fire-and-forget async calls that touch shared state (SQLite) MUST be tracked:

```typescript
// ✅ Correct — tracked, drained before shutdown
vaultManager.trackSync(
  vaultSync.handleUpsert(path).catch((err) => logger.error("tools", "sync failed", { err }))
);

// ❌ Wrong — untracked, races against searchStore.close()
vaultSync.handleUpsert(path).catch(...);
```

`VaultManager.shutdown()` awaits `Promise.allSettled(inflightSyncs)` before closing stores.
This prevents WAL corruption when Claude shuts down during a sync.

### 1.6 HTTP Session Management

Sessions are bounded and time-limited:

- `MAX_SESSIONS` (env: `MCP_MAX_SESSIONS`, default 100) — 429 on overflow
- `SESSION_IDLE_MS` (env: `MCP_SESSION_IDLE_MS`, default 30 min) — idle eviction every 5 min
- Session IDs logged as first 8 characters only (prevent session hijacking via log access)
- `server` is created BEFORE `transport` (prevents race where `onsessioninitialized` fires
  before `server` is assigned)

### 1.7 Schema Migrations

SQLite schema changes MUST go through the migration runner in `src/search/migrations.ts`:

```typescript
// src/search/some-store.ts
runMigrations(this.db, MY_MIGRATIONS, "my_schema_version");
```

Migrations are ordered arrays. Each migration has a version number, description, and SQL.
Migrations run inside a transaction — bad SQL rolls back and throws rather than leaving the
DB in a partial state. Never change a migration that has already shipped; always append.

### 1.8 Vault Folder Constants

Folder paths are defined once in `src/config/folders.ts`:

```typescript
import { VAULT_FOLDERS } from "../config/folders.js";
// Use VAULT_FOLDERS.INBOX, VAULT_FOLDERS.ZETTELKASTEN, etc.
```

Never hardcode `"00_Inbox"`, `"30_Zettelkasten"`, etc. inline in business logic.

---

## 2. Error Handling

### 2.1 Error Hierarchy

All application-level errors extend `VaultError` (`src/utils/errors.ts`):

```
Error
└── VaultError
      code: VaultErrorCode (enum)
      cause?: unknown
```

| Code | When to use |
|------|------------|
| `NOT_FOUND` | Note or vault path does not exist |
| `PATH_TRAVERSAL` | Path escapes vault root |
| `ACL_VIOLATION` | Path blocked by allow/deny rules |
| `CONFLICT` | Write would overwrite unexpected content |
| `VALIDATION` | Input fails business-rule validation (after Zod) |
| `BOOT_FAILED` | Vault service failed to initialise |
| `STORE_UNAVAILABLE` | SQLite store not ready |
| `TIMEOUT` | Operation exceeded `toolTimeoutMs` |
| `EXTERNAL_API` | Embedding / webhook call failed |
| `AUDIT_FAILED` | Audit log write failed (non-fatal, but logged at warn) |

`PathTraversalError` and `AclViolationError` extend `VaultError` with the appropriate codes.

### 2.2 Single Error Boundary

`wrapHandler` in `src/mcp/tools.ts` is the **only** place that catches errors and converts
them to MCP `ToolResult`. Handlers MUST NOT have their own `try/catch` for converting errors
to `isError: true` responses.

```typescript
// ✅ Handler — just throw on error
async function handleVaultReadNote(args, services): Promise<ToolResult> {
  const note = await services.vault.readNote(args.path); // throws VaultError if not found
  return successResult(toClientNote(note));
}

// ❌ Wrong — inner catch hides span errors
async function handleVaultReadNote(args, services): Promise<ToolResult> {
  try {
    const note = await services.vault.readNote(args.path);
    return successResult(toClientNote(note));
  } catch (err) {
    return errorResult("NOT_FOUND", err.message); // span never sees this as an error
  }
}
```

The only acceptable `isError: true` returns from handlers are **intentional non-exceptional**
tool states (e.g. "embeddings not enabled", "sync already running"). `wrapHandler` correctly
marks the span as error in both cases.

> **Exception — `vault_batch`**: The per-operation `try/catch` inside `handleVaultBatch` is
> intentional (§3.4). Each operation result is captured individually; errors do not bubble to
> `wrapHandler` because that would abort remaining batch items. The batch-level result may still
> surface `isError: true` when any operation fails.

### 2.3 No Swallowed Errors

Every `catch` block in production code MUST do one of:

1. **Log and re-throw** (for recoverable errors that callers should know about)
2. **Log at `warn` level and continue** (for genuinely non-fatal side effects — audit log, webhook)

```typescript
// ✅ Audit log — non-fatal, but operators must know
} catch (err) {
  logger.warn("capture", "audit log write failed — audit trail incomplete", {
    err: err instanceof Error ? err.message : String(err),
    notePath: result.path,
  });
}

// ❌ Silent swallow — operators have no idea the audit trail is broken
} catch { /* Non-fatal */ }
```

`catch {}` and `catch (e) {}` (no body) are banned from production code paths.

### 2.4 Boot Error Preservation

`getSvc` preserves the original boot error message:

```typescript
const bootError = await svc.bootReady.then(() => null).catch((e: unknown) => e);
if (bootError !== null) {
  throw new VaultError(
    `Vault "${vaultName}" failed to initialise: ${reason}`, // includes original message
    VaultErrorCode.BOOT_FAILED,
    bootError, // original error as cause
  );
}
```

Never use `.catch(() => {})` on `bootReady` — the original exception and its stack must be
preserved for debugging.

### 2.5 Circuit Breaker

The circuit breaker uses a **sliding window** (not a counter):

- Failure times are stored as timestamps
- Failures older than `windowMs` are evicted before counting
- A success in `closed` state does NOT reset the window (failures age out naturally)
- Only a successful probe from `half-open` → `closed` resets the window

This prevents the "alternating success/failure never trips" bug of counter-based breakers.

```typescript
new CircuitBreaker("http-embed", {
  failureThreshold: 5,
  resetTimeoutMs: 60_000,
  windowMs: 60_000, // failures older than 60s don't count
});
```

### 2.6 Retry Backoff

`retryAfterMs` from server responses is honoured but capped at `maxDelayMs`:

```typescript
delay = Math.max(delay, Math.min(serverDelay, maxDelayMs));
// Logs a warning if the server requested longer than maxDelayMs
```

Never let a server-controlled retry delay exceed the configured maximum.

### 2.7 Logging Rules

| Rule | Detail |
|------|--------|
| No `console.error` in production code | Always use `logger.warn` / `logger.error` |
| Structured fields | `{ err: err.message, path: ..., category: ... }` — never string interpolation |
| URL credentials masked before logging | `url.replace(/:[^:@/]+@/, ":***@")` |
| Recovery from circuit-breaker logs at `info` | Recovery is positive — not a warning |
| `getSvc` boot failure includes original message | See §2.4 |

---

## 3. Observability

### 3.1 Trace / Log Correlation

Every tool call has a `requestId` that appears in **both** structured logs and OTel spans:

```
Log entry:  { requestId: "a3f2b1c4", tool: "vault_search", ... }
OTel span:  attributes: { "request.id": "a3f2b1c4", "tool.name": "vault_search", ... }
```

To find the log entries for a trace (or vice versa), search by `request.id` / `requestId`.

Implementation:
- `beginSpan()` in `src/utils/span.ts` creates an internal span with a UUID `id`
- `otelSpan()` in `src/utils/otel.ts` accepts `extraAttributes` including `{ "request.id": id }`
- `ActiveSpan.id` is exposed so `wrapHandler` can pass it to child spans

### 3.2 OTel Startup

`startSpanFn` is initialized as a **noop** immediately — not `null` or `undefined`.
Spans during startup are no-ops, never dropped. The noop is upgraded atomically
after `sdk.start()` resolves.

### 3.3 Span Accuracy

`wrapHandler` correctly marks the OTel span as error in **both** paths:

1. Handler **throws** → `span.end(err)` — span gets error status
2. Handler returns `{ isError: true }` → `span.end(new Error(msg))` — span gets error status

Spans with `isError: true` results are never marked successful.

### 3.4 Batch Operations

`vault_batch` produces **per-operation child spans** in addition to the parent span:

```
vault_batch (parent)
  vault_batch.move     (child)
  vault_batch.delete   (child)
  vault_batch.update_properties (child)
```

This makes per-operation latency and errors visible in traces.

### 3.5 Health and Readiness

| Endpoint | Purpose |
|----------|---------|
| `GET /health` | Always returns 200 `{ status: "ok", ... }`. When authenticated, includes vault boot states. Use for liveness checks. |
| `GET /ready` | Returns 503 while any vault is booting. Use for readiness checks / load balancer gates. |

Never use `/health` for readiness decisions — it does not reflect boot state.

`/ready` has a 200ms per-vault timeout to stay bounded even if a vault hangs during boot.

### 3.6 Structured Log Fields

Standard fields logged by `wrapHandler` on every tool call:

```
requestId, tool, vault, durationMs, isError
```

Error fields added on failure:

```
err (message string), code (VaultErrorCode if available)
```

---

## 4. API Design & Validation

### 4.1 Standard Response Envelope

All 21 tools MUST return one of three shapes. Use the helpers in `src/mcp/format.ts`:

```typescript
// Single item
successResult(data) → { ok: true, data: { ... } }

// Paginated list with exact totals
listResult(items, { kind: "knownTotal", total, offset, limit })
  → { ok: true, items: [...], total, hasMore, nextOffset? }

// Paginated list when only "one more page?" is known
listResult(items, { kind: "unknownTotal", offset, limit, hasMore })
  → { ok: true, items: [...], total: null, hasMore, nextOffset? }

// Error
errorResult(code, message) → { ok: false, error: { code, message } }
```

**Never** return bare arrays, bare strings, or custom `{ ok: true, ... }` shapes from handlers.
An LLM agent must be able to handle the response without knowing which tool it came from.

### 4.2 Error Codes in API Responses

Machine-readable error codes are required. The LLM agent uses them for flow control:

| Code | Meaning |
|------|---------|
| `NOT_FOUND` | Note or section does not exist |
| `CONFIRMATION_REQUIRED` | Destructive op needs `confirm: true` |
| `MODE_UNAVAILABLE` | Requested search mode needs embeddings |
| `NOT_ENABLED` | Feature not configured (replaces CAPTURE_DISABLED, EMBEDDINGS_DISABLED, BACKUP_DISABLED) |
| `ALREADY_RUNNING` | Concurrent operation in progress |
| `CONFLICT` | Destination already exists (move/rename collision) |
| `VALIDATION` | Input failed schema or business-rule check |
| `STORE_UNAVAILABLE` | Search index or database not available |
| `EXTERNAL_API` | Upstream API (embeddings provider) returned an error |
| `TIMEOUT` | Operation exceeded the configured time limit |
| `BOOT_FAILED` | Vault failed to initialise |
| `INTERNAL_ERROR` | Unexpected error |

### 4.3 Zod Schema Standards

```typescript
// Vault name — validated pattern (no path traversal possible)
VAULT_PARAM = z.string().regex(/^[a-zA-Z0-9_-]+$/).max(100).optional()

// Path and query strings — trimmed and non-empty before reaching filesystem/SQL
PATH_PARAM  = z.string().trim().min(1).max(500)
QUERY_PARAM = z.string().trim().min(1).max(500)

// Date params — validated ISO 8601, never silently NaN
DATE_PARAM = z.string().max(50).refine(s => !isNaN(new Date(s).getTime()), ...)

// Bounded integers
LIMIT_PARAM(max, default) = z.number().int().min(1).max(max).optional()

// Frontmatter keys — valid identifiers only
PROPERTIES_PARAM = z.record(z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_-]*/), z.unknown())
```

**Rules:**
- Vault name must match `[a-zA-Z0-9_-]+` — Zod rejects traversal attempts before business logic
- Path and query strings must be non-empty after trimming — empty strings must not reach the filesystem or SQL layer
- Date strings must parse to a valid Date — never silently skip a filter
- `limit` params always have `.max()` — prevent DoS via large page requests
- Frontmatter property keys must be valid identifiers — reject `../evil` at schema level
- Schema defaults belong in the Zod schema (`.default()`), not in handler logic

### 4.4 Pagination

All list tools support `offset` + `limit` and return `hasMore` + `nextOffset`:

```json
{ "ok": true, "items": [...], "total": 142, "hasMore": true, "nextOffset": 20 }
```

Pattern for bounded queries (avoids full table scan for large vaults):
```typescript
const fetched = await repo.listFolder(folder, { limit: limit + 1, offset });
const hasMore = fetched.length > limit;
const items = hasMore ? fetched.slice(0, limit) : fetched;
```

### 4.5 Destructive Operation Gates

Operations that cannot be undone require explicit confirmation:

```typescript
// vault_delete_note with trash=false
if (trash === false && args.confirm !== true) {
  return errorResult(
    "CONFIRMATION_REQUIRED",
    "Permanent deletion requires confirm=true. Set trash=true to move to .trash/ instead.",
  );
}
```

**Permanently-destructive operations that require a gate:**
- `vault_delete_note` with `trash=false`
- `vault_batch` delete operations with `trash=false`

Soft delete (trash=true, the default) never requires confirmation.

### 4.6 Mode Mismatch Errors

When a tool is called with a mode or feature that isn't available, return a machine-readable
error — never silently fall back:

```typescript
// ✅ Explicit error when embeddings mode requested but unavailable
if (args.mode === "semantic" && !embeddingsAvailable) {
  return errorResult("MODE_UNAVAILABLE", `Search mode "semantic" requires embeddings...`);
}

// ❌ Silent fallback — the agent asked for semantic and got keyword
const effectiveMode = mode ?? (embeddingsAvailable ? "hybrid" : "keyword");
```

Silent fallback is only acceptable when **no explicit mode was requested**.

### 4.7 Tool Naming Convention

All tools use `verb_noun` or `verb_noun_qualifier` in snake_case:

- `vault_read_note`, `vault_write_note`, `vault_move_note` — CRUD on notes
- `vault_search`, `vault_list_folder`, `vault_list_tags` — queries
- `vault_sync`, `vault_backup_db`, `vault_embed_backlog` — maintenance
- `vault_capture`, `vault_triage_inbox`, `vault_periodic_note` — workflows

Do not use nouns alone (`vault_note` → ambiguous) or adjective-first names.

### 4.8 Concurrency Guards

Long-running operations that should not run concurrently expose an `isSyncing()` check:

```typescript
if (vaultSync.isSyncing()) {
  return successResult({ alreadyRunning: true, message: "Sync already in progress" });
}
```

---

## 5. Testing

### 5.1 TDD Workflow

1. Write a failing test
2. Implement the minimum code to make it pass
3. Refactor (keeping tests green)

This is enforced for all new features and bug fixes.

### 5.2 Handler Tests (Unit)

Each handler file has a `*.test.ts` that tests it directly — no MCP server, no real FS:

```typescript
// Use MockVaultRepository from src/vault/repository-interface.test.ts
const vault = new MockVaultRepository();
await vault.writeNote("inbox/note", { content: "hello" });
const result = await handleVaultReadNote({ path: "inbox/note" }, makeServices({ vault }));
expect(JSON.parse(result.content[0].text)).toMatchObject({ ok: true });
```

Handler tests run in ~5ms. Integration tests run in ~500ms. Keep the ratio high.

### 5.3 What to Test at Each Layer

| Layer | Test focus |
|-------|-----------|
| Handler unit tests | Business logic: happy path + all error cases |
| Schema tests (`tools.test.ts`) | Zod rejects bad input before it reaches handlers |
| Integration tests (`http.test.ts`) | HTTP endpoints: /ready, /health, session bounds |
| Store tests | SQLite migrations, FTS search, embedding CRUD |
| Utility tests | Circuit breaker timing, retry backoff, token comparison |

### 5.4 Fake Timers

All time-dependent tests use `vi.useFakeTimers()`:

```typescript
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("evicts idle sessions", () => {
  sessions.set("idle", { ..., lastActivityAt: Date.now() - SESSION_IDLE_MS - 1 });
  vi.advanceTimersByTime(5 * 60 * 1000 + 1); // trigger cleanup interval
  expect(sessions.has("idle")).toBe(false);
});
```

Never use real `sleep()` or `setTimeout()` in tests.

### 5.5 Coverage Thresholds

Type coverage must stay at or above **95%** (`pnpm check:types`).
All `noExplicitAny` occurrences in test files must use typed alternatives or a narrow cast
with a comment explaining why `as any` is unavoidable.

---

## 6. Security

### 6.1 Path Safety

All vault-relative paths are validated against the vault root before any FS operation.
`src/vault/path-safety.ts` enforces:

- No `..` traversal (checked after `path.resolve`)
- No symlinks that escape the vault root
- ACL allow/deny list evaluated before read or write

`PathTraversalError` and `AclViolationError` extend `VaultError` and are caught by `wrapHandler`.
They never reach the filesystem layer.

### 6.2 Frontmatter Parsing

All `gray-matter` calls pin `{ language: "yaml" }` to prevent the bundled JavaScript eval
engine from executing arbitrary code embedded in YAML:

```typescript
matter(content, { language: "yaml" }) // ✅ safe
matter(content)                        // ❌ may execute JS in YAML blocks
```

### 6.3 Token Comparison

`isValidToken` uses `timingSafeEqual` to prevent timing attacks. An empty expected key
always returns `false` — an empty `MCP_API_KEY` disables auth entirely rather than
accepting any token:

```typescript
if (!expected || expected.length === 0) return false; // auth disabled
```

### 6.4 Credential Logging

URLs containing credentials (webhook, API keys) MUST be masked before logging:

```typescript
const maskedUrl = url.replace(/:[^:@/]+@/, ":***@");
logger.warn("alert", "webhook failed", { url: maskedUrl });
```

### 6.5 Session Security

- Session IDs are UUIDs (`randomUUID()`) — not sequential, not guessable
- Only the first 8 characters are logged — full IDs in logs enable session hijacking
- Sessions expire after `SESSION_IDLE_MS` of inactivity

---

## Improvement Log

> Record significant decisions and the reasoning behind them. Future changes should
> reference this log to avoid re-litigating settled questions.

| Date | Change | Why |
|------|--------|-----|
| 2026-05-12 | Replaced counter-based circuit breaker with sliding window | Alternating success/failure never tripped the old breaker; the new one trips within `failureThreshold * 2` calls |
| 2026-05-12 | Added `wrapHandler` as single error boundary | Double try/catch caused spans to misreport success when tools returned `isError: true` |
| 2026-05-12 | Added `MAX_SESSIONS` + idle eviction | Unbounded session map allowed a misbehaving client to exhaust memory |
| 2026-05-12 | Added shutdown drain (`Promise.allSettled(inflightSyncs)`) | Fire-and-forget syncs were racing against `searchStore.close()`, risking WAL corruption |
| 2026-05-12 | Switched `getSvc` to preserve original boot error | `.catch(() => {})` discarded the exception — debugging required guessing by log timestamp |
| 2026-05-12 | Added `/ready` endpoint separate from `/health` | `/health` always returned 200; load balancers couldn't distinguish "running" from "ready to serve" |
| 2026-05-12 | Added `confirm: true` gate on permanent delete | Destructive ops had no protection; LLM agents could accidentally delete notes |
| 2026-05-12 | Made `vault_search` return `MODE_UNAVAILABLE` error | Silent fallback to keyword when semantic was requested confused agents about search quality |
| 2026-05-12 | Standard 3-shape response envelope | 5+ different response shapes meant agents had to parse each tool differently |
