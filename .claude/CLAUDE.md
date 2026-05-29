# CLAUDE.md

@.claude/rules/testing.md
@.claude/rules/architecture.md
@.claude/rules/behavior.md

## Commands

```bash
bun test --isolate                    # required - avoids env pollution between test files
bun test --isolate --reporter=dots    # compact output
bun test src/mcp/handlers/search.test.ts  # single file
bun test -t "test name"              # single test
bun run test:coverage                # 80% lines/functions threshold
bun run build                        # tsc → dist/
bun run dev                          # run without compile step
bun run lint                         # biome check
bun run format                       # biome format --write
bun run check:types                  # tsc --noEmit
bun run build:bun                    # compile standalone binary
```

`--isolate` is not optional. Without it, shared env state bleeds between test files and produces false passes/fails.

Lefthook: `biome check --write` at pre-commit; `tsc --noEmit` + `bun test --isolate` at pre-push. Commit messages must follow Conventional Commits (`feat:`, `fix:`, `chore:`, etc.).
