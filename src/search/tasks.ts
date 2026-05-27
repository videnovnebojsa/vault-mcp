import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { join } from "node:path";
import type { EmbedProvider } from "../search/embed-provider.js";
import type { EmbeddingStore } from "../search/embeddings.js";
import type { ISearchStore } from "../search/store.js";
import { sendAlertFireAndForget } from "../utils/alert-fire-and-forget.js";
import { CircuitOpenError } from "../utils/circuit-breaker.js";
import { logger } from "../utils/logger.js";

export interface ScheduledTaskResult {
  taskId: string;
  ok: boolean;
  message: string;
  durationMs: number;
  outputPath?: string;
  /** For embed-backlog tasks: number of stale entries not yet processed in this call. */
  remaining?: number;
}

export async function runEmbedBacklogTask(opts: {
  searchStore: ISearchStore;
  embeddingStore: EmbeddingStore;
  embedProvider: EmbedProvider;
  batchSize: number;
  excludePaths?: string[];
  maxNotes?: number;
  singleRetryDelayMs?: number;
}): Promise<ScheduledTaskResult> {
  const start = Date.now();
  const taskId = "embed-backlog";

  try {
    // Clean up orphaned embeddings for deleted/renamed notes
    const orphansDeleted = opts.embeddingStore.deleteOrphansFromVaultEntries();

    const maxNotes = opts.maxNotes ?? 500;
    const stalePage = opts.embeddingStore.getStaleOrMissingPageWithTotal(
      maxNotes,
      opts.embedProvider.modelName,
      opts.excludePaths,
    );
    const staleRows = stalePage.rows;
    const remaining = Math.max(0, stalePage.total - staleRows.length);
    const stale = staleRows.map((row) => row.path);
    const hashByPath = new Map(staleRows.map((row) => [row.path, row.contentHash]));

    if (stale.length === 0) {
      const msg =
        orphansDeleted > 0
          ? `No stale entries to embed, ${orphansDeleted} orphans removed`
          : "No stale entries to embed";
      return { taskId, ok: true, message: msg, durationMs: Date.now() - start, remaining };
    }

    let embedded = 0;
    let errors = 0;
    const failedPaths: string[] = [];

    for (let i = 0; i < stale.length; i += opts.batchSize) {
      const batch = stale.slice(i, i + opts.batchSize);
      const texts: string[] = [];
      const paths: string[] = [];
      const hashes: string[] = [];
      const batchContent = opts.searchStore.getContentBatchByPaths(batch);

      const skippedPaths: string[] = [];
      for (const path of batch) {
        const content = batchContent.get(path);
        if (content) {
          // Truncate to ~8000 chars to stay within token limits
          texts.push(content.slice(0, 8000));
          paths.push(path);
          hashes.push(hashByPath.get(path) ?? "");
        } else {
          skippedPaths.push(path);
        }
      }

      if (skippedPaths.length > 0) {
        for (const sp of skippedPaths) {
          failedPaths.push(`${sp} — skipped (empty content, consider deleting)`);
          logger.warn("embed-backlog", "skipped: no indexed content", { path: sp });
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
          logger.warn("embed-backlog", "circuit open, skipping remaining batches");
          break;
        }
        logger.warn("embed-backlog", "batch error, retrying individually", {
          err: err instanceof Error ? err.message : String(err),
        });
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
              logger.warn("embed-backlog", "circuit open in individual retry");
              circuitOpen = true;
              break;
            }
            const reason = noteErr instanceof Error ? noteErr.message : String(noteErr);
            failedPaths.push(`${paths[j]} — ${reason}`);
            logger.warn("embed-backlog", "failed to embed note", { path: paths[j], err: reason });
            await delay(retryDelayMs(opts.singleRetryDelayMs, errors));
          }
        }
        if (circuitOpen) break;
      }
    }

    let msg = `Embedded ${embedded} notes, ${errors} errors, ${stale.length} total stale`;
    if (failedPaths.length > 0) {
      msg += `\nFailed:\n${failedPaths.join("\n")}`;
    }
    return { taskId, ok: true, message: msg, durationMs: Date.now() - start, remaining };
  } catch (err) {
    return {
      taskId,
      ok: false,
      message: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
    };
  }
}

function retryDelayMs(configuredDelayMs: number | undefined, failures: number): number {
  if (configuredDelayMs !== undefined) return configuredDelayMs;
  const base = Math.min(1000, 100 * 2 ** Math.min(failures - 1, 4));
  return base + Math.random() * base * 0.25;
}

async function delay(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runBackupTask(opts: {
  searchStore: ISearchStore;
  backupDir: string;
  maxBackups: number;
  alertWebhookUrl?: string;
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
    const filename = `vault-search-${timestamp}-${randomUUID()}.db`;
    const backupPath = join(opts.backupDir, filename);

    await opts.searchStore.backup(backupPath);

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
    const message = err instanceof Error ? err.message : String(err);
    logger.error("backup", "backup failed", { err: message, backupDir: opts.backupDir });
    if (opts.alertWebhookUrl) {
      sendAlertFireAndForget({
        webhookUrl: opts.alertWebhookUrl,
        level: "error",
        source: "backup",
        message: "Backup failed",
        details: { backupDir: opts.backupDir, err: message },
      });
    }
    return {
      taskId,
      ok: false,
      message,
      durationMs: Date.now() - start,
    };
  }
}
