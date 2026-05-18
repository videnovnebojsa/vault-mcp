import { describe, expect, it, mock } from "bun:test";
import type { VaultSync } from "../../search/sync.js";
import { handleVaultSync } from "./sync.js";
import { makeServices } from "./test-helpers.js";

function makeSyncServices() {
  const runFullSync = mock().mockResolvedValue({
    scanned: 10,
    upserted: 5,
    deleted: 1,
    durationMs: 100,
  });
  const isSyncing = mock().mockReturnValue(false);
  const vaultSync = { runFullSync, isSyncing } as unknown as VaultSync;
  return makeServices({ vaultSync });
}

describe("handleVaultSync", () => {
  it("runs full sync and returns stats", async () => {
    const services = makeSyncServices();
    const result = await handleVaultSync({ vault: "default" }, services);
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]?.text ?? "{}").data;
    expect(data.scanned).toBe(10);
    expect(data.upserted).toBe(5);
    expect(data.durationMs).toBe(100);
  });

  it("returns ALREADY_RUNNING error when a sync is already active", async () => {
    const services = makeSyncServices();
    services.vaultSync.isSyncing = mock().mockReturnValue(true);

    const result = await handleVaultSync({ vault: "default" }, services);
    const envelope = JSON.parse(result.content[0]?.text ?? "{}");

    expect(result.isError).toBe(true);
    expect(envelope).toMatchObject({
      ok: false,
      error: { code: "ALREADY_RUNNING", message: "Sync already in progress" },
    });
    expect(services.vaultSync.runFullSync).not.toHaveBeenCalled();
  });
});
