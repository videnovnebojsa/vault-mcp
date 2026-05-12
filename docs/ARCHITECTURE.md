# Architecture

vault-mcp is a single-process Node.js service that exposes an Obsidian vault as an MCP server over HTTP.

## Module Map

```
src/
├── index.ts          — entry point: bootstrap → startHttpServer → graceful shutdown
├── bootstrap.ts      — Layer 1 init: loads config, creates all services
├── config.ts         — env var loading (~15 vars)
├── http.ts           — Express-free HTTP + SSE + Bearer auth, session management
│
├── mcp/
│   ├── server.ts     — McpServer factory, wires tools to services
│   ├── tools.ts      — All 20 tool registrations (Zod schemas + handlers)
│   └── classify.ts   — Heuristic text classifier (used by vault_classify)
│
├── vault/
│   ├── repository.ts — Filesystem I/O: read/write/move/delete/list
│   ├── periodic.ts   — Periodic note path generation + open-or-create
│   ├── types.ts      — VaultNote, VaultFrontmatter, WriteNoteInput, etc.
│   ├── frontmatter.ts— gray-matter parse/serialize + Zod validation
│   ├── schema.ts     — Zod schema for frontmatter
│   └── path-safety.ts— Path traversal protection, symlink checks
│
├── search/
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
│
└── utils/
    ├── logger.ts     — Structured child-logger with level + JSON format
    ├── retry.ts      — Exponential backoff with jitter
    ├── circuit-breaker.ts — Circuit breaker for embedding API calls
    ├── circuits.ts   — Global circuit registry
    ├── alert.ts      — Webhook alert dispatch
    └── notify.ts     — Telegram notification (optional)
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
- **Soft delete by default**: `vault_delete_note` moves to `.trash/` unless `trash=false`.
- **Fire-and-forget sync**: tools don't await `vaultSync.handleUpsert()` — index lag is acceptable.
- **Stateless sessions**: each HTTP POST without `mcp-session-id` creates a fresh server. Sessions are held in a Map and cleaned up on `transport.onclose`.

## Database

SQLite via `better-sqlite3` with WAL mode. Two logical stores in one file:

- `vault_entries` — FTS5 virtual table for keyword search + metadata
- `embeddings` — Float32 vectors stored as BLOBs with cosine similarity search

The file lives at `MEMORY_DB_PATH` (default `{vault}/.vault-search.db`). It is rebuilt from scratch via `vault_sync` and updated incrementally by the file watcher.
