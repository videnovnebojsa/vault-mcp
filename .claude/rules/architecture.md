# Architecture Rules

## Layer invariants (strict top-down)

```
MCP Transport (http.ts, bridge/)
    └── Tool registration (mcp/tools.ts)
        └── Handlers (mcp/handlers/*.ts)
            └── Services (vault/, search/, capture/)
                └── Utilities (utils/)
```

Handlers may not import from transport or `tools.ts`. Services may not import from handlers or transport. Violations break the dependency graph.

## Error handling

**Handlers must NOT catch errors** unless they are intentionally swallowing a per-item failure and continuing (e.g. the per-link fallback in `note-with-links.ts`). `wrapHandler` in `tools.ts` is the single error boundary — it maps `VaultError` codes to `errorResult` and records spans. Catching inside a handler bypasses telemetry.

Never use `console.error`. Use the structured `logger` from `src/utils/logger.ts`.

## Vault resolution

`getSvc(args.vault)` inside `tools.ts` is the **only** vault resolution point. It resolves the vault name, waits on `bootReady`, and throws `VaultError(BOOT_FAILED)` on failure. Never call `vaultManager.getServices()` directly from handlers.

## Response envelope

All handlers return one of three shapes via helpers in `src/mcp/format.ts`:

- `successResult(data)` → `{ ok: true, data }`
- `listResult(items, pagination)` → `{ ok: true, items, total, hasMore, nextOffset? }`
- `errorResult(code, message)` → `{ ok: false, error: { code, message } }` with `isError: true`

`code` must be a `VaultErrorCode` string from `src/utils/errors.ts` — MCP clients use it for flow control. Never return ad-hoc JSON shapes.

**`absPath` must never reach MCP clients.** Use `toClientNote(note)` from `src/mcp/format.ts` to strip it before including a `VaultNote` in any response.

## Key constants

Vault folder names live in `src/config/folders.ts` (`VAULT_FOLDERS`). Never use string literals like `"00_Inbox"` — use `VAULT_FOLDERS.INBOX`, `VAULT_FOLDERS.ARCHIVE`, etc.

## Deprecated tool alias

`vault_get_note_with_links` is a deprecated alias for `vault_read_note_with_links`. The span is intentionally recorded under the old name so `[API-03]` metrics can track migration progress. When summing canonical tool totals, add both span names together. Do not remove the alias or change its span name.

## Health vs ready

`/health` always returns 200 (liveness). `/ready` returns 503 until all vault `bootReady` promises resolve — use `/ready` for readiness probes, not `/health`.

## Server configuration

Connect via the HTTP MCP server endpoint defined in `.mcp.json`, or the stdio bridge entrypoint in `package.json`. Both are documented there — don't hardcode ports or paths.

The `--alias` CLI flag is not supported. Configure vault names via environment variables (`VAULT_DEFAULT_PATH`, `VAULT_<NAME>_PATH`) instead.
