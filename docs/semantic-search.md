# Semantic & Hybrid Search

Keyword search matches exact words (and their stems). Semantic search understands *meaning* — so a query for "database performance" also surfaces notes about "query optimisation" or "index tuning" even if those exact words never appear in the query. Hybrid mode runs both and combines the scores, giving you precision *and* recall.

Keyword search works out of the box with no setup. Semantic and hybrid search require an embedding provider.

---

## Prerequisites

| Requirement | Notes |
|---|---|
| `ENABLE_EMBEDDINGS=true` | Must be set before starting the server |
| `EMBEDDING_API_KEY` | API key for your embedding provider (must be non-empty) |
| `EMBEDDING_ENDPOINT` | Base URL, e.g. `https://api.openai.com/v1` — required for embedding operations; the server starts without it but embedding calls will fail |

Both `ENABLE_EMBEDDINGS` **and** `EMBEDDING_API_KEY` must be set. Either alone is not enough to activate embeddings.

---

## Quick Start

### 1. Edit your config

```bash
# Open the config file
nano ~/.config/vault-mcp/.env
```

Add (or uncomment) the three required lines:

```ini
ENABLE_EMBEDDINGS=true
EMBEDDING_API_KEY=sk-...
EMBEDDING_ENDPOINT=https://api.openai.com/v1
```

### 2. Restart the server

**macOS:**
```bash
launchctl kickstart -k gui/$UID/com.vault-mcp
```

**Linux:**
```bash
systemctl --user restart vault-mcp
```

**Windows:**
```powershell
schtasks /End /TN vault-mcp; schtasks /Run /TN vault-mcp
```

### 3. Verify the server is ready

`3782` is only the default. If you chose a different port at install time, use the `MCP_PORT`
value from your `.env`:

```bash
PORT=$(grep '^MCP_PORT=' ~/.config/vault-mcp/.env | cut -d= -f2)
curl "http://localhost:${PORT:-3782}/ready"
# {"ready":true,"vaultCount":1}
# 503 while still indexing: {"ready":false,"vaultCount":1,"unreadyCount":1}
```

`/ready` returns 503 until the vault index finishes loading. Wait for `"ready":true` before proceeding.

> **If you query the wrong port you may get an answer anyway.** Another local service
> listening there will reply with its own error, not a connection refusal. `Cannot GET /ready`,
> an HTML error page, or any response that is not the JSON above means you are talking to
> something that is not vault-mcp. Confirm what holds the port with
> `lsof -nP -iTCP:<port> -sTCP:LISTEN` (macOS/Linux) or `netstat -ano | findstr :<port>` (Windows).

### 4. Run the embedding backfill

```json
{ "tool": "vault_embed_backlog", "max_notes": 250 }
```

Call this repeatedly until `remaining` reaches zero:

```
{ "max_notes": 250 }  →  { "remaining": 1074, "message": "Embedded 250 notes, 0 errors…" }
{ "max_notes": 250 }  →  { "remaining": 765,  "message": "Embedded 250 notes, 0 errors…" }
{ "max_notes": 250 }  →  { "remaining": 515,  "message": "Embedded 250 notes, 0 errors…" }
{ "max_notes": 250 }  →  { "remaining": 266,  "message": "Embedded 250 notes, 0 errors…" }
{ "max_notes": 250 }  →  { "remaining": 0,    "message": "Embedded 266 notes, 0 errors…" }
```

**Keep `max_notes` small enough to finish inside `TOOL_TIMEOUT_MS` (default 30000).** Embedding
runs at roughly 10 to 15 notes per second against OpenAI, so 250 lands around 17 to 24 seconds
and 500 overruns the limit and comes back as:

```json
{ "ok": false, "error": { "code": "TIMEOUT", "message": "Operation timed out after 30000ms" } }
```

That error is misleading. The server keeps embedding in the background, so the batch is not lost
and `remaining` still drops. You just lose the report. Either stay at 250, or raise
[`TOOL_TIMEOUT_MS`](configuration.md) and use bigger batches.

> Notes with no body are skipped and listed under `Failed:` with
> `skipped (empty content, consider deleting)`. They still count as embedded for progress
> purposes, but they reappear in the `Failed:` list on every future run until you delete them.

### 5. Verify hybrid search works

```json
{ "tool": "vault_search", "query": "your topic here", "mode": "hybrid" }
```

You should see results with semantic matches alongside keyword matches.

---

## Provider Guide

Any OpenAI-compatible `/v1/embeddings` endpoint works.

