import { describe, expect, it } from "bun:test";
import { MockVaultRepository } from "../../vault/repository-mock.js";
import type { VaultNote } from "../../vault/types.js";
import { handleVaultReadNoteWithLinks } from "./note-with-links.js";
import { makeServices } from "./test-helpers.js";

describe("handleVaultReadNoteWithLinks", () => {
  it("returns the note and resolves linked notes", async () => {
    const vault = new MockVaultRepository();
    const linkedNote: VaultNote = {
      path: "projects/alpha.md",
      absPath: "/mock-vault/projects/alpha.md",
      name: "alpha.md",
      content: "Alpha project",
      frontmatter: {},
      raw: "",
      createdAt: 0,
      updatedAt: 0,
    };
    vault.seedNote(linkedNote);

    const mainNote: VaultNote = {
      path: "inbox/main.md",
      absPath: "/mock-vault/inbox/main.md",
      name: "main.md",
      content: "See [[projects/alpha]] for details.",
      frontmatter: {},
      raw: "",
      createdAt: 0,
      updatedAt: 0,
    };
    vault.seedNote(mainNote);

    const services = makeServices({ vault });
    const result = await handleVaultReadNoteWithLinks(
      { path: "inbox/main", max_links: 10, include_content: false, snippet_length: 200, vault: "default" },
      services,
    );
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]?.text ?? "{}").data;
    expect(data.note.path).toBe("inbox/main.md");
    expect(data.linked_notes).toHaveLength(1);
    expect(data.linked_notes[0].path).toBe("projects/alpha.md");
  });

  it("returns error placeholder for unresolvable links", async () => {
    const vault = new MockVaultRepository();
    const note: VaultNote = {
      path: "inbox/broken.md",
      absPath: "/mock-vault/inbox/broken.md",
      name: "broken.md",
      content: "See [[missing/note]] for details.",
      frontmatter: {},
      raw: "",
      createdAt: 0,
      updatedAt: 0,
    };
    vault.seedNote(note);

    const services = makeServices({ vault });
    const result = await handleVaultReadNoteWithLinks(
      { path: "inbox/broken", max_links: 10, include_content: false, snippet_length: 200, vault: "default" },
      services,
    );
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]?.text ?? "{}").data;
    expect(data.linked_notes[0].error).toEqual({ code: "NOT_FOUND", message: "Note not found" });
  });

  it("error path uses basename of unresolvable link [SEC-04]", async () => {
    const vault = new MockVaultRepository();
    const note: VaultNote = {
      path: "inbox/broken.md",
      absPath: "/mock-vault/inbox/broken.md",
      name: "broken.md",
      content: "See [[folder/subpath/NoteTitle]] for details.",
      frontmatter: {},
      raw: "",
      createdAt: 0,
      updatedAt: 0,
    };
    vault.seedNote(note);

    const services = makeServices({ vault });
    const result = await handleVaultReadNoteWithLinks(
      { path: "inbox/broken", max_links: 10, include_content: false, snippet_length: 200, vault: "default" },
      services,
    );
    const data = JSON.parse(result.content[0]?.text ?? "{}").data;
    expect(data.linked_notes[0].path).toBe("NoteTitle");
    expect(data.linked_notes[0].error).toEqual({ code: "NOT_FOUND", message: "Note not found" });
  });

  it("returns linked note with full content when include_content is true [QA-04]", async () => {
    const vault = new MockVaultRepository();
    const linkedNote: VaultNote = {
      path: "notes/detail.md",
      absPath: "/mock-vault/notes/detail.md",
      name: "detail.md",
      content: "Full content here, longer than any snippet.",
      frontmatter: { type: "note" },
      raw: "",
      createdAt: 0,
      updatedAt: 0,
    };
    vault.seedNote(linkedNote);

    const mainNote: VaultNote = {
      path: "inbox/main.md",
      absPath: "/mock-vault/inbox/main.md",
      name: "main.md",
      content: "See [[notes/detail]] for details.",
      frontmatter: {},
      raw: "",
      createdAt: 0,
      updatedAt: 0,
    };
    vault.seedNote(mainNote);

    const services = makeServices({ vault });
    const result = await handleVaultReadNoteWithLinks(
      { path: "inbox/main", max_links: 10, include_content: true, snippet_length: 200, vault: "default" },
      services,
    );
    const data = JSON.parse(result.content[0]?.text ?? "{}").data;
    const linked = data.linked_notes[0];
    expect(linked.content).toBe("Full content here, longer than any snippet.");
    expect(linked.snippet).toBeUndefined();
  });

  it("respects snippet_length when include_content is false [QA-04]", async () => {
    const vault = new MockVaultRepository();
    const linkedNote: VaultNote = {
      path: "notes/long.md",
      absPath: "/mock-vault/notes/long.md",
      name: "long.md",
      content: "ABCDEFGHIJ",
      frontmatter: {},
      raw: "",
      createdAt: 0,
      updatedAt: 0,
    };
    vault.seedNote(linkedNote);

    const mainNote: VaultNote = {
      path: "inbox/main.md",
      absPath: "/mock-vault/inbox/main.md",
      name: "main.md",
      content: "See [[notes/long]] for details.",
      frontmatter: {},
      raw: "",
      createdAt: 0,
      updatedAt: 0,
    };
    vault.seedNote(mainNote);

    const services = makeServices({ vault });
    const result = await handleVaultReadNoteWithLinks(
      { path: "inbox/main", max_links: 10, include_content: false, snippet_length: 5, vault: "default" },
      services,
    );
    const data = JSON.parse(result.content[0]?.text ?? "{}").data;
    const linked = data.linked_notes[0];
    expect(linked.snippet).toBe("ABCDE");
    expect(linked.content).toBeUndefined();
  });
});
