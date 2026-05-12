import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { logger } from "../utils/logger.js";
import type { VaultSearchStore } from "./store.js";
import type { VaultSyncResult } from "./types.js";

export interface VaultSyncOptions {
  vaultPath: string;
  store: VaultSearchStore;
}

export class VaultSync {
  private vaultPath: string;
  private store: VaultSearchStore;
  private mtimeCache = new Map<string, number>();
  // Coalescing gate: all concurrent callers share the same in-flight promise so they
  // all receive real results instead of a silent no-op early return.
  private activeSyncPromise: Promise<VaultSyncResult> | null = null;

  constructor(opts: VaultSyncOptions) {
    this.vaultPath = opts.vaultPath;
    this.store = opts.store;
  }

  runFullSync(): Promise<VaultSyncResult> {
    if (this.activeSyncPromise) return this.activeSyncPromise;
    this.activeSyncPromise = this._doFullSync().finally(() => {
      this.activeSyncPromise = null;
    });
    return this.activeSyncPromise;
  }

  private async _doFullSync(): Promise<VaultSyncResult> {
    const start = Date.now();
    logger.info("sync", "full sync started", { vaultPath: this.vaultPath });

    const files = await collectMarkdownFiles(this.vaultPath);
    const scannedPaths = new Set<string>();

    let upserted = 0;
    let skippedUnchanged = 0;
    let skippedErrors = 0;

    for (const file of files) {
      const canonical = toCanonicalPath(path.relative(this.vaultPath, file.path));
      scannedPaths.add(canonical);

      const cachedMtime = this.mtimeCache.get(canonical);
      if (cachedMtime !== undefined && cachedMtime === file.mtimeMs) {
        skippedUnchanged++;
        continue;
      }

      try {
        const content = await fs.readFile(file.path, "utf-8");
        const hash = md5(content);

        let metadata: Record<string, unknown> = {};
        try {
          const parsed = matter(content);
          metadata = (parsed.data ?? {}) as Record<string, unknown>;
        } catch (err) {
          logger.warn("sync", "frontmatter parse error", {
            path: canonical,
            err: err instanceof Error ? err.message : String(err),
          });
        }

        const fileName = path.basename(file.path, ".md");
        const { changed } = this.store.upsert(canonical, content, hash, fileName, metadata, {
          createdAt: file.birthtimeMs,
          updatedAt: file.mtimeMs,
        });

        if (changed) {
          upserted++;
        } else {
          skippedUnchanged++;
        }

        this.mtimeCache.set(canonical, file.mtimeMs);
      } catch (err) {
        skippedErrors++;
        logger.warn("sync", "skipping unreadable file", {
          path: canonical,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Delete stale entries
    const indexedPaths = this.store.listCanonicalPaths();
    let deletedStale = 0;
    for (const p of indexedPaths) {
      if (!scannedPaths.has(p)) {
        this.store.deleteByPath(p);
        this.mtimeCache.delete(p);
        deletedStale++;
      }
    }

    const durationMs = Date.now() - start;
    logger.info("sync", "full sync complete", {
      scanned: files.length,
      upserted,
      skippedUnchanged,
      skippedErrors,
      deletedStale,
      durationMs,
    });

    return {
      scanned: files.length,
      upserted,
      skippedUnchanged,
      deletedStale,
      durationMs,
    };
  }

  async handleUpsert(canonicalPath: string): Promise<void> {
    const absPath = path.join(this.vaultPath, canonicalPath);
    const [content, stat] = await Promise.all([fs.readFile(absPath, "utf-8"), fs.stat(absPath)]);
    const hash = md5(content);

    let metadata: Record<string, unknown> = {};
    try {
      const parsed = matter(content);
      metadata = (parsed.data ?? {}) as Record<string, unknown>;
    } catch (err) {
      logger.warn("sync", "frontmatter parse error", {
        path: canonicalPath,
        err: err instanceof Error ? err.message : String(err),
      });
    }

    const fileName = path.basename(absPath, ".md");
    this.store.upsert(canonicalPath, content, hash, fileName, metadata, {
      createdAt: stat.birthtimeMs,
      updatedAt: stat.mtimeMs,
    });
    this.mtimeCache.set(canonicalPath, stat.mtimeMs);
  }

  handleDelete(canonicalPath: string): boolean {
    this.mtimeCache.delete(canonicalPath);
    return this.store.deleteByPath(canonicalPath);
  }

  async handleRename(oldPath: string, newPath: string): Promise<void> {
    this.handleDelete(oldPath);
    await this.handleUpsert(newPath);
  }
}

export function md5(content: string): string {
  return createHash("md5").update(content).digest("hex");
}

export function toCanonicalPath(p: string): string {
  return p.replace(/\\/g, "/");
}

interface FileInfo {
  path: string;
  mtimeMs: number;
  birthtimeMs: number;
}

export async function collectMarkdownFiles(dir: string): Promise<FileInfo[]> {
  const results: FileInfo[] = [];

  async function walk(currentDir: string): Promise<void> {
    const entries = await fs.readdir(currentDir, { withFileTypes: true }).catch(() => null);
    if (!entries) return;

    for (const entry of entries) {
      // Skip dot-prefixed dirs/files
      if (entry.name.startsWith(".")) continue;

      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        try {
          const stat = await fs.stat(fullPath);
          results.push({ path: fullPath, mtimeMs: stat.mtimeMs, birthtimeMs: stat.birthtimeMs });
        } catch {
          // Skip files we can't stat
        }
      }
    }
  }

  await walk(dir);
  return results;
}
