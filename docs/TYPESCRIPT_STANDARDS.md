# TypeScript Standards

Opinionated decisions for this project. One choice per category — no alternatives listed.

> Full research: `40_Resources/AI/TypeScript/` in the vault.

---

## Toolchain

| Category | Tool | Notes |
|---|---|---|
| Linting (pre-commit) | **oxlint** | Zero-config, 50-100x faster than ESLint |
| Linting (CI) | **@typescript-eslint/strict-type-checked** | ESLint v9 flat config |
| Formatting | **Biome** | Unified with lint in `biome.json` |
| Type-checking | **tsc --noEmit** | Always full project, never staged files only |
| Dead code | **knip** | `npx knip` in CI |
| Type coverage | **type-coverage** | Gate: `--at-least 95` |

### tsconfig baseline

```jsonc
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noPropertyAccessFromIndexSignature": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "noImplicitReturns": true,
    "forceConsistentCasingInFileNames": true,
    "isolatedModules": true
  }
}
```

---

## Testing

| Category | Choice | Notes |
|---|---|---|
| Test runner | **vitest** | v8 coverage provider |
| Coverage thresholds | lines 80%, branches 70% | Enforced in CI |
| Mutation testing | **Stryker** (critical paths only) | `break: 50` threshold |

```typescript
// vitest.config.ts
coverage: {
  provider: 'v8',
  thresholds: { lines: 80, functions: 80, branches: 70, statements: 80 },
  reporter: ['text', 'html', 'json-summary'],
}
```

---

## Security

| Layer | Tool | When |
|---|---|---|
| Secrets detection | **Gitleaks** | Pre-commit |
| Secrets verification | **TruffleHog** `--only-verified` | CI |
| Dependency audit | `pnpm audit --audit-level=high` | Every PR |
| Supply chain | **Socket.dev** | CI |
| SAST | **CodeQL** `javascript-typescript` | Weekly on main |
| Open source | **OSSF Scorecard** | Always-on GitHub Action |
| Lockfile | `pnpm install --frozen-lockfile` | All CI jobs |

---

## CI Pipeline (GitHub Actions)

### Structure

```
Stage 1 (parallel):  typecheck | lint
Stage 2 (parallel):  test + coverage | pnpm audit   [needs stage 1]
Stage 3:             build → release on main          [needs stage 2]
CodeQL:              weekly + main push (separate workflow)
```

### Caching

```yaml
- uses: pnpm/action-setup@v4
  with: { version: 10 }
- uses: actions/setup-node@v4
  with: { node-version: 22, cache: 'pnpm' }
- run: pnpm install --frozen-lockfile
```

### Concurrency (cancel stale PR runs, never cancel main)

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.head_ref || github.run_id }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
```

### Coverage reporting (GitHub-native, no Codecov account needed)

```yaml
- uses: davelosert/vitest-coverage-report-action@v2
  if: always()
  with:
    json-summary-path: coverage/coverage-summary.json
```

---

## Pre-Commit Hooks (Lefthook)

```yaml
# lefthook.yml
pre-commit:
  parallel: true
  commands:
    eslint:
      run: npx eslint {staged_files} --fix && git add {staged_files}
      glob: '*.{ts,tsx,js,jsx}'
    prettier:
      run: npx prettier --write {staged_files} && git add {staged_files}
      glob: '*.{ts,tsx,js,jsx,json,css,md,yml}'

commit-msg:
  commands:
    commitlint:
      run: npx commitlint --edit {1}

pre-push:
  commands:
    typecheck:
      run: pnpm tsc --noEmit
    test:
      run: pnpm test
```

---

## Development Workflow

| Category | Choice |
|---|---|
| Commit format | Conventional Commits (`feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `ci`) |
| Commit enforcement | commitlint + `@commitlint/config-conventional` |
| Release (single package) | semantic-release |
| Release (monorepo) | Changesets |
| Dependency updates | Renovate (PR grouping + automerge devDeps) |
| Monorepo build | Turborepo → Nx when architectural guardrails needed |
| PR automation | Danger.js (size limit, changelog, test file checks) |

---

## Agent Skills

Install these when working with Claude Code on this repo:

```bash
# Architecture & design
npx skills add mattpocock/skills/improve-codebase-architecture
npx skills add mattpocock/skills/grill-with-docs
npx skills add obra/superpowers/brainstorming

# Development workflow
npx skills add obra/superpowers/writing-plans
npx skills add obra/superpowers/subagent-driven-development
npx skills add obra/superpowers/finishing-a-development-branch

# Testing
npx skills add mattpocock/skills/tdd
npx skills add obra/superpowers/verification-before-completion

# Code review
npx skills add mattpocock/skills/grill-me
npx skills add obra/superpowers/requesting-code-review
npx skills add obra/superpowers/receiving-code-review

# Debugging
npx skills add obra/superpowers/systematic-debugging

# Safety
npx skills add mattpocock/skills/git-guardrails-claude-code
```
