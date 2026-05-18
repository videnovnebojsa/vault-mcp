import { afterEach, beforeEach, describe, expect, it, jest, mock, spyOn } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { CircuitOpenError } from "../utils/circuit-breaker.js";
import { logger } from "../utils/logger.js";
import { VaultSearchStore } from "./store.js";
import { runBackupTask, runEmbedBacklogTask } from "./tasks.js";

mock.module("../utils/alert.js", () => ({
  sendAlert: mock(),
}));

import { sendAlert } from "../utils/alert.js";
import type { EmbeddingStore } from "./embeddings.js";
import type { ISearchStore } from "./store.js";

function makeEmbedBacklogDeps(
  overrides: {
    staleRows?: Array<{ path: string; contentHash: string }>;
    contentByPath?: Map<string, string>;
    staleCount?: number;
    embed?: ReturnType<typeof mock>;
    orphansDeleted?: number;
  } = {},
) {
  const staleRows = overrides.staleRows ?? [{ path: "notes/a.md", contentHash: "hash-a" }];
  const searchStore = {
    getContentBatchByPaths: mock().mockReturnValue(overrides.contentByPath ?? new Map([["notes/a.md", "alpha"]])),
  };
  const embeddingStore = {
    deleteOrphansFromVaultEntries: mock().mockReturnValue(overrides.orphansDeleted ?? 0),
    getStaleOrMissingPage: mock().mockReturnValue(staleRows),
    getStaleOrMissingPageWithTotal: mock().mockReturnValue({
      rows: staleRows,
      total: overrides.staleCount ?? staleRows.length,
    }),
    countStaleOrMissing: mock().mockReturnValue(overrides.staleCount ?? staleRows.length),
    upsert: mock(),
  };
  const embedProvider = {
    dimensions: 2,
    modelName: "test-model",
    embed: overrides.embed ?? mock().mockResolvedValue(staleRows.map(() => new Float32Array([1, 0]))),
  };
  return { searchStore, embeddingStore, embedProvider };
}

