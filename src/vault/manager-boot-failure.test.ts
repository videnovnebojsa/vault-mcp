import { afterEach, describe, expect, it, mock } from "bun:test";
import os from "node:os";
import type { VaultConfig } from "../config.js";
import type { VaultManager } from "./manager.js";

// This file is isolated so mock.module("../search/sync.js") only affects this file.
mock.module("../search/sync.js", () => ({
  VaultSync: mock().mockImplementation(() => ({
    runFullSync: mock().mockRejectedValue(new Error("simulated sync failure")),
    handleUpsert: mock().mockResolvedValue(undefined),
    handleDelete: mock(),
    handleRename: mock().mockResolvedValue(undefined),
  })),
  toCanonicalPath: (p: string) => p.replace(/\\/g, "/"),
}));

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
    },
    backup: { enabled: false, dir: os.tmpdir(), maxBackups: 5 },
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

describe("VaultManager boot failure propagation — injected failing sync", () => {
  let manager: VaultManager | undefined;

  afterEach(async () => {
    await manager?.shutdown();
    manager = undefined;
  });

  it("bootFailed is true and bootReady rejects when runFullSync throws", async () => {
    const { VaultManager: VM } = await import("./manager.js");
    const m = new VM({ default: os.tmpdir() }, makeConfig());
    manager = m as unknown as VaultManager;
    const svc = m.getServices("default");

    await expect(svc.bootReady).rejects.toThrow("simulated sync failure");
    expect(svc.bootFailed).toBe(true);
  });
});
