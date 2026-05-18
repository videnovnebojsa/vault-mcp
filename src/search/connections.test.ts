import { describe, expect, it } from "bun:test";
import { findConnections } from "./connections.js";
import { MockEmbedProvider } from "./embed-provider.js";
import type { EmbeddingStore } from "./embeddings.js";
import { VaultSearchStore } from "./store.js";

describe("findConnections", () => {
  it("yields during batch connection scans", async () => {
    const store = new VaultSearchStore(":memory:");
    const embeddings = store.createEmbeddingStore();
    embeddings.initSchema();

    try {
      for (let i = 0; i < 60; i++) {
        const path = `note-${i}.md`;
        store.upsert(path, `content ${i}`, `hash-${i}`, `note-${i}`, {});
        embeddings.upsert(path, new Float32Array([1, i / 100]), `hash-${i}`, "mock");
      }

      let yielded = false;
      setImmediate(() => {
        yielded = true;
      });

      await findConnections({
        limit: 1,
        minSimilarity: 0.99,
        searchStore: store,
        embeddingStore: embeddings,
        embedProvider: new MockEmbedProvider(2),
      });

      expect(yielded).toBe(true);
    } finally {
      store.close();
    }
  });

  it("caps batch connection scans to 50 source notes for a 1000-note vault", async () => {
    const paths = Array.from({ length: 1000 }, (_, i) => `note-${i}.md`);
    let searchCalls = 0;
    const searchStore = {
      getPathIndex: () => new Map(paths.map((path) => [path, path])),
      getContentBatchByPaths: (batch: string[]) => new Map(batch.map((path) => [path, `content for ${path}`])),
    };
    const embeddingStore = {
      getPaths: () => paths,
      getEmbedding: () => new Float32Array([1, 0]),
      search: () => {
        searchCalls++;
        return [];
      },
    };

    const start = performance.now();
    await findConnections({
      limit: 1,
      minSimilarity: 0.99,
      searchStore: searchStore as unknown as VaultSearchStore,
      embeddingStore: embeddingStore as unknown as EmbeddingStore,
      embedProvider: new MockEmbedProvider(2),
    });

    expect(performance.now() - start).toBeLessThan(100);
    expect(searchCalls).toBeLessThanOrEqual(50);
  });
});
