import type { VaultServices } from "../../vault/manager.js";
import { MockVaultRepository } from "../../vault/repository-mock.js";

/** Poll fn() until it stops throwing, or throw the last error after timeout ms. */
export async function waitFor(fn: () => void, timeoutMs = 1000, intervalMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      fn();
      return;
    } catch (e) {
      if (Date.now() >= deadline) throw e;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}

export function makeServices(overrides: Partial<VaultServices> = {}): VaultServices {
  const vault = new MockVaultRepository();
  return {
    vault,
    searchStore: undefined,
    vaultSync: undefined as unknown as VaultServices["vaultSync"],
    capture: null,
    embeddingStore: undefined,
    embedProvider: undefined,
    embeddingConfig: {
      enabled: false,
      apiKey: "",
      endpoint: "",
      model: "",
      hybridAlpha: 0.5,
      batchSize: 20,
      queryCacheMax: 128,
    },
    aclConfig: { allowPaths: [], denyPaths: [] },
    watcher: null,
    bootFailed: false,
    bootReady: Promise.resolve(),
    ...overrides,
  };
}
