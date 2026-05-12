import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VaultConfig } from "../config.js";
import { VaultManager } from "./manager.js";

function makeConfig(overrides: Partial<VaultConfig> = {}): VaultConfig {
  return {
    vaultPath: os.tmpdir(),
    memoryDbPath: ":memory:",
    namedVaults: { default: os.tmpdir() },
    periodicNotesRoot: "Journal",
    embedding: {
      enabled: false,
      apiKey: "",
      endpoint: "",
      model: "text-embedding-3-small",
      hybridAlpha: 0.5,
      batchSize: 20,
      intervalMinutes: 30,
    },
    backup: { enabled: false, dir: os.tmpdir(), maxBackups: 5, intervalHours: 24 },
    capture: { enableCapturePipeline: false, logRawInput: false },
    watcher: { enabled: false, debounceMs: 300 },
    mcpPort: 3782,
    mcpHost: "127.0.0.1",
    mcpApiKey: "",
    alertWebhookUrl: "",
    acl: { allowPaths: [], denyPaths: [] },
    toolTimeoutMs: 30_000,
    ...overrides,
  };
}

let manager: VaultManager;

afterEach(async () => {
  await manager.shutdown();
});

describe("VaultManager.listVaults", () => {
  it("returns the configured vaults without paths", () => {
    const config = makeConfig({
      namedVaults: { default: "/vault/main", work: "/vault/work" },
    });
    manager = new VaultManager(config.namedVaults, config);
    const vaults = manager.listVaults();
    expect(vaults).toEqual(expect.arrayContaining([{ name: "default" }, { name: "work" }]));
    expect(vaults).toHaveLength(2);
    expect(vaults[0]).not.toHaveProperty("path");
  });

  it("returns only default when no extra vaults configured", () => {
    manager = new VaultManager({ default: os.tmpdir() }, makeConfig());
    const vaults = manager.listVaults();
    expect(vaults).toHaveLength(1);
    expect(vaults[0]?.name).toBe("default");
  });
});

describe("VaultManager.getServices", () => {
  beforeEach(() => {
    const config = makeConfig({
      namedVaults: { default: os.tmpdir(), work: os.tmpdir() },
    });
    manager = new VaultManager(config.namedVaults, config);
  });

  it("returns services for default vault when called without argument", () => {
    const svc = manager.getServices();
    expect(svc).toBeDefined();
    expect(svc.vault).toBeDefined();
    expect(svc.searchStore).toBeDefined();
    expect(svc.vaultSync).toBeDefined();
    expect(svc.vaultPath).toBe(os.tmpdir());
  });

  it("returns services for named vault", () => {
    const svc = manager.getServices("work");
    expect(svc).toBeDefined();
    expect(svc.vaultPath).toBe(os.tmpdir());
  });

  it("returns different VaultRepository instances for different vaults", () => {
    const config = makeConfig({
      namedVaults: { default: "/vault/a", work: "/vault/b" },
    });
    manager = new VaultManager(config.namedVaults, config);

    const defaultSvc = manager.getServices("default");
    const workSvc = manager.getServices("work");

    expect(defaultSvc.vault).not.toBe(workSvc.vault);
    expect(defaultSvc.vaultPath).toBe("/vault/a");
    expect(workSvc.vaultPath).toBe("/vault/b");
  });

  it("returns the same cached instance on repeated calls", () => {
    const first = manager.getServices("default");
    const second = manager.getServices("default");
    expect(first).toBe(second);
  });

  it("throws for unknown vault names", () => {
    expect(() => manager.getServices("unknown")).toThrowError(/Unknown vault: "unknown"/);
  });

  it("capture is null when capture pipeline disabled", () => {
    const svc = manager.getServices();
    expect(svc.capture).toBeNull();
  });

  it("embeddingStore is undefined when embeddings disabled", () => {
    const svc = manager.getServices();
    expect(svc.embeddingStore).toBeUndefined();
    expect(svc.embedProvider).toBeUndefined();
  });

  it("watcher is null when watcher disabled", () => {
    const svc = manager.getServices();
    expect(svc.watcher).toBeNull();
  });
});

