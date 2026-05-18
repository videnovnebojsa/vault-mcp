import { describe, expect, it, mock, spyOn } from "bun:test";
import type { VaultSync } from "../../search/sync.js";
import { VaultErrorCode } from "../../utils/errors.js";
import type { VaultManager } from "../../vault/manager.js";
import { MockVaultRepository } from "../../vault/repository-mock.js";
import { handleVaultBatch } from "./batch.js";
import { makeServices, waitFor } from "./test-helpers.js";

describe("handleVaultBatch", () => {
  it("returns empty results for empty operations list", async () => {
    const services = makeServices();
    const vaultManager = { trackSync: mock() } as unknown as VaultManager;
    const result = await handleVaultBatch({ operations: [], vault: "default" }, services, vaultManager);
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]?.text ?? "{}");
    expect(data.data.operations).toHaveLength(0);
    expect(data.data.processedCount).toBe(0);
    expect(data.data.total).toBeUndefined();
  });

  it("returns error result for move without to_path", async () => {
    const services = makeServices();
    const vaultManager = { trackSync: mock() } as unknown as VaultManager;
    const result = await handleVaultBatch(
      { operations: [{ type: "move", path: "Notes/foo.md" }], vault: "default" },
      services,
      vaultManager,
    );
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]?.text ?? "{}");
    expect(data.data.operations[0].ok).toBe(false);
    expect(data.data.operations[0].code).toBe(VaultErrorCode.VALIDATION);
    expect(data.data.operations[0].message).toContain("to_path");
  });

  it("returns error result for update_properties without properties", async () => {
    const services = makeServices();
    const vaultManager = { trackSync: mock() } as unknown as VaultManager;
    const result = await handleVaultBatch(
      { operations: [{ type: "update_properties", path: "Notes/foo.md" }], vault: "default" },
      services,
      vaultManager,
    );
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]?.text ?? "{}");
    expect(data.data.operations[0].ok).toBe(false);
    expect(data.data.operations[0].code).toBe(VaultErrorCode.VALIDATION);
    expect(data.data.operations[0].message).toContain("properties");
  });

  it("returns machine-readable codes for repository failures [API-04]", async () => {
    const vault = new MockVaultRepository();
    const services = makeServices({ vault });
    const vaultManager = { trackSync: mock() } as unknown as VaultManager;

    const result = await handleVaultBatch(
      { operations: [{ type: "move", path: "Notes/missing.md", to_path: "Archive/missing.md" }], vault: "default" },
      services,
      vaultManager,
    );

    const data = JSON.parse(result.content[0]?.text ?? "{}");
    expect(data.data.operations[0]).toMatchObject({
      ok: false,
      code: VaultErrorCode.NOT_FOUND,
    });
  });

  it("returns error result for an unknown operation type", async () => {
    const services = makeServices();
    const vaultManager = { trackSync: mock() } as unknown as VaultManager;
    const result = await handleVaultBatch(
      { operations: [{ type: "archive", path: "Notes/foo.md" }], vault: "default" },
      services,
      vaultManager,
    );
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]?.text ?? "{}");
    expect(data.data.operations[0].ok).toBe(false);
    expect(data.data.operations[0].message).toContain("Unknown batch operation type");
  });

  it("calls trackSync when update_properties succeeds with vaultSync", async () => {
    const vault = new MockVaultRepository();
    // Pre-seed a note in the mock
    await vault.writeNote("Notes/foo.md", { content: "hello" });
    const handleUpsert = mock().mockResolvedValue(undefined);
    const vaultSync = { handleUpsert } as unknown as VaultSync;
    const trackSync = mock();
    const vaultManager = { trackSync } as unknown as VaultManager;
    const services = makeServices({ vault, vaultSync });

    await handleVaultBatch(
      {
        operations: [{ type: "update_properties", path: "Notes/foo.md", properties: { status: "done" } }],
        vault: "default",
      },
      services,
      vaultManager,
    );
    await waitFor(() => expect(trackSync).toHaveBeenCalled());
  });

  it("continues on error when continue_on_error is true", async () => {
    const services = makeServices();
    const vaultManager = { trackSync: mock() } as unknown as VaultManager;
    const result = await handleVaultBatch(
      {
        operations: [
          { type: "move", path: "Notes/foo.md" }, // missing to_path
          { type: "move", path: "Notes/bar.md" }, // also missing to_path
        ],
        continue_on_error: true,
        vault: "default",
      },
      services,
      vaultManager,
    );
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]?.text ?? "{}");
    expect(data.data.operations).toHaveLength(2);
    expect(data.data.operations[0].ok).toBe(false);
    expect(data.data.operations[1].ok).toBe(false);
  });

  it("updates wikilinks after a successful move", async () => {
    const vault = new MockVaultRepository();
    await vault.writeNote("Notes/foo.md", { content: "hello" });
    const updateWikilinks = spyOn(vault, "updateWikilinks").mockResolvedValue({ updated: 2, errors: [] });
    const services = makeServices({ vault });
    const vaultManager = { trackSync: mock() } as unknown as VaultManager;

    const result = await handleVaultBatch(
      {
        operations: [{ type: "move", path: "Notes/foo.md", to_path: "Archive/foo.md" }],
        vault: "default",
      },
      services,
      vaultManager,
    );

    const data = JSON.parse(result.content[0]?.text ?? "{}");
    expect(data.data.operations[0]).toMatchObject({ ok: true, backlinksUpdated: 2 });
    expect(updateWikilinks).toHaveBeenCalledWith("Notes/foo", "Archive/foo", undefined);
  });

  it("forwards confirm=true to moveNote so batch moves can overwrite [API-01]", async () => {
    const vault = new MockVaultRepository();
    await vault.writeNote("Notes/foo.md", { content: "hello" });
    await vault.writeNote("Archive/foo.md", { content: "existing" });
    const moveSpy = spyOn(vault, "moveNote");
    const services = makeServices({ vault });
    const vaultManager = { trackSync: mock() } as unknown as VaultManager;

    const result = await handleVaultBatch(
      {
        operations: [{ type: "move", path: "Notes/foo.md", to_path: "Archive/foo.md", confirm: true }],
        vault: "default",
      },
      services,
      vaultManager,
    );

    const data = JSON.parse(result.content[0]?.text ?? "{}");
    expect(data.data.operations[0]).toMatchObject({ ok: true, path: "Archive/foo.md" });
    expect(moveSpy).toHaveBeenCalledWith("Notes/foo.md", "Archive/foo.md", true);
  });

  it("soft-deletes a note when trash=true and records ok result", async () => {
    const vault = new MockVaultRepository();
    await vault.writeNote("Notes/foo.md", { content: "hello" });
    const services = makeServices({ vault });
    const vaultManager = { trackSync: mock() } as unknown as VaultManager;

    const result = await handleVaultBatch(
      { operations: [{ type: "delete", path: "Notes/foo.md", trash: true }], vault: "default" },
      services,
      vaultManager,
    );
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]?.text ?? "{}");
    expect(data.data.operations[0]).toMatchObject({ ok: true, type: "delete" });
  });

  it("requires confirm=true for permanent delete operations", async () => {
    const vault = new MockVaultRepository();
    await vault.writeNote("Notes/foo.md", { content: "hello" });
    const deleteSpy = spyOn(vault, "deleteNote");
    const services = makeServices({ vault });
    const vaultManager = { trackSync: mock() } as unknown as VaultManager;

    const result = await handleVaultBatch(
      { operations: [{ type: "delete", path: "Notes/foo.md", trash: false }], vault: "default" },
      services,
      vaultManager,
    );

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]?.text ?? "{}");
    expect(data.data.operations[0].ok).toBe(false);
    expect(data.data.operations[0].message).toContain("confirm=true");
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it("permanently deletes when trash=false and confirm=true", async () => {
    const vault = new MockVaultRepository();
    await vault.writeNote("Notes/foo.md", { content: "hello" });
    const deleteSpy = spyOn(vault, "deleteNote");
    const handleDelete = mock();
    const vaultSync = { handleDelete } as unknown as VaultSync;
    const trackSync = mock((p: Promise<void>) => void p);
    const services = makeServices({ vault, vaultSync });

    const result = await handleVaultBatch(
      { operations: [{ type: "delete", path: "Notes/foo.md", trash: false, confirm: true }], vault: "default" },
      services,
      { trackSync },
    );

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]?.text ?? "{}");
    expect(data.data.operations[0]).toMatchObject({ type: "delete", ok: true, path: "Notes/foo.md" });
    expect(deleteSpy).toHaveBeenCalledWith("Notes/foo.md");
    expect(trackSync).toHaveBeenCalled();
    await waitFor(() => expect(handleDelete).toHaveBeenCalledWith("Notes/foo.md"));
    await expect(vault.readNote("Notes/foo.md")).rejects.toThrow();
  });
});
