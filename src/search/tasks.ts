import fs from "node:fs/promises";
import { join } from "node:path";
import type { EmbedProvider } from "../search/embed-provider.js";
import type { EmbeddingStore } from "../search/embeddings.js";
import type { VaultSearchStore } from "../search/store.js";
import { CircuitOpenError } from "../utils/circuit-breaker.js";

export interface ScheduledTaskResult {
  taskId: string;
  ok: boolean;
  message: string;
  durationMs: number;
  outputPath?: string;
}

export function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export async function runEmbedBacklogTask(opts: {
  searchStore: VaultSearchStore;
  embeddingStore: EmbeddingStore;
  embedProvider: EmbedProvider;
  batchSize: number;
  excludePaths?: string[];
}): Promise<ScheduledTaskResult> {
  const start = Date.now();
  const taskId = "embed-backlog";

  try {
    const currentEntries = opts.searchStore.getContentHashMap();

    // Clean up orphaned embeddings for deleted/renamed notes
    const orphansDeleted = opts.embeddingStore.deleteOrphans(new Set(currentEntries.keys()));

    const excludeSet = new Set(opts.excludePaths ?? []);
    const stale = opts.embeddingStore
      .getStaleOrMissing(currentEntries, opts.embedProvider.modelName)
      .filter((p) => !excludeSet.has(p));

    if (stale.length === 0) {
      const msg =
        orphansDeleted > 0
          ? `No stale entries to embed, ${orphansDeleted} orphans removed`
          : "No stale entries to embed";
      return { taskId, ok: true, message: msg, durationMs: Date.now() - start };
    }

    let embedded = 0;
    let errors = 0;
    const failedPaths: string[] = [];

    for (let i = 0; i < stale.length; i += opts.batchSize) {
      const batch = stale.slice(i, i + opts.batchSize);
      const texts: string[] = [];
      const paths: string[] = [];
      const hashes: string[] = [];

      const skippedPaths: string[] = [];
      for (const path of batch) {
        const content = opts.searchStore.getContentByPath(path);
        if (content) {
          // Truncate to ~8000 chars to stay within token limits
          texts.push(content.slice(0, 8000));
          paths.push(path);
          hashes.push(currentEntries.get(path) ?? "");
        } else {
          skippedPaths.push(path);
        }
      }

      if (skippedPaths.length > 0) {
        for (const sp of skippedPaths) {
          failedPaths.push(`${sp} — skipped (empty content, consider deleting)`);
          console.error(`[embed-backlog] skipped: ${sp} — no indexed content`);
        }
      }
      if (texts.length === 0) continue;

      try {
        const embeddings = await opts.embedProvider.embed(texts);
        for (let j = 0; j < embeddings.length; j++) {
          const p = paths[j];
          const e = embeddings[j];
          const h = hashes[j];
          if (p && e && h !== undefined) opts.embeddingStore.upsert(p, e, h, opts.embedProvider.modelName);
        }
        embedded += embeddings.length;
      } catch (err) {
        if (err instanceof CircuitOpenError) {
          errors += texts.length;
          console.error(`[embed-backlog] circuit open, skipping remaining batches`);
          break;
        }
        console.error(
          `[embed-backlog] batch error: ${err instanceof Error ? err.message : String(err)}, retrying individually`,
        );
        let circuitOpen = false;
        for (let j = 0; j < texts.length; j++) {
          try {
            const text = texts[j];
            if (!text) continue;
            const singleResult = await opts.embedProvider.embed([text]);
            const vec = singleResult[0];
            const p = paths[j];
            const h = hashes[j];
            if (vec && p && h !== undefined) opts.embeddingStore.upsert(p, vec, h, opts.embedProvider.modelName);
            embedded++;
          } catch (noteErr) {
            errors++;
            if (noteErr instanceof CircuitOpenError) {
              errors += texts.length - j - 1;
              console.error(`[embed-backlog] circuit open, skipping remaining`);
              circuitOpen = true;
              break;
            }
            const reason = noteErr instanceof Error ? noteErr.message : String(noteErr);
            failedPaths.push(`${paths[j]} — ${reason}`);
            console.error(`[embed-backlog] failed: ${paths[j]} — ${reason}`);
          }
        }
        if (circuitOpen) break;
      }
    }

    let msg = `Embedded ${embedded} notes, ${errors} errors, ${stale.length} total stale`;
    if (failedPaths.length > 0) {
      msg += `\nFailed:\n${failedPaths.join("\n")}`;
    }
    return { taskId, ok: true, message: msg, durationMs: Date.now() - start };
  } catch (err) {
    return {
      taskId,
      ok: false,
      message: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
    };
  }
}

export async function runBackupTask(opts: {
  searchStore: VaultSearchStore;
  backupDir: string;
  maxBackups: number;
}): Promise<ScheduledTaskResult> {
  const start = Date.now();
  const taskId = "db-backup";

  try {
    await fs.mkdir(opts.backupDir, { recursive: true });

    const now = new Date();
    const timestamp = now
      .toISOString()
      .replace(/:/g, "-")
      .replace(/\.\d+Z$/, "");
    const filename = `vault-search-${timestamp}.db`;
    const backupPath = join(opts.backupDir, filename);

    const db = opts.searchStore.getDatabase();
    await db.backup(backupPath);

    const stat = await fs.stat(backupPath);
    const sizeMB = (stat.size / (1024 * 1024)).toFixed(2);

    // Prune old backups
    const files = await fs.readdir(opts.backupDir);
    const backupFiles = files.filter((f) => f.startsWith("vault-search-") && f.endsWith(".db")).sort();

    let pruned = 0;
    while (backupFiles.length > opts.maxBackups) {
      const oldest = backupFiles.shift();
      if (oldest) {
        await fs.unlink(join(opts.backupDir, oldest));
        pruned++;
      }
    }

    const msg = `Backup saved: ${filename} (${sizeMB} MB)${pruned > 0 ? `, pruned ${pruned} old backup(s)` : ""}`;
    return { taskId, ok: true, message: msg, durationMs: Date.now() - start, outputPath: backupPath };
  } catch (err) {
    return {
      taskId,
      ok: false,
      message: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
    };
  }
}
