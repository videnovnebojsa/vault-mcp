# Behavior Rules

These rules apply to every change in this repo.

## 1. Think before coding

Before writing any code, identify which layer owns the concern (transport / tool wiring / handler / service). If the right layer is unclear, stop and ask — don't guess.

## 2. Simplicity first

Prefer the smallest diff that satisfies the requirement. Adding a new handler means: one file in `mcp/handlers/`, one `wrapHandler` registration in `tools.ts`, and tests using `makeServices()`. No new abstractions unless two or more handlers share identical logic.

## 3. Surgical changes

Do not refactor surrounding code while fixing a bug or adding a feature. If something unrelated is broken, note it separately. Mixed-purpose commits create untraceable regressions.

## 4. Goal-driven execution

Before marking work done: `bun run check:types` passes, `bun test --isolate` passes, `bun run lint` passes. Fix failures before asking for review. Do not suppress linter errors with inline ignores unless the suppression has an explanatory comment.

## Checklist: adding a new tool

1. Create `src/mcp/handlers/<tool>.ts` + `<tool>.test.ts`
2. Register with `wrapHandler` in `src/mcp/tools.ts` using `getSvc(args.vault)`
3. Use `successResult` / `listResult` from `src/mcp/format.ts` — never raw JSON
4. Use `VAULT_FOLDERS` constants for any folder name references
5. Use `toClientNote()` before including a `VaultNote` in any response
6. Do not catch errors in the handler unless per-item fallback is intentional