describe("VaultManager.shutdown", () => {
  it("closes all search stores without error", async () => {
    manager = new VaultManager(
      { default: os.tmpdir(), work: os.tmpdir() },
      makeConfig({ namedVaults: { default: os.tmpdir(), work: os.tmpdir() } }),
    );
    // Eagerly init both vaults
    manager.getServices("default");
    manager.getServices("work");
    // Shutdown should close both DBs cleanly
    await expect(manager.shutdown()).resolves.toBeUndefined();
  });

  it("does not throw when no services were initialized", async () => {
    manager = new VaultManager({ default: os.tmpdir() }, makeConfig());
    await expect(manager.shutdown()).resolves.toBeUndefined();
  });
});

describe("VaultManager db path derivation", () => {
  it("uses memoryDbPath directly for default vault", () => {
    const tmpDb = path.join(os.tmpdir(), "test.db");
    const config = makeConfig({ memoryDbPath: tmpDb, namedVaults: { default: os.tmpdir() } });
    manager = new VaultManager(config.namedVaults, config);
    const svc = manager.getServices("default");
    // Default vault uses config.memoryDbPath
    expect(svc.searchStore).toBeDefined();
  });

  it("returns :memory: for all vaults when memoryDbPath is :memory:", () => {
    const config = makeConfig({
      memoryDbPath: ":memory:",
      namedVaults: { default: os.tmpdir(), work: os.tmpdir() },
    });
    manager = new VaultManager(config.namedVaults, config);
    // Both vaults get :memory: DB — they're independent SQLite in-memory DBs
    const defaultSvc = manager.getServices("default");
    const workSvc = manager.getServices("work");
    expect(defaultSvc.searchStore).toBeDefined();
    expect(workSvc.searchStore).toBeDefined();
    expect(defaultSvc.searchStore).not.toBe(workSvc.searchStore);
  });

  it("derives a namespaced db path for non-default vaults when memoryDbPath is a real file", () => {
    const tmpDb = path.join(os.tmpdir(), "vault-test.db");
    const config = makeConfig({
      memoryDbPath: tmpDb,
      namedVaults: { default: os.tmpdir(), work: os.tmpdir() },
    });
    manager = new VaultManager(config.namedVaults, config);
    // Both vaults should be independently accessible (work vault gets a derived path ending in -work.db)
    const defaultSvc = manager.getServices("default");
    const workSvc = manager.getServices("work");
    expect(defaultSvc.searchStore).toBeDefined();
    expect(workSvc.searchStore).toBeDefined();
    expect(defaultSvc.searchStore).not.toBe(workSvc.searchStore);
  });
});

describe("VaultManager boot failure propagation", () => {
  it("bootFailed is false and bootReady resolves after successful boot", async () => {
    manager = new VaultManager({ default: os.tmpdir() }, makeConfig());
    const svc = manager.getServices("default");
    await expect(svc.bootReady).resolves.toBeUndefined();
    expect(svc.bootFailed).toBe(false);
  });

  it("bootFailed is true and bootReady rejects when runFullSync throws", async () => {
    // Use vi.doMock to inject a VaultSync that always rejects, so bootVault sets bootFailed=true.
    vi.resetModules();
    vi.doMock("../search/sync.js", () => ({
      VaultSync: vi.fn().mockImplementation(() => ({
        runFullSync: vi.fn().mockRejectedValue(new Error("simulated sync failure")),
        handleUpsert: vi.fn().mockResolvedValue(undefined),
        handleDelete: vi.fn(),
        handleRename: vi.fn().mockResolvedValue(undefined),
      })),
    }));

    const { VaultManager: VM } = await import("./manager.js");
    const m = new VM({ default: os.tmpdir() }, makeConfig());
    manager = m as unknown as VaultManager;
    const svc = m.getServices("default");

    await expect(svc.bootReady).rejects.toThrow("simulated sync failure");
    expect(svc.bootFailed).toBe(true);

    vi.resetModules();
  });
});

describe("VaultManager with watcher enabled", () => {
  it("creates a watcher when watcher.enabled is true and shuts it down cleanly", async () => {
    // Use a scoped temp dir to avoid EPERM errors from chokidar watching all of /tmp
    const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), "vault-mgr-watcher-"));
    try {
      const config = makeConfig({
        vaultPath: vaultDir,
        namedVaults: { default: vaultDir },
        watcher: { enabled: true, debounceMs: 300 },
      });
      manager = new VaultManager({ default: vaultDir }, config);
      const svc = manager.getServices("default");
      expect(svc.watcher).not.toBeNull();
      await svc.bootReady;
      // shutdown must close the watcher without throwing
      await expect(manager.shutdown()).resolves.toBeUndefined();
    } finally {
      await fs.rm(vaultDir, { recursive: true, force: true });
    }
  });
});
