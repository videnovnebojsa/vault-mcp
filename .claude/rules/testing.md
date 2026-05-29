# Testing Rules

## Test helpers

Handler tests use `makeServices()` from `src/mcp/handlers/test-helpers.ts` - not manual object construction. Override specific fields:

```typescript
const services = makeServices({ capture: mockCapture, searchStore: myStore });
```

`MockVaultRepository` (from `src/vault/repository-mock.ts`) is included by default. Use it to seed notes for read paths. `new VaultSearchStore()` (`:memory:` default) for search store tests - no path needed.

## Fake timers

Import `jest` from `bun:test` (not the `jest` package). Always restore with `jest.useRealTimers()` in `afterEach` when fake timers are used in a test file.

**Microtask drain before advancing timers** - if you skip this, timers fire before `.then()` callbacks resolve and tests look like logic bugs:

```typescript
for (let i = 0; i < 10; i++) await Promise.resolve();
jest.advanceTimersByTime(ms);
```

Use 2 `await Promise.resolve()` calls for single-hop chains; 10 iterations when multiple chained promises are queued.

## Query embedding cache

`handleVaultSearch` has a module-level query embedding cache. Call `resetQueryEmbeddingCache()` (exported from `src/mcp/handlers/search.ts`) in `afterEach` when testing search caching - otherwise cache state bleeds across tests in the same file.

## Coverage

Threshold is 80% lines and functions. `bun run test:coverage` enforces this - CI fails below threshold.
