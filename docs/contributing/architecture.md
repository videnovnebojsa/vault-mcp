# Architecture

vault-mcp is a single-process Bun service that exposes an Obsidian vault as an MCP server over HTTP.

## Module Map

```
src/
├── index.ts          — entry point: bootstrap → startHttpServer → graceful shutdown
├── bootstrap.ts      — Layer 1 init: loads config, creates all services
├── config.ts         — env var loading (~15 vars)
├── http.ts           — Express-free HTTP + SSE + Bearer auth, session management
│                       GET /health (liveness), GET /ready (readiness), POST /mcp
│
├── mcp/
│   ├── server.ts     — McpServer factory, wires tools to services
│   ├── tools.ts      — Thin dispatch: 21 tool registrations (Zod schemas + getSvc + wrapHandler)
│   ├── format.ts     — Standard response envelope helpers (successResult, listResult, errorResult)
│   ├── classify.ts   — Heuristic text classifier (used by vault_classify)
│   └── handlers/     — One file per tool; pure business logic, no I/O wiring
│       ├── index.ts         re-exports all handlers
│       ├── read-note.ts     handleVaultReadNote
│       ├── write-note.ts    handleVaultWriteNote
│       ├── search.ts        handleVaultSearch (+ applyAclFilter, applyMetadataFilters)
│       ├── list-folder.ts   handleVaultListFolder
│       ├── list-tags.ts     handleVaultListTags
│       ├── classify.ts      handleVaultClassify
│       ├── update-properties.ts  handleVaultUpdateProperties
│       ├── move-note.ts     handleVaultMoveNote
│       ├── delete-note.ts   handleVaultDeleteNote
│       ├── read-section.ts  handleVaultReadSection
│       ├── note-with-links.ts    handleVaultReadNoteWithLinks
│       ├── capture.ts       handleVaultCapture
│       ├── sync.ts          handleVaultSync
│       ├── embed-backlog.ts handleVaultEmbedBacklog
│       ├── find-connections.ts   handleVaultFindConnections
│       ├── backup-db.ts     handleVaultBackupDb
│       ├── triage-inbox.ts  handleVaultTriageInbox
│       ├── periodic-note.ts handleVaultPeriodicNote
│       ├── batch.ts         handleVaultBatch
│       └── list-vaults.ts   handleVaultListVaults
│
├── config/
│   └── folders.ts    — VAULT_FOLDERS constants + DEFAULT_SKIP_CONNECTION_PREFIXES
│
├── vault/
│   ├── repository-interface.ts — IVaultRepository interface (cross-layer contract)
│   ├── repository.ts — Filesystem I/O: implements IVaultRepository
│   ├── periodic.ts   — Periodic note path generation + open-or-create
│   ├── markdown.ts   — extractWikilinks, readSection, and other markdown utilities
│   ├── types.ts      — VaultNote, VaultFrontmatter, WriteNoteInput, etc.
│   ├── frontmatter.ts— gray-matter parse/serialize + Zod validation
│   ├── schema.ts     — Zod schema for frontmatter
│   └── path-safety.ts— Path traversal protection, symlink checks
│
├── search/
│   ├── migrations.ts — Versioned SQLite migration runner
│   ├── store.ts      — SQLite FTS5 index + hybrid search + tag listing
│   ├── sync.ts       — Full + incremental vault sync to search index
│   ├── embeddings.ts — Float32 embedding storage in SQLite BLOB
│   ├── embed-provider.ts — OpenAI-compatible embedding API client
│   ├── connections.ts— Cross-reference gap detection (semantic similarity)
│   ├── tasks.ts      — Background tasks: embed backlog, backup
│   └── watcher.ts    — chokidar file watcher → incremental sync
│
├── capture/
│   ├── service.ts    — Classify → path → write pipeline
│   ├── classify-adapter.ts — Bridges heuristic classifier to CaptureClassification
│   ├── filename.ts   — Builds capture file path from classification
│   └── audit-log.ts  — Appends capture events to audit log
│
├── triage/
│   └── inbox.ts      — Inbox triage: heuristic classify → auto-move or suggest
│
├── bridge/
│   └── stdio-http-bridge.ts — Bridges stdio transport ↔ HTTP transport for Claude Desktop
│                              (server is request/response-only; declines GET SSE — see ADR-0001)
│
└── utils/
    ├── errors.ts     — VaultError, VaultErrorCode enum, formatErrorResponse
    ├── logger.ts     — Structured child-logger with level + JSON format
    ├── span.ts       — beginSpan / ActiveSpan (internal requestId + OTel correlation)
    ├── otel.ts       — OpenTelemetry integration (noop until SDK starts)
    ├── telemetry.ts  — MetricsStore (per-tool call/error counts)
    ├── retry.ts      — Exponential backoff with jitter + retryAfterMs cap
    ├── circuit-breaker.ts — Sliding-window circuit breaker
    ├── circuits.ts   — Global circuit registry
    ├── timeout.ts    — withTimeout helper
    ├── token.ts      — Timing-safe Bearer token comparison
    └── alert.ts      — Webhook alert dispatch (credentials masked in logs)
```

