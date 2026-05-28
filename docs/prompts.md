# Example Prompts

A cheat-sheet of natural-language prompts you can send to any Claude agent connected to vault-mcp. Each prompt maps to a specific tool — the agent picks the right one automatically based on your intent.

Paths in examples follow the default Zettelkasten folder layout. Swap them for your own folder names.

---

## Reading notes

### `vault_read_note`

- "Show me the note at Projects/website-redesign"
- "Read my note on async Rust patterns"
- "What's in 00_Inbox/meeting-notes-2026-05-20?"
- "Open Resources/books/thinking-fast-and-slow"

> Tip: Use `vault_read_note_with_links` when you want the linked context alongside the note.

---

### `vault_read_section`

- "Show me just the Decision section of Projects/db-schema"
- "What's under the ## Next Steps heading in my weekly review?"
- "Read the Background section from Resources/rfc-001"
- "Pull out the Installation section of Projects/vault-mcp/readme-draft"

> The heading match is case-insensitive. Only content under that heading (until the next same-level heading) is returned.

---

### `vault_read_note_with_links`

- "Read Projects/architecture-rfc and include all its linked notes"
- "Show me the onboarding doc and every note it references"
- "Open my book summary on Systems Thinking and pull in the linked concept notes too"
- "Read 02_Notes/zettelkasten-method along with up to 15 of its backlinks"

> Returns the note plus resolved `[[wikilink]]` targets. Use `max_links` to control how many linked notes are fetched (default 10).

---

## Writing & editing

### `vault_write_note`

- "Create a new note at Projects/q3-planning with this outline: ..."
- "Write a note called Resources/tools/obsidian-tips with the following content: ..."
- "Save this meeting summary to 00_Inbox/standup-2026-05-27"
- "Overwrite Projects/budget-draft with the updated version below"

> Creates parent folders automatically. If the note already exists it is overwritten — use `vault_update_properties` to change only frontmatter.

---

### `vault_update_properties`

- "Mark Projects/website-redesign as status: done"
- "Add the tag #reviewed to Resources/books/atomic-habits"
- "Set priority: high and due: 2026-06-01 on 00_Inbox/task-follow-up"
- "Update the author field in Resources/articles/the-pragmatic-programmer to 'Hunt & Thomas'"

> Only frontmatter fields are changed; the note body is left untouched.

---

## Search & discovery

### `vault_search`

- "Search my vault for notes on distributed tracing"
- "Find everything I've written about Rust ownership"
- "Look for notes tagged #project created after 2026-01-01"
- "Search for meeting notes in the 00_Inbox folder from last week"
- "Find notes of type 'book-summary' about productivity"
- "Hybrid search for 'event sourcing CQRS' — I want both keyword and semantic matches"

> Supports three modes: `keyword` (FTS5), `semantic` (embeddings), `hybrid` (default when embeddings are enabled). Filter by `folder`, `tags`, `type`, `modified_after`, or `created_after`.

---

### `vault_find_connections`

- "Find notes similar to Projects/architecture-rfc that aren't already linked to it"
- "What notes are semantically related to Resources/papers/attention-is-all-you-need?"
- "Surface hidden connections for 02_Notes/zettelkasten-method"
- "Scan my whole vault for unlinked note pairs that should be connected"

> Requires embeddings to be enabled (`ENABLE_EMBEDDINGS=true`). Omit `path` to run a full-vault connection scan.

---

### `vault_classify`

- "What category does this text belong in: [paste text]"
- "Where would you file a note about GraphQL schema design?"
- "Classify this book highlight — is it a resource, a permanent note, or a fleeting thought?"
- "What folder should I put a note on Kubernetes networking into?"

> Classify-only — nothing is written. Use `vault_capture` to classify *and* file in one step.

---

## Capture & triage

### `vault_capture`

- "Capture this idea: use SQLite WAL mode for concurrent readers"
- "File this article summary into my vault: [paste content]"
- "Add this fleeting note to my inbox: 'look into property-based testing for the parser'"
- "Capture and classify: [paste raw meeting notes]"