| Provider | `EMBEDDING_ENDPOINT` | Recommended model | Notes |
|---|---|---|---|
| [OpenAI](https://platform.openai.com) | `https://api.openai.com/v1` | `text-embedding-3-small` (default) | ~$0.02 per million tokens |
| [Ollama](https://ollama.com) (local) | `http://localhost:11434/v1` | `nomic-embed-text` | Free; runs on your machine. Set `EMBEDDING_API_KEY` to any non-empty string. |

To use a different model, set `EMBEDDING_MODEL` in your `.env`:

```ini
EMBEDDING_MODEL=text-embedding-3-large
```

> **Note:** Changing the model invalidates all existing embeddings. You will need to run a full backfill again (all notes are marked stale).

---

## How the Backfill Works

When you first enable embeddings, the FTS index already contains all your notes — but none of them have embedding vectors yet. `vault_embed_backlog` reads those stale notes from the index and sends them to the embedding API in batches.

**The file watcher updates the FTS index automatically but does NOT generate embeddings.** Notes you add or edit after the initial backfill accumulate as stale in the background. Run `vault_embed_backlog` periodically (e.g. once a day) to keep embedding coverage current.

**Check coverage without triggering a full run:**

```json
{ "tool": "vault_embed_backlog", "max_notes": 1 }
→ { "remaining": 47, "message": "Embedded 1 notes, 0 errors…" }
```

The `remaining` field tells you how many notes are missing or have stale embeddings. A `remaining` of 0 means you're fully up to date.

---

## Tuning HYBRID_ALPHA

`HYBRID_ALPHA` controls how much weight keyword matching gets versus semantic matching in hybrid mode.

Set it in `.env`:

```ini
HYBRID_ALPHA=0.5   # default
```

| Value | Effect | When to use |
|---|---|---|
| `0.5` | Equal weight (default) | Good starting point for most vaults |
| `0.3` | Semantic-leaning | Concept and topic searches; tolerates synonyms and paraphrasing |
| `0.7` | Keyword-leaning | Exact terms, code snippets, proper nouns |
| `0` | Pure semantic | Ignores exact-word matching entirely |
| `1` | Pure keyword | Vector score zeroed in fusion; embedding API still called per query |

Under the hood: `score = alpha × BM25_normalized + (1 − alpha) × cosine_similarity`. Notes found by only one method still appear — the other side contributes 0 to the fused score.

---

## Search Modes Reference

| `mode` | Requires embeddings | Behavior when embeddings are off |
|---|---|---|
| _(omitted)_ | No | Automatically uses `"keyword"` — no error |
| `"keyword"` | No | Always works |
| `"hybrid"` | Yes | Returns `MODE_UNAVAILABLE` error if embeddings disabled |
| `"semantic"` | Yes | Returns `MODE_UNAVAILABLE` error if embeddings disabled |

**Key point:** omitting `mode` never errors — it degrades gracefully to `"keyword"`. Explicitly passing `"hybrid"` or `"semantic"` fails fast if embeddings are not configured. This makes it safe to build queries without a `mode` field, and to use explicit modes only when you need to enforce a specific strategy.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Results look keyword-only after enabling | Server not restarted after config change | Restart the service; confirm both `ENABLE_EMBEDDINGS=true` and `EMBEDDING_API_KEY` are set |
| `vault_embed_backlog` returns `NOT_ENABLED` | Missing env var | Verify both `ENABLE_EMBEDDINGS` and `EMBEDDING_API_KEY` are present in `.env` |
| `remaining` is not decreasing | Wrong API key, quota exceeded, or network error | Check server logs for `embed-provider` errors (see below) |
| `vault_embed_backlog` returns `TIMEOUT` | `max_notes` too large to finish inside `TOOL_TIMEOUT_MS` | Lower `max_notes` to ~250, or raise `TOOL_TIMEOUT_MS`. Work continues server-side, so re-check `remaining` before retrying |
| Results feel stale after adding notes | File watcher doesn't auto-embed | Run `vault_embed_backlog` again |
| `MODE_UNAVAILABLE` error on `vault_search` | Embeddings not enabled | Complete the Quick Start steps above. Check `ENABLE_EMBEDDINGS` and `EMBEDDING_API_KEY` in `.env`, then restart |
| `/ready` returns HTML, `Cannot GET /ready`, or an unexpected shape | You are querying a port another service holds | Read `MCP_PORT` from `.env` and retry against that port |
| All embeddings suddenly stale | `EMBEDDING_MODEL` was changed | Run a full backfill — old vectors are incompatible with the new model |

**Viewing server logs:**

```bash
# macOS
tail -f ~/Library/Logs/vault-mcp/vault-mcp.err

# Linux
journalctl --user -u vault-mcp -f
```

Look for lines containing `embed-provider` — they show the HTTP status and error message from the embedding API.