## Data Flow

```
Claude Code / Claude Desktop
        │
        │  HTTP POST /mcp  (or stdio via bridge)
        ▼
   http.ts — session map (sessionId → {transport, McpServer})
        │
        ▼
   mcp/server.ts — McpServer (MCP SDK)
        │
        ▼
   mcp/tools.ts — tool handler
        │
   ┌────┴──────────────────────┐
   │                           │
   ▼                           ▼
vault/repository.ts    search/store.ts (SQLite)
(filesystem I/O)       (FTS5 + embeddings)
```

## Key Invariants

- **All paths are vault-relative** with forward slashes. Absolute paths never leave `vault/`.
- **Atomic writes**: new files are written to `.tmp-{pid}-{ts}` then renamed.
- **Soft delete by default**: `vault_delete_note` moves to `.trash/` unless `trash=false` + `confirm=true`.
- **Tracked sync**: tools call `vaultManager.trackSync(vaultSync.handleUpsert(...))` so shutdown can drain in-flight syncs before closing SQLite.
- **Bounded sessions**: HTTP sessions are capped at `MAX_SESSIONS` (default 100) and evicted after `SESSION_IDLE_MS` of inactivity (default 30 min).
- **Single error boundary**: `wrapHandler` is the only `try/catch` in the tool dispatch path. Handlers throw freely; `wrapHandler` converts to `ToolResult` and marks the OTel span.
- **Readiness vs liveness**: `GET /ready` returns 503 while vaults are booting. `GET /health` always returns 200.

See `docs/contributing/design-standards.md` for the full set of rules and the reasoning behind each.

## Decision Records

Significant architectural choices are captured as ADRs in [`docs/adr/`](../adr/README.md). Notable:

- [ADR-0001](../adr/0001-decline-standalone-get-sse-stream.md) — `/mcp` accepts only `POST` and
  `DELETE`; all other methods (incl. the optional standalone `GET` SSE stream) return `405`,
  because the server never sends server-initiated messages.

## Database

SQLite via `bun:sqlite` with WAL mode. Two logical stores in one file:

- `vault_entries` — FTS5 virtual table for keyword search + metadata
- `embeddings` — Float32 vectors stored as BLOBs with cosine similarity search

The file lives at `MEMORY_DB_PATH` (default `{vault}/.vault-search.db`). It is rebuilt from scratch via `vault_sync` and updated incrementally by the file watcher.

### PRAGMA policy

The database layer applies documented SQLite settings internally and does not expose arbitrary PRAGMA passthrough to callers. Startup currently sets `journal_mode = WAL`; future settings should be added as named methods or constants with tests. This keeps expensive or state-changing PRAGMA calls out of generic caller input while leaving the supported settings explicit in the store boundary.

### Backup behavior

`VaultSearchStore.backup()` uses VACUUM INTO because `bun:sqlite` does not provide an online backup API. The backup is blocking and emits `backup started` / `backup finished` logs so CI and operators can correlate stalls with backup work.
