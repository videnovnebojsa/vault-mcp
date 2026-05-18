# Bun Full-Runtime Migration

> Status: Planned  
> Estimated effort: 3–4 focused days  
> Prerequisite: No active users — clean slate migration

---

## Goal

Replace the current **dual-runtime setup** (Node.js for dev/test + Bun for binary compilation) with **Bun as the sole runtime** across development, testing, and production. This eliminates the `sqlite-shim` abstraction layer, removes `better-sqlite3`, and closes the untestable code path flagged in QA-01.

---

## Why Now

The project currently ships via two runtimes:

- **Node.js** — runs `vitest`, `tsx`, `better-sqlite3` (native addon), and the HTTP server during development
- **Bun** — compiles the standalone binary, provides `bun:sqlite` (with the `VACUUM INTO` backup API), and runs smoke tests in CI

This split exists because the standalone binary goal required Bun, but the test suite predates it. The cost is:

- `sqlite-shim.ts` — ~65 lines of abstraction that bridges two SQLite APIs
- `QA-01` — `DatabaseShim.backup()` cannot be tested under vitest/Node
- CI runs two separate jobs with two runtimes
- `better-sqlite3` requires native compilation per platform

There are zero production users right now. This is the right moment to cut the knot.

---

## What Already Works

The project was partially prepared for this migration:

| Already Done | File |
|---|---|
| `#sqlite` conditional import (Bun vs Node) | `package.json` `imports` field |
| `tsconfig.bun.json` with `bun-types` | `tsconfig.bun.json` |
| Bun binary build pipeline | `bunbuild.ts`, `release.yml` |
| Smoke test runner under Bun | `scripts/smoke-test.ts` |
| `sqlite-shim.ts` wrapping `bun:sqlite` | `src/search/sqlite-shim.ts` |
| PRAGMA allowlist and SQL builder | `src/search/sqlite-shim-sql.ts` |

---

## What Needs to Change

### 1. Remove `better-sqlite3`

**Files to change:** `package.json`, `src/sqlite-resolution.test.ts`, `src/mcp/server.test.ts`

- Remove `better-sqlite3` and `@types/better-sqlite3` from dependencies
- Remove `tsx` from devDependencies (replaced by `bun` directly)
- Remove `@vitest/coverage-v8` and `vitest` from devDependencies
- Remove the `#sqlite` conditional import in `package.json` — it can point directly to `bun:sqlite` or the shim can be inlined

**Decision point:** You can either:
- (A) Delete `sqlite-shim.ts` and import `bun:sqlite` directly in `store.ts`, `embeddings.ts`, `migrations.ts` — cleanest, but requires updating ~8 files
- (B) Keep `sqlite-shim.ts` as-is and just simplify the `#sqlite` alias to always point to it — minimal change, shim becomes the permanent API surface

**Recommendation: Option A.** Now that there's only one SQLite runtime, the shim is dead weight. Use `bun:sqlite` directly. The only tricky part is the `backup()` method — keep that as a standalone helper function in `store.ts` rather than on a class.

### 2. Migrate vitest → bun:test

This is the largest chunk of work but it is mostly mechanical. `bun:test` has direct equivalents for every vitest API used in this codebase.

**API mapping:**

| vitest | bun:test | Notes |
|---|---|---|
| `import { describe, it, expect, beforeEach, afterEach } from "vitest"` | `import { describe, it, expect, beforeEach, afterEach } from "bun:test"` | Direct replacement |
| `vi.fn()` | `mock()` from `"bun:test"` | Direct replacement |
| `vi.spyOn(obj, "method")` | `spyOn(obj, "method")` from `"bun:test"` | Direct replacement |
| `vi.mock("module", factory)` | `mock.module("module", factory)` | Different call site — must be at top level of file |
| `vi.useFakeTimers()` | `setSystemTime(new Date(...))` | Only in `http.test.ts` — one file |
| `vi.clearAllMocks()` | `mock.restore()` in `afterEach` | Minor difference |
| `vi.resetModules()` | Not needed — Bun isolates modules per test file | Can be removed |

**Scope of changes:**
- 70 test files
- 11 `vi.mock()` calls (structural — need to become `mock.module()`)
- ~420 `vi.fn()` / `vi.spyOn()` calls — batch find-and-replace
- 1 `vi.useFakeTimers()` call in `http.test.ts`

**Important:** `mock.module()` in `bun:test` must be called at the **top level** of the file (before imports), similar to how `vi.mock()` gets hoisted by vitest. If any `vi.mock()` calls are inside `beforeEach` or test bodies, move them to the top level.

**Coverage:**
Replace `vitest.config.ts` with a `bunfig.toml` or pass flags directly:
```toml
[test]
coverage = true
coverageReporter = ["text", "lcov"]
coverageThreshold = { line = 80, function = 80, statement = 80, branch = 70 }
```

### 3. Update `tsconfig.json`

