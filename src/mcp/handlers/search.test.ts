import { afterEach, describe, expect, it, jest, mock } from "bun:test";
import type { EmbedProvider } from "../../search/embed-provider.js";
import type { EmbeddingStore } from "../../search/embeddings.js";
import type { ISearchStore } from "../../search/store.js";
import { applyAclFilter, applyMetadataFilters } from "../../search/utils.js";
import { VaultErrorCode } from "../../utils/errors.js";
import { MockVaultRepository } from "../../vault/repository-mock.js";
import { handleVaultSearch, resetQueryEmbeddingCache } from "./search.js";
import { makeServices } from "./test-helpers.js";

describe("handleVaultSearch", () => {
  afterEach(() => {
    resetQueryEmbeddingCache();
    jest.useRealTimers();
  });

  it("falls back to vault.searchByPathOrName when no searchStore", async () => {
    const vault = new MockVaultRepository();
    await vault.writeNote("inbox/test-note", { content: "test content" });
    const services = makeServices({ vault });

    const result = await handleVaultSearch({ query: "test", vault: "default" }, services);
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]?.text ?? "{}");
    expect(data.items.length).toBeGreaterThan(0);
    expect(data.items[0].path).toContain("test-note");
  });

  it("uses FTS search when searchStore is available", async () => {
    const searchFTS = mock().mockReturnValue([
      { path: "inbox/result.md", name: "result", score: 1.5, snippet: "...", frontmatter: {} },
    ]);
    const mockStore = { searchFTS, getByPath: mock().mockReturnValue(undefined) } as unknown as ISearchStore;
    const services = makeServices({ searchStore: mockStore });

    const result = await handleVaultSearch({ query: "hello", vault: "default", mode: "keyword" }, services);
    expect(result.isError).toBeFalsy();
    expect(searchFTS).toHaveBeenCalled();
    const data = JSON.parse(result.content[0]?.text ?? "{}");
    expect(data.items).toHaveLength(1);
    expect(data.items[0].path).toBe("inbox/result.md");
    expect(data.items[0].name).toBe("result");
  });

  it("applies offset to fallback path/name search", async () => {
    const vault = new MockVaultRepository();
    await vault.writeNote("inbox/test-a", { content: "test content" });
    await vault.writeNote("inbox/test-b", { content: "test content" });
    await vault.writeNote("inbox/test-c", { content: "test content" });
    const services = makeServices({ vault });

    const result = await handleVaultSearch({ query: "test", limit: 1, offset: 1, vault: "default" }, services);
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]?.text ?? "{}");
    expect(data.items).toHaveLength(1);
    expect(data.items[0].path).toContain("test-b");
    expect(data.hasMore).toBe(true);
    expect(data.total).toBe(3);
  });

  it("omits nextOffset when search results end on the current page", async () => {
    const searchFTS = mock().mockReturnValue([
      { path: "inbox/only.md", name: "only", score: 1, snippet: "...", frontmatter: {} },
    ]);
    const services = makeServices({ searchStore: { searchFTS } as unknown as ISearchStore });

    const result = await handleVaultSearch({ query: "only", limit: 2, mode: "keyword", vault: "default" }, services);

    expect(result.isError).toBeFalsy();
    expect(searchFTS).toHaveBeenCalledWith("only", 3, undefined, undefined, {
      allowPaths: [],
      denyPaths: [],
    });
    const data = JSON.parse(result.content[0]?.text ?? "{}");
    expect(data.items).toHaveLength(1);
    expect(data.total).toBe(1);
    expect(data.hasMore).toBe(false);
    expect(data.nextOffset).toBeUndefined();
  });

  it("applies created_after to fallback path/name search", async () => {
    const vault = new MockVaultRepository();
    vault.seedNote({
      path: "inbox/old-note.md",
      absPath: "/mock-vault/inbox/old-note.md",
      name: "old-note.md",
      content: "test content",
      frontmatter: {},
      raw: "test content",
      createdAt: 100,
      updatedAt: 100,
    });
    vault.seedNote({
      path: "inbox/new-note.md",
      absPath: "/mock-vault/inbox/new-note.md",
      name: "new-note.md",
      content: "test content",
      frontmatter: {},
      raw: "test content",
      createdAt: 1_000,
      updatedAt: 1_000,
    });
    const services = makeServices({ vault });

    const result = await handleVaultSearch(
      {
        query: "note",
        created_after: new Date(500).toISOString(),
        vault: "default",
      },
      services,
    );
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]?.text ?? "{}");
    expect(data.items.map((item: { path: string }) => item.path)).toEqual(["inbox/new-note.md"]);
  });

  it("returns MODE_UNAVAILABLE when semantic mode is requested without embeddings", async () => {
    const services = makeServices();
    const result = await handleVaultSearch({ query: "test", mode: "semantic", vault: "default" }, services);
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0]?.text ?? "{}");
    expect(data.error.code).toBe("MODE_UNAVAILABLE");
  });

  it("applies offset to semantic search results", async () => {
    const entries = new Map([
      ["a.md", { fileName: "a", content: "a", metadata: {}, updatedAt: 1, createdAt: 1 }],
      ["b.md", { fileName: "b", content: "b", metadata: {}, updatedAt: 2, createdAt: 2 }],
      ["c.md", { fileName: "c", content: "c", metadata: {}, updatedAt: 3, createdAt: 3 }],
    ]);
    const services = makeServices({
      searchStore: { getBatchByPaths: mock().mockReturnValue(entries) } as unknown as ISearchStore,
      embeddingStore: {
        size: 3,
        search: mock().mockReturnValue([
          { path: "a.md", similarity: 0.9 },
          { path: "b.md", similarity: 0.8 },
          { path: "c.md", similarity: 0.7 },
        ]),
      } as unknown as EmbeddingStore,
      embedProvider: { embed: mock().mockResolvedValue([new Float32Array([1])]) } as unknown as EmbedProvider,
      embeddingConfig: {
        enabled: true,
        apiKey: "",
        endpoint: "",
        model: "",
        hybridAlpha: 0.5,
        batchSize: 20,
      },
    });

    const result = await handleVaultSearch({ query: "test", mode: "semantic", limit: 1, offset: 1 }, services);
    const data = JSON.parse(result.content[0]?.text ?? "{}");
    expect(data.items.map((item: { path: string }) => item.path)).toEqual(["b.md"]);
    expect(data.hasMore).toBe(true);
    expect(data.total).toBe(3);
  });

  it("continues semantic search when metadata filters empty the first candidate window", async () => {
    const initialCandidates = Array.from({ length: 100 }, (_, i) => ({
      path: `plain-${i}.md`,
      similarity: 1 - i / 1000,
    }));
    const expandedCandidates = [...initialCandidates, { path: "projects/match.md", similarity: 0.5 }];
    const entries = new Map([
      ...initialCandidates.map(
        (candidate) =>
          [
            candidate.path,
            { fileName: candidate.path, content: "plain", metadata: { type: "note" }, updatedAt: 1, createdAt: 1 },
          ] as const,
      ),
      [
        "projects/match.md",
        { fileName: "match", content: "project", metadata: { type: "project" }, updatedAt: 2, createdAt: 2 },
      ],
    ]);
    const search = mock((_: Float32Array, limit: number) => (limit <= 100 ? initialCandidates : expandedCandidates));
    const services = makeServices({
      searchStore: { getBatchByPaths: mock().mockReturnValue(entries) } as unknown as ISearchStore,
      embeddingStore: {
        size: expandedCandidates.length,
        search,
      } as unknown as EmbeddingStore,
      embedProvider: {
        embed: mock().mockResolvedValue([new Float32Array([1])]),
        modelName: "m",
      } as unknown as EmbedProvider,
      embeddingConfig: {
        enabled: true,
        apiKey: "",
        endpoint: "",
        model: "m",
        hybridAlpha: 0.5,
        batchSize: 20,
      },
    });

    const result = await handleVaultSearch({ query: "test", mode: "semantic", limit: 1, type: "project" }, services);

    const data = JSON.parse(result.content[0]?.text ?? "{}");
    expect(data.items.map((item: { path: string }) => item.path)).toEqual(["projects/match.md"]);
    expect(search.mock.calls.map((call) => call[1])).toEqual([101]);
  });

  it("hydrates only returned semantic page entries when no metadata filters are present", async () => {
    const getBatchByPaths = mock(
      (paths: string[]) =>
        new Map(
          paths.map((path) => [
            path,
            { fileName: path.replace(/\.md$/, ""), content: path, metadata: {}, updatedAt: 1, createdAt: 1 },
          ]),
        ),
    );
    const services = makeServices({
      searchStore: { getBatchByPaths } as unknown as ISearchStore,
      embeddingStore: {
        size: 3,
        search: mock().mockReturnValue([
          { path: "a.md", similarity: 0.9 },
          { path: "b.md", similarity: 0.8 },
          { path: "c.md", similarity: 0.7 },
        ]),
      } as unknown as EmbeddingStore,
      embedProvider: {
        embed: mock().mockResolvedValue([new Float32Array([1])]),
        modelName: "m",
      } as unknown as EmbedProvider,
      embeddingConfig: {
        enabled: true,
        apiKey: "",
        endpoint: "",
        model: "m",
        hybridAlpha: 0.5,
        batchSize: 20,
      },
    });

    const result = await handleVaultSearch({ query: "test", mode: "semantic", limit: 1, offset: 1 }, services);

    const data = JSON.parse(result.content[0]?.text ?? "{}");
    expect(data.items.map((item: { path: string }) => item.path)).toEqual(["b.md"]);
    expect(getBatchByPaths).toHaveBeenCalledWith(["b.md"]);
  });

  it("reuses cached query embeddings for repeated semantic searches", async () => {
    const embed = mock().mockResolvedValue([new Float32Array([1])]);
    const services = makeServices({
      searchStore: {
        getBatchByPaths: mock().mockReturnValue(
          new Map([["a.md", { fileName: "a", content: "alpha", metadata: {}, updatedAt: 1, createdAt: 1 }]]),
        ),
      } as unknown as ISearchStore,
      embeddingStore: {
        size: 1,
        search: mock().mockReturnValue([{ path: "a.md", similarity: 0.9 }]),
      } as unknown as EmbeddingStore,
      embedProvider: { embed, modelName: "test-cache-model" } as unknown as EmbedProvider,
      embeddingConfig: {
        enabled: true,
        apiKey: "",
        endpoint: "",
        model: "test-cache-model",
        hybridAlpha: 0.5,
        batchSize: 20,
      },
    });

    await handleVaultSearch({ query: "cache me once", mode: "semantic" }, services);
    await handleVaultSearch({ query: "cache me once", mode: "semantic" }, services);

    expect(embed).toHaveBeenCalledOnce();
  });

  it("evicts cached query embeddings using the configured cache max", async () => {
    const embed = mock().mockResolvedValue([new Float32Array([1])]);
    const services = makeServices({
      searchStore: {
        getBatchByPaths: mock().mockReturnValue(new Map()),
      } as unknown as ISearchStore,
      embeddingStore: {
        size: 1,
        search: mock().mockReturnValue([]),
      } as unknown as EmbeddingStore,
      embedProvider: { embed, modelName: "test-cache-model" } as unknown as EmbedProvider,
      embeddingConfig: {
        enabled: true,
        apiKey: "",
        endpoint: "",
        model: "test-cache-model",
        hybridAlpha: 0.5,
        batchSize: 20,
        queryCacheMax: 1,
      },
    });

    await handleVaultSearch({ query: "first", mode: "semantic" }, services);
    await handleVaultSearch({ query: "second", mode: "semantic" }, services);
    await handleVaultSearch({ query: "first", mode: "semantic" }, services);

    expect(embed).toHaveBeenCalledTimes(3);
  });

  it("expires cached query embeddings after the ttl", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-05-14T00:00:00Z"));
    const embed = mock().mockResolvedValue([new Float32Array([1])]);
    const services = makeServices({
      searchStore: {
        getBatchByPaths: mock().mockReturnValue(new Map()),
      } as unknown as ISearchStore,
      embeddingStore: {
        size: 1,
        search: mock().mockReturnValue([]),
      } as unknown as EmbeddingStore,
      embedProvider: { embed, modelName: "test-cache-model" } as unknown as EmbedProvider,
      embeddingConfig: {
        enabled: true,
        apiKey: "",
        endpoint: "",
        model: "test-cache-model",
        hybridAlpha: 0.5,
        batchSize: 20,
      },
    });

    await handleVaultSearch({ query: "expires", mode: "semantic" }, services);
    jest.advanceTimersByTime(300_001);
    await handleVaultSearch({ query: "expires", mode: "semantic" }, services);

    expect(embed).toHaveBeenCalledTimes(2);
  });

  it("does not refresh query cache insertion order on hits", async () => {
    const embed = mock().mockResolvedValue([new Float32Array([1])]);
    const services = makeServices({
      searchStore: {
        getBatchByPaths: mock().mockReturnValue(new Map()),
      } as unknown as ISearchStore,
      embeddingStore: {
        size: 1,
        search: mock().mockReturnValue([]),
      } as unknown as EmbeddingStore,
      embedProvider: { embed, modelName: "test-cache-model" } as unknown as EmbedProvider,
      embeddingConfig: {
        enabled: true,
        apiKey: "",
        endpoint: "",
        model: "test-cache-model",
        hybridAlpha: 0.5,
        batchSize: 20,
        queryCacheMax: 2,
      },
    });

    await handleVaultSearch({ query: "first", mode: "semantic" }, services);
    await handleVaultSearch({ query: "second", mode: "semantic" }, services);
    await handleVaultSearch({ query: "first", mode: "semantic" }, services);
    await handleVaultSearch({ query: "third", mode: "semantic" }, services);
    await handleVaultSearch({ query: "first", mode: "semantic" }, services);

    expect(embed).toHaveBeenCalledTimes(4);
  });

  it("does not reuse cached query embeddings across vaults", async () => {
    const makeSemanticServices = (embed: ReturnType<typeof mock>) =>
      makeServices({
        searchStore: {
          getBatchByPaths: mock().mockReturnValue(
            new Map([["a.md", { fileName: "a", content: "alpha", metadata: {}, updatedAt: 1, createdAt: 1 }]]),
          ),
        } as unknown as ISearchStore,
        embeddingStore: {
          size: 1,
          search: mock().mockReturnValue([{ path: "a.md", similarity: 0.9 }]),
        } as unknown as EmbeddingStore,
        embedProvider: { embed, modelName: "shared-model" } as unknown as EmbedProvider,
        embeddingConfig: {
          enabled: true,
          apiKey: "",
          endpoint: "",
          model: "shared-model",
          hybridAlpha: 0.5,
          batchSize: 20,
        },
      });
    const defaultEmbed = mock().mockResolvedValue([new Float32Array([1])]);
    const workEmbed = mock().mockResolvedValue([new Float32Array([2])]);

    await handleVaultSearch(
      { query: "same query", mode: "semantic", vault: "default" },
      makeSemanticServices(defaultEmbed),
    );
    await handleVaultSearch({ query: "same query", mode: "semantic", vault: "work" }, makeSemanticServices(workEmbed));

    expect(defaultEmbed).toHaveBeenCalledOnce();
    expect(workEmbed).toHaveBeenCalledOnce();
  });

  it("does not collide query embedding cache keys when components contain NUL bytes", async () => {
    const makeSemanticServices = (embed: ReturnType<typeof mock>, modelName: string) =>
      makeServices({
        searchStore: { getBatchByPaths: mock().mockReturnValue(new Map()) } as unknown as ISearchStore,
        embeddingStore: {
          size: 1,
          search: mock().mockReturnValue([]),
        } as unknown as EmbeddingStore,
        embedProvider: { embed, modelName } as unknown as EmbedProvider,
        embeddingConfig: {
          enabled: true,
          apiKey: "",
          endpoint: "",
          model: modelName,
          hybridAlpha: 0.5,
          batchSize: 20,
        },
      });
    const firstEmbed = mock().mockResolvedValue([new Float32Array([1])]);
    const secondEmbed = mock().mockResolvedValue([new Float32Array([2])]);

    await handleVaultSearch({ query: "d", mode: "semantic", vault: "a\0b" }, makeSemanticServices(firstEmbed, "c"));
    await handleVaultSearch({ query: "d", mode: "semantic", vault: "a" }, makeSemanticServices(secondEmbed, "b\0c"));

    expect(firstEmbed).toHaveBeenCalledOnce();
    expect(secondEmbed).toHaveBeenCalledOnce();
  });

  it("propagates error when searchFTS throws", async () => {
    const mockStore = {
      searchFTS: mock().mockImplementation(() => {
        throw new Error("FTS index corrupted");
      }),
      getByPath: mock().mockReturnValue(undefined),
    } as unknown as ISearchStore;
    const services = makeServices({ searchStore: mockStore });

    await expect(handleVaultSearch({ query: "test", mode: "keyword" }, services)).rejects.toThrow(
      "FTS index corrupted",
    );
  });

  it("filters semantic results to only allowPaths when ACL is active", async () => {
    const entries = new Map([
      ["allowed/note.md", { fileName: "note", content: "text", metadata: {}, updatedAt: 1, createdAt: 1 }],
      ["restricted/secret.md", { fileName: "secret", content: "text", metadata: {}, updatedAt: 1, createdAt: 1 }],
    ]);
    const services = makeServices({
      searchStore: { getBatchByPaths: mock().mockReturnValue(entries) } as unknown as ISearchStore,
      embeddingStore: {
        size: 2,
        search: mock().mockReturnValue([
          { path: "allowed/note.md", similarity: 0.9 },
          { path: "restricted/secret.md", similarity: 0.8 },
        ]),
      } as unknown as EmbeddingStore,
      embedProvider: {
        embed: mock().mockResolvedValue([new Float32Array([1])]),
        modelName: "m",
      } as unknown as EmbedProvider,
      embeddingConfig: {
        enabled: true,
        apiKey: "",
        endpoint: "",
        model: "m",
        hybridAlpha: 0.5,
        batchSize: 20,
      },
      aclConfig: { allowPaths: ["allowed"], denyPaths: [] },
    });

    const result = await handleVaultSearch({ query: "test", mode: "semantic" }, services);
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]?.text ?? "{}");
    expect(data.items).toHaveLength(1);
    expect(data.items[0].path).toBe("allowed/note.md");
  });

  it("over-fetches candidateLimit by one with a pathFilter for scoped semantic search", async () => {
    const search = mock().mockReturnValue([]);
    const services = makeServices({
      searchStore: { getBatchByPaths: mock().mockReturnValue(new Map()) } as unknown as ISearchStore,
      embeddingStore: {
        size: 1000,
        search,
      } as unknown as EmbeddingStore,
      embedProvider: {
        embed: mock().mockResolvedValue([new Float32Array([1])]),
        modelName: "m",
      } as unknown as EmbedProvider,
      embeddingConfig: {
        enabled: true,
        apiKey: "",
        endpoint: "",
        model: "m",
        hybridAlpha: 0.5,
        batchSize: 20,
      },
      aclConfig: { allowPaths: ["allowed"], denyPaths: [] },
    });

    await handleVaultSearch({ query: "test", mode: "semantic", limit: 5, folder: "allowed/projects" }, services);

    expect(search).toHaveBeenCalledWith(expect.any(Float32Array), 101, expect.any(Function));
    const pathFilter = search.mock.calls[0]?.[2] as (path: string) => boolean;
    expect(pathFilter("allowed/projects/a.md")).toBe(true);
    expect(pathFilter("allowed/other/a.md")).toBe(false);
    expect(pathFilter("restricted/projects/a.md")).toBe(false);
  });

  it("rejects semantic folder filters that contain parent directory traversal", async () => {
    const services = makeServices({
      searchStore: { getBatchByPaths: mock().mockReturnValue(new Map()) } as unknown as ISearchStore,
      embeddingStore: {
        size: 1,
        search: mock().mockReturnValue([]),
      } as unknown as EmbeddingStore,
      embedProvider: {
        embed: mock().mockResolvedValue([new Float32Array([1])]),
        modelName: "m",
      } as unknown as EmbedProvider,
      embeddingConfig: {
        enabled: true,
        apiKey: "",
        endpoint: "",
        model: "m",
        hybridAlpha: 0.5,
        batchSize: 20,
      },
    });

    await expect(
      handleVaultSearch({ query: "test", mode: "semantic", folder: "notes/../private" }, services),
    ).rejects.toMatchObject({ code: VaultErrorCode.VALIDATION });
  });

  it("applies offset to hybrid search results", async () => {
    const entries = new Map([
      ["a.md", { updatedAt: 1, createdAt: 1 }],
      ["b.md", { updatedAt: 2, createdAt: 2 }],
      ["c.md", { updatedAt: 3, createdAt: 3 }],
    ]);
    const services = makeServices({
      searchStore: {
        getBatchByPaths: mock().mockReturnValue(entries),
        searchHybrid: mock().mockReturnValue([
          { path: "a.md", name: "a", score: 0.9, snippet: "", frontmatter: {} },
          { path: "b.md", name: "b", score: 0.8, snippet: "", frontmatter: {} },
          { path: "c.md", name: "c", score: 0.7, snippet: "", frontmatter: {} },
        ]),
      } as unknown as ISearchStore,
      embeddingStore: { size: 3 } as unknown as EmbeddingStore,
      embedProvider: { embed: mock().mockResolvedValue([new Float32Array([1])]) } as unknown as EmbedProvider,
      embeddingConfig: {
        enabled: true,
        apiKey: "",
        endpoint: "",
        model: "",
        hybridAlpha: 0.5,
        batchSize: 20,
      },
    });

    const result = await handleVaultSearch({ query: "test", mode: "hybrid", limit: 1, offset: 1 }, services);
    const data = JSON.parse(result.content[0]?.text ?? "{}");
    expect(data.items.map((item: { path: string }) => item.path)).toEqual(["b.md"]);
    expect(data.hasMore).toBe(true);
  });
});

