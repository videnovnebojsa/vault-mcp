# Contributing to vault-mcp

Thanks for taking the time to contribute. This document covers everything you need to go from zero to a merged pull request.

## Table of Contents

- [Reporting bugs](#reporting-bugs)
- [Suggesting features](#suggesting-features)
- [Development setup](#development-setup)
- [Making changes](#making-changes)
- [Pull request checklist](#pull-request-checklist)
- [Code conventions](#code-conventions)

---

## Reporting bugs

Open a [bug report issue](https://github.com/videnovnebojsa/vault-mcp/issues/new?template=bug_report.md). Include:

- What you did, what you expected, what happened instead
- Your OS, Bun version (`bun --version`), and how you connect (Claude Code / Claude Desktop / other)
- Relevant logs — the server writes structured JSON logs; pipe them through `jq` if needed

For security vulnerabilities, **do not open a public issue** — see [SECURITY.md](.github/SECURITY.md).

## Suggesting features

Open a [feature request issue](https://github.com/videnovnebojsa/vault-mcp/issues/new?template=feature_request.md). Describe the use case first, then your proposed solution. If you're not sure whether something fits the project scope, open a Discussion first.

---

## Development setup

**Prerequisites:** [Bun](https://bun.sh) 1.3+

```bash
git clone https://github.com/videnovnebojsa/vault-mcp
cd vault-mcp
bun install
```

### Running the server locally

```bash
bun run dev          # run without compiling
bun run configure    # interactive config editor
```

### Running tests

```bash
bun test --isolate                          # full suite (always use --isolate)
bun test --isolate --reporter=dots          # compact output
bun test src/mcp/handlers/capture.test.ts  # single file
bun test -t "should classify inbox note"   # single test by name
bun run test:coverage                       # coverage report (≥80% required)
```

> **Why `--isolate`?** Each test file runs in its own Bun worker to prevent environment variable pollution between files. Omitting it will cause flaky failures.

### Linting and type-checking

```bash
bun run lint          # biome check
bun run format        # biome format --write (auto-fix)
bun run check:types   # tsc --noEmit
```

These also run automatically via Lefthook at pre-commit (`biome check --write` on staged files) and pre-push (`tsc` + full test suite). If a pre-push hook fails, fix the issue rather than bypassing the hook.

---

## Making changes

1. **Fork and branch** off `main`. Use a descriptive branch name:
   - `feat/vault-resources-mcp` for new features
   - `fix/search-pagination-off-by-one` for bug fixes
   - `chore/update-deps` for maintenance

2. **Keep PRs focused.** One logical change per PR. If you find an unrelated bug while working, open a separate issue or PR.

3. **Follow the layer boundaries** (see [Architecture](docs/contributing/architecture.md)):
   - Handlers (`mcp/handlers/`) contain business logic, return `ToolResult`, never catch errors
   - Services (`vault/`, `search/`, `capture/`) are called by handlers
   - `mcp/tools.ts` is the only wiring point — don't add I/O wiring elsewhere
   - Throw `VaultError` with a `VaultErrorCode`; `wrapHandler` handles the rest

4. **Write tests.** Handler tests use `MockVaultRepository` from `mcp/handlers/test-helpers.ts` and run against in-memory SQLite — no real filesystem. Store tests use `new VaultSearchStore()` with `:memory:`. Coverage must stay ≥ 80%.

5. **Add or update docs** if your change affects user-facing behavior (new tool, config option, changed response shape).

---

## Pull request checklist

Before opening a PR, confirm:

- [ ] `bun test --isolate` passes
- [ ] `bun run check:types` passes
- [ ] `bun run lint` passes (or `bun run format` cleaned it up)
- [ ] New behavior is covered by tests
- [ ] Commit messages follow [Conventional Commits](#commit-messages)

---

## Code conventions

### Commit messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add vault_resources MCP resource endpoints
fix: correct pagination offset in hybrid search
chore: bump @modelcontextprotocol/sdk to 1.13
docs: clarify VAULT_ALLOW_PATHS behaviour
```

Enforced by commitlint at commit time. Merge commits and revert commits are exempt.

### TypeScript

- Strict mode is on — no `any`, no `ts-ignore` without a comment explaining why
- Prefer explicit return types on exported functions
- Response shapes come from `mcp/format.ts` helpers (`successResult`, `listResult`, `errorResult`) — don't hand-roll envelopes

### Error handling

- Throw `VaultError` (from `utils/errors.ts`) with an appropriate `VaultErrorCode`
- Never `console.error` — use the structured `logger`
- Never catch inside a handler unless you're intentionally swallowing a per-item failure (see `note-with-links.ts` for the pattern)

### Folder name constants

Vault folder names live in `src/config/folders.ts` (`VAULT_FOLDERS`). Use those constants instead of string literals.
