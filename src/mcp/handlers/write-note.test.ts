import { describe, expect, it, mock } from "bun:test";
import type { VaultSync } from "../../search/sync.js";
import type { VaultManager } from "../../vault/manager.js";
import { MockVaultRepository } from "../../vault/repository-mock.js";
import { makeServices, waitFor } from "./test-helpers.js";
import { handleVaultWriteNote } from "./write-note.js";

describe("handleVaultWriteNote", () => {
  it("writes a note and returns success result", async () => {
    const vault = new MockVaultRepository();
    const services = makeServices({ vault });
    const vaultManager = { trackSync: mock() } as unknown as VaultManager;

    const result = await handleVaultWriteNote(
      { path: "inbox/new-note", content: "content here", vault: "default" },
      services,
      vaultManager,
    );
    expect(result.isError).toBeFalsy();
    const envelope = JSON.parse(result.content[0]?.text ?? "{}");
    expect(envelope.ok).toBe(true);
    expect(envelope.data.path).toBe("inbox/new-note.md");
  });

  it("calls trackSync when vaultSync is present", async () => {
    const vault = new MockVaultRepository();
    const handleUpsert = mock().mockResolvedValue(undefined);
    const vaultSync = { handleUpsert } as unknown as VaultSync;
    const trackSync = mock();
    const services = makeServices({ vault, vaultSync });
    const vaultManager = { trackSync } as unknown as VaultManager;

    await handleVaultWriteNote(
      { path: "inbox/new-note", content: "content here", vault: "default" },
      services,
      vaultManager,
    );

    await waitFor(() => expect(trackSync).toHaveBeenCalledOnce());
  });
});
