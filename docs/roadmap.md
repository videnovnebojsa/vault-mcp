# Roadmap

## v0.1.0 — Initial Release (2026-05-27)

**Core MCP tools (20 total)**
- `vault_read_note`, `vault_write_note`, `vault_delete_note`, `vault_move_note`
- `vault_search` — hybrid FTS5 + vector search with date/tag/type filters
- `vault_capture` — heuristic capture pipeline with inbox routing
- `vault_classify` — auto-classify notes by content
- `vault_triage_inbox` — classify and move all inbox notes in one call
- `vault_sync`, `vault_embed_backlog` — incremental file watcher sync + embedding backfill
- `vault_batch` — move/delete/update multiple notes in one call
- `vault_list_folder` — enriched with search-index metadata (tags, type)
- `vault_list_tags`, `vault_list_vaults`
- `vault_periodic_note` — open/create daily, weekly, monthly notes
- `vault_read_note_with_links` — backlink-aware read with resolved wikilinks
- `vault_read_section` — read a single heading section from a note
- `vault_update_properties` — update frontmatter fields in place
- `vault_find_connections` — surface semantically related notes
- `vault_backup_db` — snapshot the SQLite search index

**Infrastructure**
- HTTP server with session management and Bearer auth
- stdio ↔ HTTP bridge for Claude Desktop
- Multi-vault support — `VaultManager` registry, `VAULT_<NAME>_PATH` env vars, `vault` param on all tools
- Configurable folder names via `VAULT_FOLDER_*` env vars
- WAL mode SQLite with covering indexes for embeddings
- OpenTelemetry tracing — per-tool-call latency spans via `wrapHandler`
- Cross-platform standalone binaries — Linux x64, macOS arm64, macOS x64, Windows x64
- 973-test suite with 80% line/function coverage gate
- Lefthook pre-commit (biome + gitleaks) and pre-push (typecheck + tests) hooks

---

## v0.2 — Planned

**Folder-level permissions**
- `VAULT_ALLOW_PATHS` / `VAULT_DENY_PATHS` env vars
- Path validation in `src/vault/path-safety.ts` before any read/write

**MCP Resources**
- `vault://config` — current config (vault path, enabled features)
- `vault://stats` — note count, index size, embedding coverage %

**Unicode/Cyrillic audit**
- Explicit tests for Cyrillic headings, content, and search queries
- Advertised as "explicitly tested" in README

## v0.3 — Backlog

- **Canvas file support** — read `.canvas` files (Obsidian JSON node-link format)
- **PDF/attachment reading** — extract text from PDFs linked in notes
