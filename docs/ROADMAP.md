# Roadmap

## v0.1 — Shipped

- 16 core MCP tools (read, write, search, move, delete, capture, sync, embed, backup)
- Hybrid FTS5 + vector search with date/tag filters
- Backlink-aware `vault_move_note` (rewrites `[[wikilinks]]`)
- Soft delete to `.trash/`
- Heuristic capture pipeline
- SQLite search index with incremental file watcher sync
- HTTP server with session management + Bearer auth
- stdio ↔ HTTP bridge for Claude Desktop

## v0.2 — In Progress

- [x] `vault_triage_inbox` — auto-classify and move inbox notes
- [x] `vault_periodic_note` — open/create daily, weekly, monthly notes
- [x] `vault_batch` — move/delete/update multiple notes in one call
- [x] `vault_list_folder` enriched with search-index metadata (tags, type)

## v0.3 — Planned

**Folder-level permissions**
- `VAULT_ALLOW_PATHS` / `VAULT_DENY_PATHS` env vars
- Path validation in `src/vault/path-safety.ts` before any read/write

**MCP Resources**
- `vault://config` — current config (vault path, enabled features)
- `vault://stats` — note count, index size, embedding coverage %

**Unicode/Cyrillic audit**
- Explicit tests for Cyrillic headings, content, and search queries
- Advertised as "explicitly tested" in README

## v0.4 — In Progress

- [x] **Multi-vault support** — `VaultManager` registry + `VAULT_PATHS` env var + `vault` param on all 20 tools + `vault_list_vaults` tool

## v0.5+ — Backlog

- **Canvas file support** — read `.canvas` files (Obsidian JSON node-link format)
- **OpenTelemetry tracing** — per-tool-call latency spans
- **PDF/attachment reading** — extract text from PDFs linked in notes
- **Bun single-binary** — `bun build --compile` for zero-install distribution
