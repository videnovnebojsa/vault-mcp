# Configuration

All configuration is via environment variables. Copy `.env.example` to `.env` and edit.

## Required

| Variable | Default | Description |
|---|---|---|
| `OBSIDIAN_VAULT_PATH` | `~/Documents/obsidian` | Path to your Obsidian vault directory |

## HTTP Server

| Variable | Default | Description |
|---|---|---|
| `MCP_PORT` | `3782` | Port for the HTTP MCP server |
| `MCP_HOST` | `127.0.0.1` | Bind address (use `0.0.0.0` for network access) |
| `MCP_API_KEY` | _(empty)_ | Bearer token for auth; leave empty for local-only use |

## Search Index

| Variable | Default | Description |
|---|---|---|
| `MEMORY_DB_PATH` | `{vault}/.vault-search.db` | Path to SQLite FTS5 search index |

## Vector Embeddings

Requires an OpenAI-compatible embedding endpoint.

| Variable | Default | Description |
|---|---|---|
| `ENABLE_EMBEDDINGS` | `false` | Set `true` to enable semantic search |
| `EMBEDDING_API_KEY` | _(empty)_ | API key for embedding provider |
| `EMBEDDING_ENDPOINT` | _(empty)_ | Base URL, e.g. `https://api.openai.com/v1` |
| `EMBEDDING_MODEL` | `text-embedding-3-small` | Model name |
| `HYBRID_ALPHA` | `0.5` | Search blend: `0` = pure semantic, `1` = pure keyword |
| `EMBED_BATCH_SIZE` | `20` | Notes per embedding batch |
| `EMBED_INTERVAL_MINUTES` | `30` | Background embedding interval |

## Capture Pipeline

| Variable | Default | Description |
|---|---|---|
| `ENABLE_CAPTURE_PIPELINE` | `false` | Set `true` to enable `vault_capture` tool |
| `LOG_RAW_INPUT` | `false` | Log raw capture input for debugging |

## Periodic Notes

| Variable | Default | Description |
|---|---|---|
| `PERIODIC_NOTES_ROOT` | `Journal` | Root folder for periodic notes (daily/weekly/monthly) |

## Backup

| Variable | Default | Description |
|---|---|---|
| `ENABLE_DB_BACKUP` | `true` | Enable automatic database backups |
| `DB_BACKUP_DIR` | `{vault}/.vault-backups` | Backup directory |
| `DB_BACKUP_MAX_KEEP` | `5` | Number of backups to retain |
| `DB_BACKUP_INTERVAL_HOURS` | `24` | Backup interval |

## File Watcher

| Variable | Default | Description |
|---|---|---|
| `ENABLE_FILE_WATCHER` | `true` | Watch vault for file changes and auto-update index |
| `FILE_WATCHER_DEBOUNCE_MS` | `300` | Debounce delay for file change events |

## Logging

| Variable | Default | Description |
|---|---|---|
| `LOG_LEVEL` | `info` | Log level: `debug`, `info`, `warn`, `error` |
| `LOG_FORMAT` | `text` | Log format: `text` or `json` |
| `ALERT_WEBHOOK_URL` | _(empty)_ | POST alert payloads to this URL on errors |
