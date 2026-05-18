import { describe, expect, it } from "bun:test";
import { MockVaultRepository } from "../../vault/repository-mock.js";
import type { VaultNote } from "../../vault/types.js";
import { handleVaultReadSection } from "./read-section.js";
import { makeServices } from "./test-helpers.js";

describe("handleVaultReadSection", () => {
  it("returns the content of a matching heading section", async () => {
    const vault = new MockVaultRepository();
    const note: VaultNote = {
      path: "test/note.md",
      absPath: "/mock-vault/test/note.md",
      name: "note.md",
      content: "# Introduction\n\nSome intro text.\n\n## Details\n\nDetailed content here.",
      frontmatter: {},
      raw: "",
      createdAt: 0,
      updatedAt: 0,
    };
    vault.seedNote(note);
    const services = makeServices({ vault });

    const result = await handleVaultReadSection({ path: "test/note", heading: "Details", vault: "default" }, services);
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]?.text ?? "{}").data;
    expect(data.content).toContain("Detailed content here");
    expect(data.heading).toBe("Details");
  });

  it("returns isError when heading not found", async () => {
    const vault = new MockVaultRepository();
    const note: VaultNote = {
      path: "test/note.md",
      absPath: "/mock-vault/test/note.md",
      name: "note.md",
      content: "# Only Heading\n\nContent.",
      frontmatter: {},
      raw: "",
      createdAt: 0,
      updatedAt: 0,
    };
    vault.seedNote(note);
    const services = makeServices({ vault });

    const result = await handleVaultReadSection(
      { path: "test/note", heading: "Missing Section", vault: "default" },
      services,
    );
    expect(result.isError).toBe(true);
  });
});
