import { describe, expect, it } from "bun:test";
import { MockVaultRepository } from "../../vault/repository-mock.js";
import { handleVaultListFolder } from "./list-folder.js";
import { makeServices } from "./test-helpers.js";

describe("handleVaultListFolder", () => {
  it("lists notes from the vault", async () => {
    const vault = new MockVaultRepository();
    await vault.writeNote("inbox/note1", { content: "note 1" });
    await vault.writeNote("inbox/note2", { content: "note 2" });
    const services = makeServices({ vault });

    const result = await handleVaultListFolder({ folder: "inbox", vault: "default" }, services);
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]?.text ?? "{}");
    expect(data.items.length).toBe(2);
    expect(data.total).toBe(2);
    expect(data.hasMore).toBe(false);
  });

  it("respects limit option", async () => {
    const vault = new MockVaultRepository();
    for (let i = 0; i < 10; i++) {
      await vault.writeNote(`inbox/note-${i}`, { content: `note ${i}` });
    }
    const services = makeServices({ vault });

    const result = await handleVaultListFolder({ folder: "inbox", limit: 3, vault: "default" }, services);
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]?.text ?? "{}");
    expect(data.items.length).toBe(3);
    expect(data.hasMore).toBe(true);
  });

  it("respects offset option beyond the first page", async () => {
    const vault = new MockVaultRepository();
    for (let i = 0; i < 5; i++) {
      await vault.writeNote(`inbox/note-${i}`, { content: `note ${i}` });
    }
    const services = makeServices({ vault });

    const result = await handleVaultListFolder({ folder: "inbox", limit: 2, offset: 2, vault: "default" }, services);
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]?.text ?? "{}");
    expect(data.items.map((item: { path: string }) => item.path)).toEqual(["inbox/note-2.md", "inbox/note-3.md"]);
    expect(data.total).toBe(5);
    expect(data.hasMore).toBe(true);
    expect(data.nextOffset).toBe(4);
  });
});
