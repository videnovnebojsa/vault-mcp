import path from "node:path";
import { type ChokidarOptions, type FSWatcher, watch } from "chokidar";
import { logger } from "../utils/logger.js";
import type { VaultSync } from "./sync.js";
import { toCanonicalPath } from "./sync.js";

const watcherLogger = logger.child("watcher");

export interface VaultWatcherOptions {
  vaultPath: string;
  vaultSync: VaultSync;
  debounceMs?: number;
  /** How long to wait for a matching add before treating unlink as delete. */
  renameWindowMs?: number;
  /** Extra chokidar options (e.g. usePolling for tests) */
  chokidarOptions?: ChokidarOptions;
}

interface WatcherStats {
  eventsProcessed: number;
  errors: number;
}

export interface VaultWatcher {
  start(): void;
  stop(): Promise<void>;
  readonly isRunning: boolean;
  readonly stats: WatcherStats;
  readonly ready: Promise<void>;
}

const RENAME_WINDOW_MS = 200;

export function createVaultWatcher(opts: VaultWatcherOptions): VaultWatcher {
  const { vaultPath, vaultSync, debounceMs = 300, renameWindowMs = RENAME_WINDOW_MS, chokidarOptions } = opts;
  let watcher: FSWatcher | undefined;
  let running = false;
  const stats: WatcherStats = { eventsProcessed: 0, errors: 0 };

  let readyResolve: () => void;
  const readyPromise = new Promise<void>((r) => {
    readyResolve = r;
  });

  // Per-file debounce timers
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  // Pending unlinks for rename detection
  const pendingUnlinks = new Map<string, ReturnType<typeof setTimeout>>();

  function toCanonical(absPath: string): string {
    return toCanonicalPath(path.relative(vaultPath, absPath));
  }

  function clearTimer(canonical: string): void {
    const existing = timers.get(canonical);
    if (existing) {
      clearTimeout(existing);
      timers.delete(canonical);
    }
  }

  function handleAddOrChange(absPath: string): void {
    const canonical = toCanonical(absPath);

    // Check for pending unlink → treat as rename
    const pending = pendingUnlinks.entries().next().value;
    if (pending) {
      const [oldCanonical, timer] = pending;
      clearTimeout(timer);
      pendingUnlinks.delete(oldCanonical);
      clearTimer(canonical);
      timers.set(
        canonical,
        setTimeout(() => {
          timers.delete(canonical);
          if (!running) return;
          vaultSync
            .handleRename(oldCanonical, canonical)
            .then(() => {
              stats.eventsProcessed++;
            })
            .catch((err) => {
              stats.errors++;
              watcherLogger.error("rename error", {
                from: oldCanonical,
                to: canonical,
                err: err instanceof Error ? err.message : String(err),
              });
            });
        }, debounceMs),
      );
      return;
    }

    clearTimer(canonical);
    timers.set(
      canonical,
      setTimeout(() => {
        timers.delete(canonical);
        if (!running) return;
        vaultSync
          .handleUpsert(canonical)
          .then(() => {
            stats.eventsProcessed++;
          })
          .catch((err) => {
            stats.errors++;
            watcherLogger.error("upsert error", {
              path: canonical,
              err: err instanceof Error ? err.message : String(err),
            });
          });
      }, debounceMs),
    );
  }

  function handleUnlink(absPath: string): void {
    const canonical = toCanonical(absPath);
    clearTimer(canonical);

    // Wait for a possible matching add (rename)
    pendingUnlinks.set(
      canonical,
      setTimeout(() => {
        pendingUnlinks.delete(canonical);
        if (!running) return;
        try {
          vaultSync.handleDelete(canonical);
          stats.eventsProcessed++;
        } catch (err) {
          stats.errors++;
          watcherLogger.error("delete error", {
            path: canonical,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }, renameWindowMs),
    );
  }

  return {
    start() {
      if (running) return;
      running = true;

      watcher = watch(vaultPath, {
        ignored: [
          /(^|[/\\])\../, // dot-prefixed dirs/files
          "**/node_modules/**",
          "**/dist/**",
        ],
        ignoreInitial: true,
        persistent: true,
        ...chokidarOptions,
      });

      watcher.on("ready", () => readyResolve());

      watcher.on("add", (p) => {
        if (p.endsWith(".md")) handleAddOrChange(p);
      });
      watcher.on("change", (p) => {
        if (p.endsWith(".md")) handleAddOrChange(p);
      });
      watcher.on("unlink", (p) => {
        if (p.endsWith(".md")) handleUnlink(p);
      });
      watcher.on("error", (err) => {
        stats.errors++;
        watcherLogger.error("watcher error", { err: err instanceof Error ? err.message : String(err) });
      });
    },

    async stop() {
      if (!running) return;
      running = false;

      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      for (const timer of pendingUnlinks.values()) clearTimeout(timer);
      pendingUnlinks.clear();

      if (watcher) {
        await watcher.close();
        watcher = undefined;
      }
    },

    get isRunning() {
      return running;
    },

    get stats(): WatcherStats {
      return { ...stats };
    },

    get ready() {
      return readyPromise;
    },
  };
}
