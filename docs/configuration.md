# Configuration

All configuration is via environment variables. Zero required configuration — the defaults work for a local single-vault setup.

## Vault Paths

| Variable | Default | Description |
|---|---|---|
| `OBSIDIAN_VAULT_PATH` | `~/Documents/obsidian` | Path to your primary Obsidian vault |
| `VAULT_PATHS` | _(empty)_ | Named additional vaults — semicolon-separated `name:path` pairs, e.g. `work:~/vaults/work;archive:~/vaults/archive` |
| `MEMORY_DB_PATH` | `{vault}/.vault-search.db` | Path to the SQLite search index (per vault) |

## HTTP Server

| Variable | Default | Description |
|---|---|---|
| `MCP_PORT` | `3782` | Port for the HTTP MCP server |
| `MCP_HOST` | `127.0.0.1` | Bind address (`0.0.0.0` to expose on the network) |
| `MCP_API_KEY` | _(empty)_ | Bearer token for auth; leave empty for local-only use |
| `MCP_HTTP_BODY_LIMIT_BYTES` | `1048576` | Max request body size in bytes |
| `MCP_MAX_SESSIONS` | `100` | Max concurrent HTTP sessions |
| `MCP_SESSION_IDLE_MS` | `1800000` | Session idle timeout in milliseconds (30 min) |

## Vector Embeddings

Requires an OpenAI-compatible embedding endpoint. See [Semantic & Hybrid Search](semantic-search.md) for setup steps, provider recommendations, and `HYBRID_ALPHA` tuning guidance.

| Variable | Default | Description |
|---|---|---|
| `ENABLE_EMBEDDINGS` | `false` | Set `true` to enable semantic and hybrid search |
| `EMBEDDING_API_KEY` | _(empty)_ | API key for the embedding provider |
| `EMBEDDING_ENDPOINT` | _(empty)_ | Base URL, e.g. `https://api.openai.com/v1` |
| `EMBEDDING_MODEL` | `text-embedding-3-small` | Model name |
| `HYBRID_ALPHA` | `0.5` | Search blend: `0` = pure semantic, `1` = pure keyword |
| `EMBED_BATCH_SIZE` | `20` | Notes per embedding batch |
| `QUERY_EMBEDDING_CACHE_MAX` | `128` | Max query embeddings to keep in memory cache |

## Capture Pipeline

| Variable | Default | Description |
|---|---|---|
| `ENABLE_CAPTURE_PIPELINE` | `false` | Set `true` to enable the `vault_capture` tool |
| `CLASSIFY_RULES_PATH` | _(empty)_ | Path to a JSON file with custom classification rules |
| `LOG_RAW_INPUT` | `false` | Log raw capture input for debugging |

Custom classification rules file format:

```json
{
  "project": { "keywords": ["roadmap", "milestone"], "folder": "Projects" },
  "admin":   { "keywords": ["invoice", "contract"],  "folder": "Admin" }
}
```

## Vault Folder Names

Folder names used by the capture pipeline and inbox triage. Override any of these to match your vault's existing structure.

| Variable | Default | Description |
|---|---|---|
| `VAULT_FOLDER_INBOX` | `00_Inbox` | Low-confidence captures and unclassified notes |
| `VAULT_FOLDER_PROJECTS` | `10_Projects` | Project captures |
| `VAULT_FOLDER_ZETTELKASTEN` | `30_Zettelkasten` | Idea / atomic note captures |
| `VAULT_FOLDER_ARTEFACTS` | `35_Artefacts` | Excluded from connection detection |
| `VAULT_FOLDER_CANVASES` | `36_Canvases` | Excluded from connection detection |
| `VAULT_FOLDER_TEMPLATES` | `50_Templates` | Excluded from connection detection |
| `VAULT_FOLDER_AI_LOGS` | `70_AI_Logs` | Classification audit logs written here |
| `VAULT_FOLDER_PEOPLE` | `80_People` | Person captures |
| `VAULT_FOLDER_ADMIN` | `90_Admin` | Admin captures |
| `VAULT_FOLDER_ARCHIVE` | `99_Archive` | Excluded from connection detection |

Run `bun run configure -- --section vault-folders` to configure these interactively.

## Periodic Notes

| Variable | Default | Description |
|---|---|---|
| `PERIODIC_NOTES_ROOT` | `Journal` | Root folder for daily, weekly, and monthly notes |

## Backup

| Variable | Default | Description |
|---|---|---|
| `ENABLE_DB_BACKUP` | `true` | Enable automatic database backups |
| `DB_BACKUP_DIR` | `{vault}/.vault-backups` | Backup directory |
| `DB_BACKUP_MAX_KEEP` | `5` | Number of backups to retain |

## File Watcher

| Variable | Default | Description |
|---|---|---|
| `ENABLE_FILE_WATCHER` | `true` | Watch vault for file changes and update the index incrementally |
| `FILE_WATCHER_DEBOUNCE_MS` | `300` | Debounce delay for file change events |

## Access Control

| Variable | Default | Description |
|---|---|---|
| `VAULT_ALLOW_PATHS` | _(empty)_ | Comma-separated list of vault-relative paths that may be accessed. All others are denied. |
| `VAULT_DENY_PATHS` | _(empty)_ | Comma-separated list of vault-relative paths that are always denied. Applied after allowlist. |

## Logging & Monitoring

| Variable | Default | Description |
|---|---|---|
| `LOG_LEVEL` | `info` | Log level: `debug`, `info`, `warn`, `error` |
| `LOG_FORMAT` | `text` | Log format: `text` or `json` |
| `ALERT_WEBHOOK_URL` | _(empty)_ | POST alert payloads to this URL on errors (must be http/https) |
| `ENABLE_OTEL` | `false` | Emit OpenTelemetry spans per tool call |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | _(empty)_ | OTLP exporter endpoint (used when `ENABLE_OTEL=true`) |

## Advanced

| Variable | Default | Description |
|---|---|---|
| `TOOL_TIMEOUT_MS` | `30000` | Max milliseconds a tool call may run before being aborted (0 = disabled) |
