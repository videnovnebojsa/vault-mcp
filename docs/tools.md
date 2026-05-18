# Tool Reference

All tools accept an optional `vault` parameter (alphanumeric, hyphens, underscores) to target a named vault. Omit it to use the default vault.

Paths are always vault-relative (e.g. `Projects/my-note`), without the `.md` extension unless noted otherwise. Forward slashes only.

All responses use one of three envelopes:
- `{ ok: true, data: {...} }` — single-item result
- `{ ok: true, items: [...], total, hasMore, nextOffset? }` — paginated list
- `{ ok: false, error: { code, message }, isError: true }` — error

---

## Reading

### `vault_read_note`

Read a note's content, frontmatter, and metadata.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | string | yes | Vault-relative path without `.md` extension |
| `vault` | string | no | Target vault name |

```json
{ "path": "Projects/my-idea" }
```

Returns: `{ path, name, content, frontmatter, createdAt, updatedAt }`

---

### `vault_read_section`

Read only the content under a specific heading. Useful for large notes where you only need one section.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | string | yes | Vault-relative path |
| `heading` | string | yes | Exact heading text (case-insensitive) |
| `vault` | string | no | Target vault name |

```json
{ "path": "Projects/roadmap", "heading": "Q3 Goals" }
```

---

### `vault_read_note_with_links`

Read a note and all the notes it links to via `[[wikilinks]]` in a single call. Avoids multiple round-trips when you need the full link graph.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | string | yes | Vault-relative path |
| `max_links` | integer (0–20) | no | Max linked notes to fetch (default 10; 0 = root note only) |
| `include_content` | boolean | no | Include full content of linked notes (default false — returns path, name, frontmatter, and a snippet) |
| `snippet_length` | integer (0–2000) | no | Snippet length when `include_content=false` (default 200) |
| `vault` | string | no | Target vault name |

```json
{ "path": "Areas/health", "max_links": 5, "include_content": true }
```

---

## Writing

### `vault_write_note`

Create or overwrite a note.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | string | yes | Vault-relative path (creates parent folders if needed) |
| `content` | string | yes | Markdown content (max 1 MB) |
| `frontmatter` | object | no | YAML frontmatter fields to set |
| `vault` | string | no | Target vault name |

```json
{
  "path": "Projects/new-idea",
  "content": "# My idea\n\nDetails here.",
  "frontmatter": { "status": "draft", "tags": ["project"] }
}
```

---

### `vault_update_properties`

Merge frontmatter fields into an existing note without touching its content.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | string | yes | Vault-relative path |
| `properties` | object | yes | Fields to merge (existing fields not listed here are preserved) |
| `vault` | string | no | Target vault name |

```json
{ "path": "Projects/my-idea", "properties": { "status": "active", "priority": 1 } }
```

---

### `vault_capture`

Classify free-form text and file it into the appropriate folder automatically. Requires `ENABLE_CAPTURE_PIPELINE=true`.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `text` | string | yes | Text to capture (max 100 000 chars) |
| `vault` | string | no | Target vault name |

```json
{ "text": "Call Alice about the Berlin contract next Tuesday." }
```

Returns: the path where the note was filed, the category, confidence score, and suggested tags.

---

## Navigation

### `vault_list_folder`

List notes in a folder with lightweight metadata.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `folder` | string | yes | Vault-relative folder path |
| `recursive` | boolean | no | Recurse into subfolders (default true) |
| `limit` | integer (1–500) | no | Max results (default 100) |
| `offset` | integer | no | Pagination offset (default 0) |
| `modified_after` | string (ISO 8601) | no | Only return notes modified after this date |
| `vault` | string | no | Target vault name |

```json
{ "folder": "Projects", "recursive": false, "limit": 50 }
```

---

### `vault_list_tags`

List all tags with their note counts, sorted by frequency.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `limit` | integer (1–200) | no | Max results (default 50) |
| `offset` | integer | no | Pagination offset |
| `vault` | string | no | Target vault name |

---

### `vault_periodic_note`

Open or create a periodic note (daily, weekly, monthly).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `period` | `"daily"` \| `"weekly"` \| `"monthly"` | yes | Note period |
| `date` | string (ISO 8601) | no | Target date (default: today) |
| `create_if_missing` | boolean | no | Create if it doesn't exist (default true). Set false to check existence only. |
| `vault` | string | no | Target vault name |

```json
{ "period": "daily" }
```

Notes are created under `PERIODIC_NOTES_ROOT` (default `Journal`).

---

## Search

### `vault_search`