> Requires `ENABLE_CAPTURE_PIPELINE=true`. The pipeline classifies the text and writes it to the appropriate folder automatically.

---

### `vault_triage_inbox`

- "Triage my inbox"
- "Auto-move high-confidence inbox notes to their proper folders"
- "Preview what would happen if I triaged my inbox — don't move anything yet"
- "Triage inbox notes with a confidence threshold of 0.9 for auto-move"
- "Process all inbox notes and move anything above 85% confidence"

> Use `dry_run: true` to preview moves without committing. Default auto-move threshold is 0.8.

---

## Organisation

### `vault_move_note`

- "Move Projects/old-name to Projects/new-name"
- "Rename 02_Notes/fleeting-idea to 02_Notes/concept-event-sourcing"
- "Move Resources/articles/draft to Archive/articles/draft and update all links"
- "Relocate everything in 00_Inbox/project-x to Projects/project-x"

> Wikilink references across the vault are rewritten automatically unless you pass `update_backlinks: false`.

---

### `vault_delete_note`

- "Delete 00_Inbox/temp-scratch — send it to trash"
- "Permanently delete Archive/old-project-notes (I'm sure)"
- "Soft-delete Projects/cancelled-feature"
- "Move Resources/outdated-tutorial to the trash folder"

> Notes are soft-deleted to `.trash/` by default. Permanent deletion requires explicit confirmation.

---

### `vault_batch`

- "Move all three of these notes to Archive: [list paths]"
- "Delete 00_Inbox/note-a, 00_Inbox/note-b, and 00_Inbox/note-c in one go"
- "Update the status to 'archived' on these five project notes: [list paths]"
- "Rename Projects/alpha to Projects/alpha-v1, Projects/beta to Projects/beta-v1, and mark both as status: legacy"
- "Move and update properties for this batch of notes: ..."

> Processes up to 100 operations sequentially in one call. Not atomic — pass `continue_on_error: true` to process the rest if one fails.

---

### `vault_list_folder`

- "List all notes in my Projects folder"
- "What's in 00_Inbox?"
- "Show me notes in Resources/books modified after 2026-01-01"
- "List everything in Archive recursively"
- "What notes are in 02_Notes? Include their tags."

> Returns lightweight metadata (path, name, tags, type, dates). For full content, follow up with `vault_read_note`.

---

### `vault_list_tags`

- "What tags do I use most in my vault?"
- "Show me all my tags with their note counts"
- "List the top 20 tags in my vault"
- "What are my most-used tags?"

---

### `vault_list_vaults`

- "Which vaults do you have access to?"
- "List all my configured vaults"
- "What vault names are available?"

---

## Periodic notes

### `vault_periodic_note`

- "Open today's daily note"
- "Create today's daily note if it doesn't exist"
- "Show me this week's weekly review note"
- "Open the monthly note for May 2026"
- "What's in yesterday's daily note?"
- "Create the weekly note for the week of 2026-05-20"

> Looks for notes under `PERIODIC_NOTES_ROOT` (default `Journal`). Creates them from your template if missing and `create_if_missing` is true (the default).

---

## Maintenance

### `vault_sync`

- "Rebuild the search index"
- "Re-sync my vault"
- "The index seems stale — trigger a full sync"
- "Reindex everything in my vault"

> Runs a full incremental sync. Errors if a sync is already in progress.

---

### `vault_embed_backlog`

- "Embed any notes that are missing vector embeddings"
- "Process the embedding backlog"
- "Run the embedding backfill — there are notes without vectors"
- "Keep embedding until there are no more notes in the backlog"

> Requires `ENABLE_EMBEDDINGS=true`. Call repeatedly until `remaining` reaches 0. Processes up to `max_notes` per call (default 500).

---

### `vault_backup_db`

- "Back up the search index"
- "Take a snapshot of the SQLite database"
- "Create a vault database backup now"
- "Backup the vault index before I run a bulk operation"

> Requires backup to be enabled in config (`DB_BACKUP_DIR`). Old backups are pruned automatically to stay within `DB_BACKUP_MAX_KEEP`.
