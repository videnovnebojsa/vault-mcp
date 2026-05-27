import path from "node:path";
import type { CaptureConfig, EmbeddingConfig, VaultConfig } from "../config.js";
import { type EmbedProvider, HttpEmbedProvider } from "../search/embed-provider.js";
import type { EmbeddingStore } from "../search/embeddings.js";
import { type ISearchStore, VaultSearchStore } from "../search/store.js";
import { VaultSync } from "../search/sync.js";
import { createVaultWatcher, type VaultWatcher } from "../search/watcher.js";
import { sendAlertFireAndForget } from "../utils/alert-fire-and-forget.js";
import { VaultError, VaultErrorCode } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { VaultRepository } from "./repository.js";
import type { IVaultRepository } from "./repository-interface.js";
import type { AclConfig } from "./types.js";

export interface VaultServices {
  vault: IVaultRepository;
  searchStore: ISearchStore | undefined;
  vaultSync: VaultSync;
  capture: CaptureService | null;
  embeddingStore: EmbeddingStore | undefined;
  embedProvider: EmbedProvider | undefined;
  embeddingConfig: EmbeddingConfig;
  aclConfig: AclConfig;
  watcher: VaultWatcher | null;
  bootFailed: boolean;
  /** Resolves when initial sync (and watcher start) have completed or failed. Never rejects. */
  bootReady: Promise<void>;
}

export interface SyncTracker {
  trackSync(p: Promise<void>): void;
}

type EmbedProviderFactory = (cfg: EmbeddingConfig) => EmbedProvider;

export interface CaptureService {
  processCapture(text: string): Promise<{
    ok: boolean;
    notePath?: string | undefined;
    message?: string | undefined;
  }>;
}

export type CaptureFactory = (opts: {
  vaultPath: string;
  config: CaptureConfig;
  vault: IVaultRepository;
}) => CaptureService;

function defaultEmbedProviderFactory(cfg: EmbeddingConfig): EmbedProvider {
  return new HttpEmbedProvider(cfg.apiKey, cfg.endpoint, cfg.model);
}

export class VaultManager implements SyncTracker {
  private readonly cache = new Map<string, VaultServices>();
  private readonly inflightSyncs = new Set<Promise<void>>();

  constructor(
    private readonly namedVaults: Record<string, string>,
    private readonly baseConfig: VaultConfig,
    private readonly embedProviderFactory: EmbedProviderFactory = defaultEmbedProviderFactory,
    private readonly captureFactory?: CaptureFactory | undefined,
  ) {}

  /** Call this instead of bare fire-and-forget. Tracks the promise for drain on shutdown. */
  trackSync(p: Promise<void>): void {
    this.inflightSyncs.add(p);
    p.finally(() => this.inflightSyncs.delete(p));
  }

  listVaults(): Array<{ name: string }> {
    return Object.keys(this.namedVaults).map((name) => ({ name }));
  }

  get config(): VaultConfig {
    return this.baseConfig;
  }

  getServices(name = "default"): VaultServices {
    const vaultPath = this.namedVaults[name];
    if (vaultPath === undefined) {
      throw new VaultError("Unknown vault", VaultErrorCode.VALIDATION);
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
      const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
      logger.error("vault-manager", `${name}: boot failed`, {
        err: message,
      });
      if (this.baseConfig.alertWebhookUrl) {
        sendAlertFireAndForget({
          webhookUrl: this.baseConfig.alertWebhookUrl,
          level: "error",
          source: "vault-manager",
          message: `${name}: boot failed`,
          details: { vault: name, err: message },
        });
      }
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
      embeddingStore = searchStore.createEmbeddingStore();
      embeddingStore.initSchema();
      // load() is deferred to bootVault (after runFullSync) to avoid blocking the event loop
      // on first tool call with a full table scan.
      embedProvider = this.embedProviderFactory(embeddingConfig);
    }

    const capture =
      captureConfig.enableCapturePipeline && this.captureFactory
        ? this.captureFactory({ vaultPath, config: captureConfig, vault })
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
    // Drain in-flight syncs before closing SQLite
    if (this.inflightSyncs.size > 0) {
      logger.info("vault-manager", `draining ${this.inflightSyncs.size} in-flight sync(s)...`);
      await Promise.allSettled([...this.inflightSyncs]);
    }
    for (const [name, svc] of this.cache) {
      // Drain any in-flight boot so the DB is not closed while it's still being written to.
      await svc.bootReady.catch(() => {});
      try {
        await svc.watcher?.stop();
        svc.searchStore?.close();
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
