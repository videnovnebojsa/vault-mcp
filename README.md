# vault-mcp

Production-grade MCP server for Obsidian vaults.

- **Hybrid search** — FTS5 keyword + vector embeddings with fused ranking
- **Backlink-aware operations** — rename updates `[[wikilinks]]` across the vault
- **Capture pipeline** — classify text and file it into the right folder
- **Soft delete** — moves to `.trash/` by default, no accidents
- **No REST API plugin required** — reads vault directly, sidesteps the data loss bug in Local REST API plugin
- **Always-on HTTP server** — one server, multiple MCP clients (Claude Code + Claude Desktop simultaneously)
- **Zero Python dependency** — pure TypeScript, Node.js 20+

## Quick Start

Prerequisites: Node.js 20+, pnpm, an Obsidian vault

```bash
git clone https://github.com/videnovnebojsa/vault-mcp
cd vault-mcp
pnpm install && pnpm build
OBSIDIAN_VAULT_PATH=~/Documents/obsidian pnpm start
```

Add to Claude Code (`.mcp.json` in project root):

```json
{ "mcpServers": { "vault": { "type": "http", "url": "http://127.0.0.1:3782/mcp" } } }
```

Health check: `curl http://localhost:3782/health`

## Tools (20)

| Tool | Description |
|---|---|
| `vault_read_note` | Read note content + frontmatter |
| `vault_write_note` | Create/update note with frontmatter |
| `vault_search` | Hybrid FTS5 + semantic search with date/tag filters |
| `vault_list_tags` | All tags with note counts |
| `vault_classify` | Heuristic text classifier |
| `vault_list_folder` | List notes in folder with index metadata |
| `vault_update_properties` | Merge frontmatter fields |
| `vault_move_note` | Move/rename + backlink rewrite |
| `vault_delete_note` | Soft delete to `.trash/` |
| `vault_read_section` | Read one heading section |
| `vault_get_note_with_links` | Note + all its linked notes |
| `vault_capture` | Classify and file text |
| `vault_triage_inbox` | Auto-classify and move inbox notes |
| `vault_periodic_note` | Open/create daily, weekly, or monthly note |
| `vault_batch` | Move/delete/update multiple notes in one call |
| `vault_sync` | Full vault index rebuild |
| `vault_embed_backlog` | Batch embed notes |
| `vault_find_connections` | Semantically similar unlinked notes |
| `vault_backup_db` | Timestamped SQLite backup |

## Configuration

See [docs/CONFIGURATION.md](docs/CONFIGURATION.md) for all environment variables.

Zero required configuration — `OBSIDIAN_VAULT_PATH` defaults to `~/Documents/obsidian`.

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Roadmap

See [docs/ROADMAP.md](docs/ROADMAP.md).

## Development

```bash
pnpm test              # run test suite (252+ tests)
pnpm test:coverage     # run with v8 coverage report
pnpm tsc --noEmit      # type check
pnpm lint              # biome linter
pnpm build             # compile to dist/
```

## License

MIT
