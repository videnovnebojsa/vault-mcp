import { describe, expect, it, mock } from "bun:test";
import type { EmbeddingStore } from "../../search/embeddings.js";
import type { ISearchStore } from "../../search/store.js";
import { handleVaultEmbedBacklog } from "./embed-backlog.js";
import { makeServices } from "./test-helpers.js";

describe("handleVaultEmbedBacklog", () => {
  it("returns error when embeddings not enabled", async () => {
    const services = makeServices();
    const result = await handleVaultEmbedBacklog({ vault: "default" }, services);
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0]?.text ?? "{}");
    expect(data.error.message).toContain("Embeddings not enabled");
  });

  it("embeds stale indexed notes and reports backlog progress", async () => {
    const searchStore = {
      getContentBatchByPaths: mock().mockReturnValue(new Map([["notes/a.md", "alpha content"]])),
    };
    const embeddingStore = {
      deleteOrphansFromVaultEntries: mock().mockReturnValue(1),
      getStaleOrMissingPage: mock().mockReturnValue([{ path: "notes/a.md", contentHash: "hash-a" }]),
      getStaleOrMissingPageWithTotal: mock().mockReturnValue({
        rows: [{ path: "notes/a.md", contentHash: "hash-a" }],
        total: 3,
      }),
      countStaleOrMissing: mock().mockReturnValue(3),
      upsert: mock(),
    };
    const embedProvider = {
      modelName: "test-model",
      dimensions: 2,
      embed: mock().mockResolvedValue([new Float32Array([1, 0])]),
    };
    const services = makeServices({
      searchStore: searchStore as unknown as ISearchStore,
      embeddingStore: embeddingStore as unknown as EmbeddingStore,
      embedProvider,
      embeddingConfig: {
        enabled: true,
        apiKey: "",
        endpoint: "",
        model: "test-model",
        hybridAlpha: 0.5,
        batchSize: 10,
      },
    });

    const result = await handleVaultEmbedBacklog({ max_notes: 1, vault: "default" }, services);

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]?.text ?? "{}").data;
    expect(data.remaining).toBe(2);
    expect(data.message).toContain("Embedded 1 notes");
    expect(embeddingStore.deleteOrphansFromVaultEntries).toHaveBeenCalled();
    expect(embedProvider.embed).toHaveBeenCalledWith(["alpha content"]);
    expect(embeddingStore.upsert).toHaveBeenCalledWith("notes/a.md", expect.any(Float32Array), "hash-a", "test-model");
  });
});
