import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { VaultSearchStore } from "../../search/store.js";
import { handleVaultBackupDb } from "./backup-db.js";
import { makeServices } from "./test-helpers.js";

describe("handleVaultBackupDb", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vault-backup-handler-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns error when backup is not enabled", async () => {
    const services = makeServices();
    const backupConfig = { enabled: false, dir: "/backups", maxBackups: 5 };

    const result = await handleVaultBackupDb({ vault: "default" }, services, backupConfig);
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0]?.text ?? "{}");
    expect(data.error.message).toContain("Backup is not enabled");
  });

  it("returns STORE_UNAVAILABLE when backup is enabled but search store is missing [QA-06]", async () => {
    const services = makeServices({ searchStore: undefined });

    const result = await handleVaultBackupDb({ vault: "default" }, services, {
      enabled: true,
      dir: tmpDir,
      maxBackups: 5,
    });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0]?.text ?? "{}");
    expect(data.error.code).toBe("STORE_UNAVAILABLE");
  });

  it("rejects vault path traversal before running backup [QA-06]", async () => {
    const searchStore = new VaultSearchStore(":memory:");
    try {
      const services = makeServices({ searchStore });

      const result = await handleVaultBackupDb({ vault: "../escape" }, services, {
        enabled: true,
        dir: tmpDir,
        maxBackups: 5,
      });

      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0]?.text ?? "{}");
      expect(data.error.message).toContain("Backup path escapes backup directory");
    } finally {
      searchStore.close();
    }
  });

  it("redacts the absolute backup path from tool output", async () => {
    const searchStore = new VaultSearchStore(":memory:");
    try {
      searchStore.upsert("notes/a.md", "alpha", "hash-a", "a", {});
      const services = makeServices({ searchStore });

      const result = await handleVaultBackupDb({ vault: "default" }, services, {
        enabled: true,
        dir: tmpDir,
        maxBackups: 5,
      });

      expect(result.isError).toBeFalsy();
      const data = JSON.parse(result.content[0]?.text ?? "{}").data;
      expect(data.outputPath).toBeUndefined();
      expect(data.outputFile).toMatch(/^vault-search-.*\.db$/);
      expect(path.isAbsolute(data.outputFile)).toBe(false);
    } finally {
      searchStore.close();
    }
  });
});