describe("runBackupTask", () => {
  let store: VaultSearchStore;
  let tmpDir: string;

  beforeEach(async () => {
    mock.restore();
    store = new VaultSearchStore(":memory:");
    tmpDir = await fs.mkdtemp(path.join("/tmp", "vault-backup-test-"));
  });

  afterEach(async () => {
    store.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("sends an alert when backup fails and webhook is configured", async () => {
    spyOn(store, "backup").mockRejectedValue(new Error("disk full"));

    const result = await runBackupTask({
      searchStore: store,
      backupDir: tmpDir,
      maxBackups: 5,
      alertWebhookUrl: "http://alerts.example.test/hook",
    });

    expect(result.ok).toBe(false);
    expect(sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        webhookUrl: "http://alerts.example.test/hook",
        level: "error",
        source: "backup",
      }),
    );
  });

  it("uses a unique destination for back-to-back backups in the same second [ERR-01]", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-05-15T09:30:00.000Z"));
    const backup = mock(async (destPath: string) => {
      try {
        await fs.access(destPath);
        throw new Error("output file already exists");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      await fs.writeFile(destPath, "backup");
    });
    spyOn(store, "backup").mockImplementation(backup);

    try {
      const first = await runBackupTask({ searchStore: store, backupDir: tmpDir, maxBackups: 5 });
      const second = await runBackupTask({ searchStore: store, backupDir: tmpDir, maxBackups: 5 });

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      expect(second.outputPath).not.toBe(first.outputPath);
    } finally {
      jest.useRealTimers();
    }
  });

  it("logs backup failures when no alert webhook is configured [ERR-02]", async () => {
    spyOn(store, "backup").mockRejectedValue(new Error("disk full"));
    const errorSpy = spyOn(logger, "error").mockImplementation(() => {});

    try {
      const result = await runBackupTask({
        searchStore: store,
        backupDir: tmpDir,
        maxBackups: 5,
      });

      expect(result.ok).toBe(false);
      expect(errorSpy).toHaveBeenCalledWith("backup", "backup failed", {
        err: "disk full",
        backupDir: tmpDir,
      });
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("writes a database backup file on the success path [QA-02]", async () => {
    const result = await runBackupTask({
      searchStore: store,
      backupDir: tmpDir,
      maxBackups: 5,
    });

    expect(result.ok).toBe(true);
    expect(result.outputPath).toBeDefined();
    expect(result.message).toContain("Backup saved:");
    const stat = await fs.stat(result.outputPath ?? "");
    expect(stat.isFile()).toBe(true);
  });

  it("prunes the oldest backups when maxBackups is exceeded [QA-02]", async () => {
    await fs.writeFile(path.join(tmpDir, "vault-search-2026-01-01T00-00-00.db"), "oldest");
    await fs.writeFile(path.join(tmpDir, "vault-search-2026-01-02T00-00-00.db"), "middle");

    const result = await runBackupTask({
      searchStore: store,
      backupDir: tmpDir,
      maxBackups: 2,
    });

    const backups = (await fs.readdir(tmpDir)).filter(
      (file) => file.startsWith("vault-search-") && file.endsWith(".db"),
    );

    expect(result.ok).toBe(true);
    expect(result.message).toContain("pruned 1 old backup(s)");
    expect(backups).toHaveLength(2);
    expect(backups).not.toContain("vault-search-2026-01-01T00-00-00.db");
  });
});

describe("runEmbedBacklogTask", () => {
  it("returns early when there are no stale rows and does not call the embed provider [QA-03]", async () => {
    const deps = makeEmbedBacklogDeps({
      staleRows: [],
      staleCount: 0,
      orphansDeleted: 2,
    });

    const result = await runEmbedBacklogTask({
      searchStore: deps.searchStore as unknown as ISearchStore,
      embeddingStore: deps.embeddingStore as unknown as EmbeddingStore,
      embedProvider: deps.embedProvider,
      batchSize: 10,
    });

    expect(result.ok).toBe(true);
    expect(result.remaining).toBe(0);
    expect(result.message).toBe("No stale entries to embed, 2 orphans removed");
    expect(deps.searchStore.getContentBatchByPaths).not.toHaveBeenCalled();
    expect(deps.embedProvider.embed).not.toHaveBeenCalled();
    expect(deps.embeddingStore.upsert).not.toHaveBeenCalled();
  });

  it("cleans orphan embeddings before embedding stale notes", async () => {
    const deps = makeEmbedBacklogDeps({ orphansDeleted: 2 });

    const result = await runEmbedBacklogTask({
      searchStore: deps.searchStore as unknown as ISearchStore,
      embeddingStore: deps.embeddingStore as unknown as EmbeddingStore,
      embedProvider: deps.embedProvider,
      batchSize: 10,
    });

    expect(result.ok).toBe(true);
    expect(result.message).toContain("Embedded 1 notes");
    expect(deps.embeddingStore.deleteOrphansFromVaultEntries.mock.invocationCallOrder[0]).toBeLessThan(
      deps.embeddingStore.getStaleOrMissingPageWithTotal.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
    expect(deps.embeddingStore.countStaleOrMissing).not.toHaveBeenCalled();
    expect(deps.embeddingStore.upsert).toHaveBeenCalledWith(
      "notes/a.md",
      expect.any(Float32Array),
      "hash-a",
      "test-model",
    );
  });

  it("short-circuits remaining batches when the circuit is open", async () => {
    const embed = mock().mockRejectedValue(new CircuitOpenError("embed"));
    const deps = makeEmbedBacklogDeps({
      staleRows: [
        { path: "notes/a.md", contentHash: "hash-a" },
        { path: "notes/b.md", contentHash: "hash-b" },
      ],
      contentByPath: new Map([
        ["notes/a.md", "alpha"],
        ["notes/b.md", "bravo"],
      ]),
      embed,
    });

    const result = await runEmbedBacklogTask({
      searchStore: deps.searchStore as unknown as ISearchStore,
      embeddingStore: deps.embeddingStore as unknown as EmbeddingStore,
      embedProvider: deps.embedProvider,
      batchSize: 1,
    });

    expect(result.ok).toBe(true);
    expect(result.message).toContain("Embedded 0 notes, 1 errors, 2 total stale");
    expect(embed).toHaveBeenCalledOnce();
    expect(deps.embeddingStore.upsert).not.toHaveBeenCalled();
  });

  it("retries failed batches per note and records individual failures", async () => {
    const embed = mock()
      .mockRejectedValueOnce(new Error("batch failed"))
      .mockResolvedValueOnce([new Float32Array([1, 0])])
      .mockRejectedValueOnce(new Error("bad note"));
    const deps = makeEmbedBacklogDeps({
      staleRows: [
        { path: "notes/a.md", contentHash: "hash-a" },
        { path: "notes/b.md", contentHash: "hash-b" },
      ],
      contentByPath: new Map([
        ["notes/a.md", "alpha"],
        ["notes/b.md", "bravo"],
      ]),
      embed,
    });

    const result = await runEmbedBacklogTask({
      searchStore: deps.searchStore as unknown as ISearchStore,
      embeddingStore: deps.embeddingStore as unknown as EmbeddingStore,
      embedProvider: deps.embedProvider,
      batchSize: 2,
      singleRetryDelayMs: 0,
    });

    expect(result.ok).toBe(true);
    expect(result.message).toContain("Embedded 1 notes, 1 errors, 2 total stale");
    expect(result.message).toContain("notes/b.md");
    expect(embed).toHaveBeenNthCalledWith(1, ["alpha", "bravo"]);
    expect(embed).toHaveBeenNthCalledWith(2, ["alpha"]);
    expect(embed).toHaveBeenNthCalledWith(3, ["bravo"]);
    expect(deps.embeddingStore.upsert).toHaveBeenCalledOnce();
  });

  it("serializes batch retry error messages in JSON logs", async () => {
    const originalLogFormat = process.env.LOG_FORMAT;
    process.env.LOG_FORMAT = "json";
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const { runEmbedBacklogTask: runWithJsonLogger } = await import("./tasks.js");
      const embed = mock()
        .mockRejectedValueOnce(new Error("batch failed"))
        .mockResolvedValueOnce([new Float32Array([1, 0])]);
      const deps = makeEmbedBacklogDeps({ embed });

      await runWithJsonLogger({
        searchStore: deps.searchStore as unknown as ISearchStore,
        embeddingStore: deps.embeddingStore as unknown as EmbeddingStore,
        embedProvider: deps.embedProvider,
        batchSize: 1,
        singleRetryDelayMs: 0,
      });

      const logOutput = errorSpy.mock.calls
        .map((call) => call.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" "))
        .join("\n");
      expect(logOutput).toContain("batch failed");
    } finally {
      process.env.LOG_FORMAT = originalLogFormat;
    }
  });
});
