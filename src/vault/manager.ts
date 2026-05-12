import path from "node:path";
import { SecondBrainService } from "../capture/service.js";
import type { EmbeddingConfig, VaultConfig } from "../config.js";
import { DeepSeekEmbedProvider, type EmbedProvider } from "../search/embed-provider.js";
import { EmbeddingStore } from "../search/embeddings.js";
import { VaultSearchStore } from "../search/store.js";
import { VaultSync } from "../search/sync.js";
import { createVaultWatcher, type VaultWatcher } from "../search/watcher.js";
import { logger } from "../utils/logger.js";
import { VaultRepository } from "./repository.js";
import type { AclConfig } from "./types.js";

export interface VaultServices {
  vault: VaultRepository;
  searchStore: VaultSearchStore;
  vaultSync: VaultSync;
  capture: SecondBrainService | null;
  embeddingStore: EmbeddingStore | undefined;
  embedProvider: EmbedProvider | undefined;
  embeddingConfig: EmbeddingConfig;
  aclConfig: AclConfig;
  vaultPath: string;
  watcher: VaultWatcher | null;
  bootFailed: boolean;
  /** Resolves when initial sync (and watcher start) have completed or failed. Never rejects. */
  bootReady: Promise<void>;
}

export class VaultManager {
  private readonly cache = new Map<string, VaultServices>();

  constructor(
    private readonly namedVaults: Record<string, string>,
    private readonly baseConfig: VaultConfig,
  ) {}

  listVaults(): Array<{ name: string }> {
    return Object.keys(this.namedVaults).map((name) => ({ name }));
  }

  get config(): VaultConfig {
    return this.baseConfig;
  }

  getServices(name = "default"): VaultServices {
    const vaultPath = this.namedVaults[name];
    if (vaultPath === undefined) {
      const available = Object.keys(this.namedVaults).join(", ");
      throw new Error(`Unknown vault: "${name}". Available: ${available}`);
    }

    let svc = this.cache.get(name);
    if (!svc) {
      const partial = this.createServices(name, vaultPath);
      svc = partial as VaultServices;
      svc.bootReady = this.bootVault(name, svc);
      this.cache.set(name, svc);
    }
    return svc;
  }

  private async bootVault(name: string, svc: VaultServices): Promise<void> {
    try {
      // Start watcher before sync so no changes are missed while indexing
      if (this.baseConfig.watcher.enabled && svc.watcher) {
        svc.watcher.start();
        logger.info("vault-manager", `${name}: watcher started (debounce: ${this.baseConfig.watcher.debounceMs}ms)`);
      }
      const stats = await svc.vaultSync.runFullSync();
      logger.info(
        "vault-manager",
        `${name}: sync complete — ${stats.scanned} scanned, ${stats.upserted} upserted in ${stats.durationMs}ms`,
      );
      // Load embeddings after sync so the full table scan runs off the hot first-request path.
      if (svc.embeddingStore) {
        svc.embeddingStore.load();
      }
    } catch (err) {
      logger.error("vault-manager", `${name}: boot failed`, {
        err: err instanceof Error ? (err.stack ?? err.message) : String(err),
      });
      // Set synchronous sentinel for callers that cannot await (e.g. health endpoint).
      svc.bootFailed = true;
      // Re-throw so bootReady rejects and tool handlers get a real error instead of a silent no-op.
      throw err;
    }
  }

  private createServices(name: string, vaultPath: string): Omit<VaultServices, "bootReady"> {
    const {
      acl: aclConfig,
      embedding: embeddingConfig,
      capture: captureConfig,
      watcher: watcherConfig,
    } = this.baseConfig;

    const vault = new VaultRepository({ vaultPath, acl: aclConfig });
    const dbPath = this.dbPathForVault(name);
    const searchStore = new VaultSearchStore(dbPath);
    const vaultSync = new VaultSync({ vaultPath, store: searchStore });

    let embeddingStore: EmbeddingStore | undefined;
    let embedProvider: EmbedProvider | undefined;
    if (embeddingConfig.enabled && embeddingConfig.apiKey) {
      embeddingStore = new EmbeddingStore(searchStore.getDatabase());
      embeddingStore.initSchema();
      // load() is deferred to bootVault (after runFullSync) to avoid blocking the event loop
      // on first tool call with a full table scan.
      embedProvider = new DeepSeekEmbedProvider(
        embeddingConfig.apiKey,
        embeddingConfig.endpoint,
        embeddingConfig.model,
      );
    }

    const capture = captureConfig.enableCapturePipeline
      ? new SecondBrainService({ vaultPath, ...captureConfig }, vault)
      : null;

    const watcher = watcherConfig.enabled
      ? createVaultWatcher({ vaultPath, vaultSync, debounceMs: watcherConfig.debounceMs })
      : null;

    return {
      vault,
      searchStore,
      vaultSync,
      capture,
      embeddingStore,
      embedProvider,
      embeddingConfig,
      aclConfig,
      vaultPath,
      watcher,
      bootFailed: false,
    };
  }

  private dbPathForVault(name: string): string {
    if (name === "default") return this.baseConfig.memoryDbPath;
    const base = this.baseConfig.memoryDbPath;
    if (base === ":memory:") return ":memory:";
    const absBase = path.resolve(base);
    const ext = path.extname(absBase);
    const stem = ext ? absBase.slice(0, -ext.length) : absBase;
    return `${stem}-${name}${ext}`;
  }

  async shutdown(): Promise<void> {
    for (const [name, svc] of this.cache) {
      // Drain any in-flight boot so the DB is not closed while it's still being written to.
      await svc.bootReady.catch(() => {});
      try {
        await svc.watcher?.stop();
        svc.searchStore.close();
        logger.info("vault-manager", `${name}: shut down`);
      } catch (err) {
        logger.error("vault-manager", `${name}: shutdown error`, {
          err: err instanceof Error ? (err.stack ?? err.message) : String(err),
        });
      }
    }
    this.cache.clear();
  }
}
