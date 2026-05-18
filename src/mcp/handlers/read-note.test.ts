import { describe, expect, it } from "bun:test";
import { MockVaultRepository } from "../../vault/repository-mock.js";
import type { VaultNote } from "../../vault/types.js";
import { handleVaultReadNote } from "./read-note.js";
import { makeServices } from "./test-helpers.js";

describe("handleVaultReadNote", () => {
  it("returns the note content and metadata", async () => {
    const vault = new MockVaultRepository();
    const note: VaultNote = {
      path: "inbox/test.md",
      absPath: "/mock-vault/inbox/test.md",
      name: "test.md",
      content: "Hello world",
      frontmatter: { type: "note" },
      raw: "Hello world",
      createdAt: 1000,
      updatedAt: 2000,
    };
    vault.seedNote(note);
    const services = makeServices({ vault });

    const result = await handleVaultReadNote({ path: "inbox/test", vault: "default" }, services);
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]?.text ?? "{}").data;
    expect(data.path).toBe("inbox/test.md");
    expect(data.content).toBe("Hello world");
    // absPath should be stripped by toClientNote
    expect(data.absPath).toBeUndefined();
  });

  it("throws when note not found", async () => {
    const services = makeServices();
    await expect(handleVaultReadNote({ path: "nonexistent", vault: "default" }, services)).rejects.toThrow(
      "Note not found: nonexistent",
    );
  });
});
