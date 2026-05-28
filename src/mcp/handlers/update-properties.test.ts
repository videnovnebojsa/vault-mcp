import { describe, expect, it, mock } from "bun:test";
import type { SyncTracker } from "../../vault/manager.js";
import { MockVaultRepository } from "../../vault/repository-mock.js";
import { makeServices } from "./test-helpers.js";
import { handleVaultUpdateProperties } from "./update-properties.js";

describe("handleVaultUpdateProperties", () => {
  it("merges new properties into existing frontmatter", async () => {
    const vault = new MockVaultRepository();
    await vault.writeNote("inbox/note", { content: "content", frontmatter: { existing: "value" } });
    const vaultManager: SyncTracker = { trackSync: mock() };
    const services = makeServices({ vault });

    const result = await handleVaultUpdateProperties(
      { path: "inbox/note", properties: { new_prop: "new" }, vault: "default" },
      services,
      vaultManager,
    );
    expect(result.isError).toBeFalsy();
    const envelope = JSON.parse(result.content[0]?.text ?? "{}");
    expect(envelope.ok).toBe(true);
    expect(envelope.data.ok).toBe(true);
  });

  it("does not expose internal absPath fields in the response [API-01]", async () => {
    const vault = new MockVaultRepository();
    await vault.writeNote("inbox/note", { content: "content", frontmatter: { existing: "value" } });
    const vaultManager: SyncTracker = { trackSync: mock() };
    const services = makeServices({ vault });

    const result = await handleVaultUpdateProperties(
      { path: "inbox/note", properties: { new_prop: "new" }, vault: "default" },
      services,
      vaultManager,
    );

    const envelope = JSON.parse(result.content[0]?.text ?? "{}");
    expect(envelope.data.note).toBeDefined();
    expect(envelope.data.note).not.toHaveProperty("absPath");
  });

  it("throws when note not found", async () => {
    const services = makeServices();
    const vaultManager: SyncTracker = { trackSync: mock() };
    await expect(
      handleVaultUpdateProperties(
        { path: "nonexistent", properties: { x: 1 }, vault: "default" },
        services,
        vaultManager,
      ),
    ).rejects.toThrow("Note not found");
  });
});
