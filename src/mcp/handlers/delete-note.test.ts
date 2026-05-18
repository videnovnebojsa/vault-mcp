import { describe, expect, it, mock } from "bun:test";
import type { VaultSync } from "../../search/sync.js";
import { MockVaultRepository } from "../../vault/repository-mock.js";
import { handleVaultDeleteNote } from "./delete-note.js";
import { makeServices, waitFor } from "./test-helpers.js";

describe("handleVaultDeleteNote", () => {
  it("soft deletes a note (trash=true, default)", async () => {
    const vault = new MockVaultRepository();
    await vault.writeNote("inbox/to-delete", { content: "delete me" });
    const handleDelete = mock();
    const vaultSync = { handleDelete } as unknown as VaultSync;
    const syncTracker = { trackSync: mock((p: Promise<void>) => void p) };
    const services = makeServices({ vault, vaultSync });

    const result = await handleVaultDeleteNote(
      { path: "inbox/to-delete", trash: true, vault: "default" },
      services,
      syncTracker,
    );
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]?.text ?? "{}");
    expect(data.ok).toBe(true);
    expect(syncTracker.trackSync).toHaveBeenCalled();
    await waitFor(() => expect(handleDelete).toHaveBeenCalledWith("inbox/to-delete.md"));
  });

  it("permanently deletes a note when trash=false and confirm=true", async () => {
    const vault = new MockVaultRepository();
    await vault.writeNote("inbox/perm-delete", { content: "delete me forever" });
    const handleDelete = mock();
    const vaultSync = { handleDelete } as unknown as VaultSync;
    const syncTracker = { trackSync: mock((p: Promise<void>) => void p) };
    const services = makeServices({ vault, vaultSync });

    const result = await handleVaultDeleteNote(
      { path: "inbox/perm-delete", trash: false, confirm: true, vault: "default" },
      services,
      syncTracker,
    );
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]?.text ?? "{}");
    expect(data.ok).toBe(true);
    expect(syncTracker.trackSync).toHaveBeenCalled();
    await waitFor(() => expect(handleDelete).toHaveBeenCalledWith("inbox/perm-delete.md"));
  });

  it("returns CONFIRMATION_REQUIRED when trash=false without confirm=true", async () => {
    const vault = new MockVaultRepository();
    await vault.writeNote("inbox/perm-delete", { content: "delete me forever" });
    const services = makeServices({ vault });

    const result = await handleVaultDeleteNote(
      { path: "inbox/perm-delete", trash: false, vault: "default" },
      services,
      { trackSync: mock() },
    );
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0]?.text ?? "{}");
    expect(data.error.code).toBe("CONFIRMATION_REQUIRED");
  });

  it("returns isError when note does not exist", async () => {
    const services = makeServices();
    const result = await handleVaultDeleteNote({ path: "nonexistent", trash: true, vault: "default" }, services, {
      trackSync: mock(),
    });
    expect(result.isError).toBe(true);
  });

  it("includes trashName in soft delete result [API-07]", async () => {
    const vault = new MockVaultRepository();
    await vault.writeNote("inbox/will-trash", { content: "trash me" });
    const services = makeServices({ vault });

    const result = await handleVaultDeleteNote({ path: "inbox/will-trash", trash: true, vault: "default" }, services, {
      trackSync: mock(),
    });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]?.text ?? "{}");
    expect(data.data).toHaveProperty("trashName");
    expect(typeof data.data.trashName).toBe("string");
    expect(data.data.trashName.length).toBeGreaterThan(0);
  });
});
