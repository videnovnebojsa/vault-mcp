import { describe, expect, it, mock } from "bun:test";
import type { ISearchStore } from "../../search/store.js";
import { handleVaultListTags } from "./list-tags.js";
import { makeServices } from "./test-helpers.js";

describe("handleVaultListTags", () => {
  it("returns error when searchStore is not available", async () => {
    const services = makeServices({ searchStore: undefined });
    const result = await handleVaultListTags({ vault: "default" }, services);
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0]?.text ?? "{}");
    expect(data.error.message).toContain("Search index not available");
  });

  it("returns tags from the search store", async () => {
    const listTagsPage = mock().mockReturnValue({
      items: [
        { tag: "work", count: 5 },
        { tag: "personal", count: 3 },
      ],
      total: 2,
    });
    const mockStore = { listTagsPage } as unknown as ISearchStore;
    const services = makeServices({ searchStore: mockStore });

    const result = await handleVaultListTags({ vault: "default" }, services);
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]?.text ?? "{}");
    expect(data.items).toHaveLength(2);
    expect(data.total).toBe(2);
    expect(data.items[0].tag).toBe("work");
  });
});
