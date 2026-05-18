import { describe, expect, it, mock, spyOn } from "bun:test";
import type { VaultSync } from "../../search/sync.js";
import { MockVaultRepository } from "../../vault/repository-mock.js";
import { handleVaultMoveNote } from "./move-note.js";
import { makeServices } from "./test-helpers.js";

describe("handleVaultMoveNote", () => {
  it("moves a note successfully", async () => {
    const vault = new MockVaultRepository();
    await vault.writeNote("inbox/to-move", { content: "move me" });
    const handleRename = mock().mockResolvedValue(undefined);
    const vaultSync = { handleRename } as unknown as VaultSync;
    const services = makeServices({ vault, vaultSync });
    const syncTracker = { trackSync: mock() };

    const result = await handleVaultMoveNote(
      { from_path: "inbox/to-move", to_path: "projects/moved", update_backlinks: false, vault: "default" },
      services,
      syncTracker,
    );
    expect(result.isError).toBeFalsy();
    const envelope = JSON.parse(result.content[0]?.text ?? "{}");
    expect(envelope.ok).toBe(true);
    expect(envelope.data.path).toBe("projects/moved.md");
    expect(syncTracker.trackSync).toHaveBeenCalled();
  });

  it("returns isError when source does not exist", async () => {
    const services = makeServices();
    const syncTracker = { trackSync: mock() };
    const result = await handleVaultMoveNote(
      { from_path: "nonexistent", to_path: "somewhere", update_backlinks: true, vault: "default" },
      services,
      syncTracker,
    );
    expect(result.isError).toBe(true);
  });

  it("requires confirmation when destination exists", async () => {
    const vault = new MockVaultRepository();
    await vault.writeNote("inbox/source", { content: "source" });
    await vault.writeNote("projects/existing", { content: "existing" });
    const services = makeServices({ vault });

    const result = await handleVaultMoveNote(
      { from_path: "inbox/source", to_path: "projects/existing", update_backlinks: true, vault: "default" },
      services,
      { trackSync: mock() },
    );

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0]?.text ?? "{}");
    expect(data.error.code).toBe("CONFIRMATION_REQUIRED");
    expect(data.error.message).toContain("confirm");
  });

  it("overwrites an existing destination when confirm=true", async () => {
    const vault = new MockVaultRepository();
    await vault.writeNote("inbox/source", { content: "source" });
    await vault.writeNote("projects/existing", { content: "existing" });
    const moveSpy = spyOn(vault, "moveNote");
    const services = makeServices({ vault });

    const result = await handleVaultMoveNote(
      {
        from_path: "inbox/source",
        to_path: "projects/existing",
        update_backlinks: true,
        confirm: true,
        vault: "default",
      },
      services,
      { trackSync: mock() },
    );

    expect(result.isError).toBeFalsy();
    expect(moveSpy).toHaveBeenCalledWith("inbox/source", "projects/existing", true);
    const moved = await vault.readNote("projects/existing");
    expect(moved.content).toBe("source");
  });
});
