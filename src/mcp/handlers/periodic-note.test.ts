import { describe, expect, it, mock } from "bun:test";
import os from "node:os";
import type { VaultSync } from "../../search/sync.js";
import type { VaultManager } from "../../vault/manager.js";
import { handleVaultPeriodicNote } from "./periodic-note.js";
import { makeServices, waitFor } from "./test-helpers.js";

describe("handleVaultPeriodicNote", () => {
  it("creates and returns a daily periodic note", async () => {
    // Use a real vault in tmpdir since openOrCreatePeriodicNote writes a real file
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "periodic-test-"));
    try {
      const { VaultRepository } = await import("../../vault/repository.js");
      const realVault = new VaultRepository({ vaultPath: tmpDir });
      const trackSync = mock();
      const vaultManager = { trackSync } as unknown as VaultManager;
      const services = makeServices({ vault: realVault });

      const result = await handleVaultPeriodicNote(
        { period: "daily", date: "2026-05-12", create_if_missing: true, vault: "default" },
        services,
        vaultManager,
        "Journal",
      );
      expect(result.isError).toBeFalsy();
      const data = JSON.parse(result.content[0]?.text ?? "{}").data;
      expect(data.path).toContain("2026-05-12");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("calls trackSync when vaultSync is present", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "periodic-sync-test-"));
    try {
      const { VaultRepository } = await import("../../vault/repository.js");
      const realVault = new VaultRepository({ vaultPath: tmpDir });
      const handleUpsert = mock().mockResolvedValue(undefined);
      const vaultSync = { handleUpsert } as unknown as VaultSync;
      const trackSync = mock();
      const vaultManager = { trackSync } as unknown as VaultManager;
      const services = makeServices({ vault: realVault, vaultSync });

      await handleVaultPeriodicNote(
        { period: "daily", date: "2026-05-12", create_if_missing: true, vault: "default" },
        services,
        vaultManager,
        "Journal",
      );
      await waitFor(() => expect(trackSync).toHaveBeenCalled());
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns NOT_FOUND when create_if_missing=false and the note does not exist", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "periodic-missing-test-"));
    try {
      const { VaultRepository } = await import("../../vault/repository.js");
      const realVault = new VaultRepository({ vaultPath: tmpDir });
      const services = makeServices({ vault: realVault });

      const result = await handleVaultPeriodicNote(
        { period: "daily", date: "2026-05-12", create_if_missing: false, vault: "default" },
        services,
        { trackSync: mock() },
        "Journal",
      );
      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0]?.text ?? "{}");
      expect(data.error.code).toBe("NOT_FOUND");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("reads an existing note when create_if_missing=false", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "periodic-existing-test-"));
    try {
      const { VaultRepository } = await import("../../vault/repository.js");
      const realVault = new VaultRepository({ vaultPath: tmpDir });
      await realVault.writeNote("Journal/2026/2026-05-12", { content: "already here" });
      const services = makeServices({ vault: realVault });

      const result = await handleVaultPeriodicNote(
        { period: "daily", date: "2026-05-12", create_if_missing: false, vault: "default" },
        services,
        { trackSync: mock() },
        "Journal",
      );
      expect(result.isError).toBeFalsy();
      const data = JSON.parse(result.content[0]?.text ?? "{}").data;
      expect(data.content).toBe("already here");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