Search notes by content or filename. Supports three modes:
- `keyword` — SQLite FTS5 with Porter stemming
- `semantic` — cosine similarity over vector embeddings (requires `ENABLE_EMBEDDINGS=true`)
- `hybrid` — fused ranking of both (default when embeddings are enabled)

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | yes | Search query (max 500 chars) |
| `limit` | integer (1–200) | no | Max results (default 20) |
| `offset` | integer | no | Pagination offset |
| `folder` | string | no | Scope search to this folder |
| `mode` | `"keyword"` \| `"semantic"` \| `"hybrid"` | no | Search mode (default: `hybrid` if embeddings enabled, else `keyword`) |
| `tags` | string[] | no | Filter to notes with any of these tags |
| `type` | string | no | Filter to notes with this frontmatter `type` field |
| `modified_after` | string (ISO 8601) | no | Only notes modified after this date |
| `created_after` | string (ISO 8601) | no | Only notes created after this date |
| `vault` | string | no | Target vault name |

```json
{
  "query": "project retrospective",
  "mode": "hybrid",
  "tags": ["project"],
  "modified_after": "2024-01-01"
}
```

The hybrid blend is controlled by `HYBRID_ALPHA` (0 = pure semantic, 1 = pure keyword, default 0.5).

---

### `vault_find_connections`

Find semantically similar notes that don't already link to each other. Useful for discovering implicit relationships. Requires `ENABLE_EMBEDDINGS=true`.

**Single-note mode** — find notes similar to one specific note:

| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | string | no | Source note path. Omit for batch mode. |
| `limit` | integer (1–50) | no | Max suggestions per note (default 5) |
| `min_similarity` | float (0–1) | no | Minimum cosine similarity (default 0.75) |
| `vault` | string | no | Target vault name |

**Batch mode** — omit `path` to scan up to 200 embedded notes and return all connection pairs. May take several seconds on large vaults.

---

### `vault_classify`

Classify text using keyword heuristics and suggest a folder and title. Does not write anything to the vault.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `text` | string | yes | Text to classify (max 10 000 chars) |
| `vault` | string | no | Target vault name |

Returns: `{ category, confidence, suggested_folder, suggested_title, tags }`

---

## Maintenance

### `vault_move_note`

Move or rename a note. Automatically rewrites all `[[wikilinks]]` in other notes that referenced the old path.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `from_path` | string | yes | Current vault-relative path |
| `to_path` | string | yes | New vault-relative path |
| `update_backlinks` | boolean | no | Rewrite `[[wikilinks]]` in other notes (default true) |
| `confirm` | `true` | no | Required to overwrite if the destination already exists |
| `vault` | string | no | Target vault name |

---

### `vault_delete_note`

Delete a note. Soft-deletes to `.trash/` by default.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | string | yes | Vault-relative path |
| `trash` | boolean | no | Move to `.trash/` (default true). Set `false` for permanent deletion. |
| `confirm` | `true` | no | Required when `trash=false` to confirm permanent deletion |
| `vault` | string | no | Target vault name |

---

### `vault_batch`

Execute up to 100 move, delete, or update_properties operations in a single call. Processed sequentially and non-atomically — partial completion is possible when `continue_on_error=true`.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `operations` | array | yes | List of operations (1–100) |
| `continue_on_error` | boolean | no | Continue after a failure (default false) |
| `vault` | string | no | Target vault name |

Each operation object:

| Field | Type | Description |
|---|---|---|
| `type` | `"move"` \| `"delete"` \| `"update_properties"` | Operation type |
| `path` | string | Source path |
| `to_path` | string | Destination (required for `move`) |
| `properties` | object | Fields to merge (required for `update_properties`) |
| `trash` | boolean | For `delete`: soft-delete (default true) |
| `confirm` | `true` | For `delete` with `trash=false` |

---

### `vault_triage_inbox`

Classify notes in the inbox and auto-move high-confidence ones to their correct folder.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `dry_run` | boolean | no | Preview moves without writing (default false) |
| `auto_move_threshold` | float (0–1) | no | Confidence threshold for auto-move (default 0.8) |
| `suggest_threshold` | float (0–1) | no | Confidence threshold for suggestions (default 0.6) |
| `inbox_folder` | string | no | Inbox folder path (default `00_Inbox`) |
| `vault` | string | no | Target vault name |

Returns: `{ moved: [...], suggested: [...], skipped: [...] }`

---

### `vault_sync`

Trigger a full vault index rebuild. Returns sync statistics (files scanned, upserted, deleted, duration).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `vault` | string | no | Target vault name |

Under normal operation the file watcher keeps the index up to date incrementally. Use this if you made bulk external changes to the vault.

---

### `vault_embed_backlog`

Batch-embed notes that are missing or have stale embeddings. Requires `ENABLE_EMBEDDINGS=true`.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `max_notes` | integer (1–10 000) | no | Notes to embed per call (default 500) |
| `vault` | string | no | Target vault name |

Call repeatedly until `result.remaining === 0`.

---

### `vault_backup_db`

Create a timestamped backup of the vault search database and prune old backups.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `vault` | string | no | Target vault name |

Backups are written to `DB_BACKUP_DIR` (default `{vault}/.vault-backups`). The last `DB_BACKUP_MAX_KEEP` backups are retained.

---

### `vault_list_vaults`

List all configured vaults with their paths.

No parameters.

Returns: `{ vaults: [{ name, path }] }`