- Change `"module": "Node16"` → `"module": "Bundler"` (Bun's preferred resolution)
- Change `"moduleResolution": "Node16"` → `"moduleResolution": "Bundler"`
- Replace `@types/node` with `bun-types` (already in devDependencies)
- Merge `tsconfig.bun.json` into the main `tsconfig.json` — it is no longer a separate concern

### 4. Update `package.json` scripts

```json
"dev": "bun src/index.ts",
"start": "bun dist/index.js",
"test": "bun test",
"test:watch": "bun test --watch",
"test:coverage": "bun test --coverage",
"build": "tsc",
"check:types": "tsc --noEmit",
"lint": "biome check .",
"format": "biome format --write ."
```

Remove: `typecheck:bun`, `build:bin` (separate tsconfig no longer needed), `dev` using `tsx`.

### 5. Update CI (`ci.yml`)

Replace `actions/setup-node` + pnpm with `oven-sh/setup-bun`:

```yaml
- uses: oven-sh/setup-bun@v2
  with:
    bun-version: "1.x"

- run: bun install
- run: bun test --coverage
- run: bun run build       # tsc still handles emit
```

Drop the separate `bun-shim` job — it is no longer separate, it is the default.

`release.yml` already uses Bun correctly and needs only minor cleanup (remove the Node setup step).

### 6. Update `lefthook.yml`

```yaml
pre-commit:
  commands:
    biome:
      run: biome check --write {staged_files}

pre-push:
  commands:
    typecheck:
      run: bun tsc --noEmit
    test:
      run: bun test
```

---

## Risk Register

| Risk | Likelihood | Mitigation |
|---|---|---|
| `@modelcontextprotocol/sdk` has Node-specific internals | Low | Bun has high Node compat; test with `bun run src/index.ts` before full migration |
| `chokidar` v5 behaves differently under Bun | Low | Bun has native `fs.watch`; chokidar v5 explicitly supports Bun |
| `gray-matter` / `js-yaml` incompatibility | Very low | Pure JS packages, no native addons |
| `bun test` coverage gaps vs v8 | Medium | Bun coverage is file-based, not V8 bytecode — branch coverage numbers may shift; recalibrate thresholds after migration |
| `mock.module()` hoisting differences | Medium | Must audit all 11 `vi.mock()` call sites manually; move any non-top-level calls |
| `setSystemTime` less ergonomic than `vi.useFakeTimers` | Low | Only one file affected (`http.test.ts`) |

---

## Migration Order (Recommended)

Do this in a single branch, in this order — each step should leave tests passing before moving to the next:

1. **Validate runtime first** — run `bun src/index.ts` with a real vault, confirm server starts and MCP tools respond. Do this before touching any test.

2. **Replace `better-sqlite3`** — update `store.ts`, `embeddings.ts`, `migrations.ts` to import from `bun:sqlite` directly. Delete `sqlite-shim.ts` and the `#sqlite` alias. Run `bun test` — these tests use in-memory SQLite and should pass immediately.

3. **Batch-replace vitest imports** — sed/find-replace across all 70 test files:
   - `from "vitest"` → `from "bun:test"`
   - `vi.fn(` → `mock(`
   - `vi.spyOn(` → `spyOn(`
   - `vi.clearAllMocks()` → `mock.restore()`

4. **Fix the 11 `vi.mock()` calls manually** — convert to `mock.module()`. This requires manual review of each call site to ensure top-level placement.

5. **Fix `http.test.ts`** — replace `vi.useFakeTimers()` with `setSystemTime()`.

6. **Update tsconfig, package.json scripts, lefthook** — housekeeping.

7. **Update CI** — swap Node setup for Bun setup, drop redundant jobs.

8. **Run full test suite** — `bun test --coverage`. Recalibrate any coverage thresholds that shifted.

9. **Smoke test** — build the binary (`bun run bunbuild.ts`) and run `bun scripts/smoke-test.ts` against a real vault.

---

## Effort Estimate

| Step | Hours |
|---|---|
| Runtime validation (step 1) | 1 |
| SQLite layer cleanup (step 2) | 3 |
| Batch vitest→bun:test replace (step 3) | 3 |
| Manual `vi.mock()` → `mock.module()` (step 4) | 4 |
| `http.test.ts` timer fix (step 5) | 1 |
| tsconfig + scripts + lefthook (step 6) | 2 |
| CI update (step 7) | 2 |
| Test suite stabilisation + coverage recalibration (step 8) | 6 |
| Smoke test + binary validation (step 9) | 2 |
| **Total** | **~24 hours** |

This is a 3–4 focused days of work for one person.

---

## Definition of Done

- [ ] `bun test --coverage` passes all 980 tests with no vitest dependency
- [ ] `better-sqlite3` removed from `package.json`
- [ ] `sqlite-shim.ts` deleted (or reduced to a thin `bun:sqlite` re-export if kept)
- [ ] `DatabaseShim.backup()` called in at least one test (QA-01 finally closed)
- [ ] `bun src/index.ts` starts the MCP server and passes a manual tool call
- [ ] Binary builds on all platforms via `release.yml`
- [ ] CI is green with only Bun in the setup steps
