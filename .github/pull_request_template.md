## Summary

<!-- What does this PR do? One or two sentences. -->

## Changes

<!-- Bullet list of the key changes. -->

-

## Motivation

<!-- Why is this change needed? Link to an issue if applicable. Closes #XXX -->

## Testing

<!-- How was this tested? Check all that apply. -->

- [ ] Unit tests added / updated
- [ ] `bun test --isolate` passes locally
- [ ] `bun run check:types` passes
- [ ] `bun run lint` passes
- [ ] Tested manually (describe below if so)

## Checklist

- [ ] Follows the layer invariants in `CLAUDE.md` (transport → tools → handlers → services → utils)
- [ ] No `console.error` — uses structured `logger` from `src/utils/logger.ts`
- [ ] New tools use `successResult` / `listResult` / `errorResult` from `src/mcp/format.ts`
- [ ] `toClientNote()` used before any `VaultNote` reaches a response
- [ ] `VAULT_FOLDERS` constants used — no hardcoded folder strings
- [ ] Commit messages follow Conventional Commits (`feat:`, `fix:`, `chore:`, etc.)
