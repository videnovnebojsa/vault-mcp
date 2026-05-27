import { describe, expect, it, mock } from "bun:test";
import { VAULT_FOLDERS } from "../../config/folders.js";
import type { EmbeddingStore } from "../../search/embeddings.js";
import type { ISearchStore } from "../../search/store.js";
import { handleVaultFindConnections } from "./find-connections.js";
import { makeServices } from "./test-helpers.js";

describe("handleVaultFindConnections", () => {
  it("returns error when embeddings are not enabled", async () => {
    const services = makeServices();
    const result = await handleVaultFindConnections({ vault: "default" }, services, VAULT_FOLDERS);
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0]?.text ?? "{}");
    expect(data.error.message).toContain("Embeddings not enabled");
  });

  it("finds connections for a single note", async () => {
    const sourceVec = new Float32Array([1, 0]);
    const searchStore = {
      getPathIndex: mock().mockReturnValue(new Map()),
      getContentByPath: mock().mockReturnValue("source content"),
      getContentBatchByPaths: mock().mockReturnValue(new Map([["notes/target.md", "target content"]])),
    };
    const embeddingStore = {
      getEmbedding: mock().mockReturnValue(sourceVec),
      search: mock().mockReturnValue([
        { path: "notes/source.md", similarity: 1 },
        { path: "notes/target.md", similarity: 0.91 },
      ]),
    };
    const services = makeServices({
      searchStore: searchStore as unknown as ISearchStore,
      embeddingStore: embeddingStore as unknown as EmbeddingStore,
      embedProvider: { dimensions: 2, modelName: "test-model", embed: mock() },
    });

    const result = await handleVaultFindConnections(
      { path: "notes/source.md", limit: 2, min_similarity: 0.75, vault: "default" },
      services,
      VAULT_FOLDERS,
    );

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]?.text ?? "{}").data;
    expect(data.count).toBe(1);
    expect(data.suggestions[0]).toEqual({
      source: "notes/source.md",
      target: "notes/target.md",
      similarity: 0.91,
    });
  });

  it("finds batch connection gaps when no note path is supplied", async () => {
    const aVec = new Float32Array([1, 0]);
    const bVec = new Float32Array([0.9, 0.1]);
    const searchStore = {
      getPathIndex: mock().mockReturnValue(new Map()),
      getContentBatchByPaths: mock().mockReturnValue(
        new Map([
          ["notes/a.md", "alpha"],
          ["notes/b.md", "bravo"],
        ]),
      ),
    };
    const embeddingStore = {
      getPaths: mock().mockReturnValue(["notes/a.md", "notes/b.md"]),
      getEmbedding: mock((path: string) => (path === "notes/a.md" ? aVec : bVec)),
      search: mock((embedding: Float32Array) =>
        embedding === aVec
          ? [
              { path: "notes/a.md", similarity: 1 },
              { path: "notes/b.md", similarity: 0.93 },
            ]
          : [
              { path: "notes/b.md", similarity: 1 },
              { path: "notes/a.md", similarity: 0.93 },
            ],
      ),
    };
    const services = makeServices({
      searchStore: searchStore as unknown as ISearchStore,
      embeddingStore: embeddingStore as unknown as EmbeddingStore,
      embedProvider: { dimensions: 2, modelName: "test-model", embed: mock() },
    });

    const result = await handleVaultFindConnections({ limit: 1, min_similarity: 0.75 }, services, VAULT_FOLDERS);

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]?.text ?? "{}").data;
    expect(data.count).toBe(1);
    expect(data.suggestions[0]).toEqual({
      source: "notes/a.md",
      target: "notes/b.md",
      similarity: 0.93,
    });
  });

  it("skips notes in custom archive folder when custom folders supplied [QA-01]", async () => {
    const customFolders = { ...VAULT_FOLDERS, ARCHIVE: "MyArchive" };
    const archiveVec = new Float32Array([1, 0]);
    const normalVec = new Float32Array([0.9, 0.1]);
    const searchStore = {
      getPathIndex: mock().mockReturnValue(new Map()),
      getContentBatchByPaths: mock().mockReturnValue(new Map([["notes/a.md", "content"]])),
    };
    const embeddingStore = {
      getPaths: mock().mockReturnValue(["MyArchive/old.md", "notes/a.md"]),
      getEmbedding: mock((path: string) => (path === "MyArchive/old.md" ? archiveVec : normalVec)),
      search: mock().mockReturnValue([
        { path: "MyArchive/old.md", similarity: 1 },
        { path: "notes/a.md", similarity: 0.95 },
      ]),
    };
    const services = makeServices({
      searchStore: searchStore as unknown as ISearchStore,
      embeddingStore: embeddingStore as unknown as EmbeddingStore,
      embedProvider: { dimensions: 2, modelName: "test-model", embed: mock() },
    });

    const result = await handleVaultFindConnections({ limit: 5, min_similarity: 0.75 }, services, customFolders);

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]?.text ?? "{}").data;
    // MyArchive/ is in skip list — no suggestions from/to archive notes
    expect(data.suggestions.every((s: { source: string }) => !s.source.startsWith("MyArchive/"))).toBe(true);
  });
});
