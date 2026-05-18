import { describe, expect, it } from "bun:test";
import { MockVaultRepository } from "./repository-mock.js";
import type { VaultNote } from "./types.js";

describe("IVaultRepository (MockVaultRepository)", () => {
  it("readNote returns the seeded note", async () => {
    const repo = new MockVaultRepository();
    const note: VaultNote = {
      path: "test/note.md",
      absPath: "/mock-vault/test/note.md",
      name: "note.md",
      content: "Hello world",
      frontmatter: {},
      raw: "Hello world",
      createdAt: 0,
      updatedAt: 0,
    };
    repo.seedNote(note);
    const result = await repo.readNote("test/note");
    expect(result.content).toBe("Hello world");
  });

  it("writeNote stores and returns the note", async () => {
    const repo = new MockVaultRepository();
    const result = await repo.writeNote("inbox/capture", { content: "captured" });
    expect(result.ok).toBe(true);
    expect(result.path).toBe("inbox/capture.md");
  });

  it("moveNote moves the note and removes old path", async () => {
    const repo = new MockVaultRepository();
    await repo.writeNote("old/note", { content: "old" });
    const result = await repo.moveNote("old/note", "new/note");
    expect(result.ok).toBe(true);
    await expect(repo.readNote("old/note")).rejects.toThrow();
    const moved = await repo.readNote("new/note");
    expect(moved.content).toBe("old");
  });

  it("deleteNote removes the note", async () => {
    const repo = new MockVaultRepository();
    await repo.writeNote("to/delete", { content: "bye" });
    const result = await repo.deleteNote("to/delete");
    expect(result.ok).toBe(true);
    await expect(repo.readNote("to/delete")).rejects.toThrow();
  });

  it("softDeleteNote removes the note and returns a trashName", async () => {
    const repo = new MockVaultRepository();
    await repo.writeNote("inbox/note", { content: "trash" });
    const result = await repo.softDeleteNote("inbox/note");
    expect(result.ok).toBe(true);
    expect(result.trashName).toBeTruthy();
  });

  it("updateProperties merges properties", async () => {
    const repo = new MockVaultRepository();
    await repo.writeNote("note", { content: "content", frontmatter: { existing: true } });
    const result = await repo.updateProperties("note", { newProp: "value" });
    expect(result.ok).toBe(true);
    const note = await repo.readNote("note");
    expect(note.frontmatter["existing"]).toBe(true);
    expect(note.frontmatter["newProp"]).toBe("value");
  });

  it("listFolder returns summaries with limit", async () => {
    const repo = new MockVaultRepository();
    for (let i = 0; i < 5; i++) {
      await repo.writeNote(`folder/note-${i}`, { content: `content ${i}` });
    }
    const results = await repo.listFolder("folder", { limit: 3 });
    expect(results.length).toBe(3);
  });

  it("searchByPathOrName filters by query", async () => {
    const repo = new MockVaultRepository();
    await repo.writeNote("projects/alpha", { content: "project alpha" });
    await repo.writeNote("inbox/random", { content: "something" });
    const results = await repo.searchByPathOrName("alpha");
    expect(results.length).toBe(1);
    expect(results[0]?.path).toBe("projects/alpha.md");
  });

  it("vaultPath getter returns the constructor path", () => {
    const repo = new MockVaultRepository("/custom/vault");
    expect(repo.vaultPath).toBe("/custom/vault");
  });
});