describe("applyAclFilter", () => {
  it("returns all results when ACL is not active", () => {
    const results = [{ path: "a.md" }, { path: "b.md" }];
    const filtered = applyAclFilter(results, { allowPaths: [], denyPaths: [] }, false);
    expect(filtered).toHaveLength(2);
  });

  it("filters by denyPaths when ACL is active", () => {
    const results = [{ path: "private/secret.md" }, { path: "public/note.md" }];
    const filtered = applyAclFilter(results, { allowPaths: [], denyPaths: ["private"] }, true);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.path).toBe("public/note.md");
  });

  it("keeps only paths matching allowPaths when ACL is active", () => {
    const results = [{ path: "allowed/a.md" }, { path: "other/b.md" }, { path: "allowed/sub/c.md" }];
    const filtered = applyAclFilter(results, { allowPaths: ["allowed"], denyPaths: [] }, true);
    expect(filtered.map((r) => r.path)).toEqual(["allowed/a.md", "allowed/sub/c.md"]);
  });
});

describe("applyMetadataFilters", () => {
  it("returns all when no filters", () => {
    const items = [{ frontmatter: {}, updatedAt: 100, createdAt: 50 }];
    expect(applyMetadataFilters(items, undefined)).toHaveLength(1);
  });

  it("filters by tag", () => {
    const items = [
      { frontmatter: { tags: ["work", "project"] }, updatedAt: 100, createdAt: 50 },
      { frontmatter: { tags: ["personal"] }, updatedAt: 200, createdAt: 100 },
    ];
    const filtered = applyMetadataFilters(items, { tags: ["work"] });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.frontmatter["tags"]).toContain("work");
  });

  it("filters by modifiedAfter", () => {
    const items = [
      { frontmatter: {}, updatedAt: 500, createdAt: 50 },
      { frontmatter: {}, updatedAt: 100, createdAt: 50 },
    ];
    const filtered = applyMetadataFilters(items, { modifiedAfter: 300 });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.updatedAt).toBe(500);
  });
});
