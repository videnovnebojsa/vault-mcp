import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockEmbedProvider } from "../search/embed-provider.js";
import { EmbeddingStore } from "../search/embeddings.js";
import { VaultSearchStore } from "../search/store.js";
import type { VaultManager } from "../vault/manager.js";
import { VaultRepository } from "../vault/repository.js";
import { type RegisterToolsOptions, registerTools } from "./tools.js";

// ── test helpers ──────────────────────────────────────────────────────────────

type Handler = (
  args: Record<string, unknown>,
) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

function createMockServer() {
  const handlers = new Map<string, Handler>();
  const server = {
    tool: (_name: string, _desc: string, _schema: unknown, fn: Handler) => {
      handlers.set(_name, fn);
    },
  };
  return { server: server as unknown as McpServer, handlers };
}

function parseResult(result: { content: Array<{ type: string; text: string }>; isError?: boolean }) {
  return JSON.parse(result.content[0]?.text);
}

function makeVault(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    readNote: vi.fn(),
    writeNote: vi.fn(),
    deleteNote: vi.fn(),
    moveNote: vi.fn(),
    updateProperties: vi.fn(),
    listFolder: vi.fn(),
    searchByPathOrName: vi.fn(),
    softDeleteNote: vi.fn().mockResolvedValue({
      ok: true,
      path: "notes/target.md",
      message: "Moved to .trash/notes_target.md",
      trashName: "notes_target.md",
    }),
    updateWikilinks: vi.fn().mockResolvedValue({ updated: 0, errors: [] }),
    ...overrides,
  };
}

type TestOverrides = {
  searchStore?: VaultSearchStore;
  // biome-ignore lint/suspicious/noExplicitAny: test helper — accepts mock or real VaultSync
  vaultSync?: any;
  embeddingStore?: EmbeddingStore;
  // biome-ignore lint/suspicious/noExplicitAny: test helper
  embedProvider?: any;
  embeddingConfig?: {
    enabled: boolean;
    hybridAlpha: number;
    batchSize: number;
    intervalMinutes?: number;
    model?: string;
    dimensions?: number;
    apiKey?: string;
    endpoint?: string;
  };
  // biome-ignore lint/suspicious/noExplicitAny: test helper
  capture?: any;
  aclConfig?: { allowPaths: string[]; denyPaths: string[] };
  vaultPath?: string;
  backupConfig?: { enabled: boolean; dir: string; maxBackups: number; intervalHours: number };
  periodicNotesRoot?: string;
  toolTimeoutMs?: number;
  // biome-ignore lint/suspicious/noExplicitAny: test helper
  classifyRules?: any;
};

// biome-ignore lint/suspicious/noExplicitAny: accepts both makeVault() results and real VaultRepository instances
function makeTestManager(vault: any, overrides: TestOverrides = {}) {
  return {
    listVaults: vi.fn().mockReturnValue([{ name: "default" }]),
    getServices: vi.fn((name = "default") => {
      if (name !== "default") throw new Error(`Unknown vault: "${name}". Available: default`);
      return {
        vault,
        searchStore: overrides.searchStore,
        vaultSync: overrides.vaultSync,
        capture: overrides.capture ?? null,
        embeddingStore: overrides.embeddingStore,
        embedProvider: overrides.embedProvider,
        embeddingConfig: overrides.embeddingConfig ?? {
          enabled: false,
          hybridAlpha: 0.5,
          batchSize: 20,
          intervalMinutes: 30,
        },
        aclConfig: overrides.aclConfig ?? { allowPaths: [], denyPaths: [] },
        vaultPath: overrides.vaultPath ?? "/vault",
        watcher: null,
        bootReady: Promise.resolve(),
        bootFailed: false,
      };
    }),
    config: {
      periodicNotesRoot: overrides.periodicNotesRoot ?? "Journal",
      backup: overrides.backupConfig ?? { enabled: false, dir: "/tmp/backup", maxBackups: 5, intervalHours: 24 },
      toolTimeoutMs: overrides.toolTimeoutMs,
      classifyRules: overrides.classifyRules,
    },
  };
}

const MIN_VAULT_CONFIG = {
  periodicNotesRoot: "Journal",
  backup: { enabled: false, dir: "/tmp/backup", maxBackups: 5, intervalHours: 24 },
  toolTimeoutMs: undefined as number | undefined,
  classifyRules: undefined as unknown,
};

// ── shared stores ─────────────────────────────────────────────────────────────

let searchStore: VaultSearchStore;
let embDb: Database.Database;
let embeddingStore: EmbeddingStore;

beforeEach(() => {
  searchStore = new VaultSearchStore(":memory:");
  embDb = new Database(":memory:");
  embeddingStore = new EmbeddingStore(embDb);
  embeddingStore.initSchema();
});

afterEach(() => {
  searchStore.close();
  embDb.close();
});

// ── vault_read_note ───────────────────────────────────────────────────────────

describe("vault_read_note", () => {
  it("returns note on success", async () => {
    const vault = makeVault({
      readNote: vi.fn().mockResolvedValue({ path: "notes/a.md", name: "a", content: "hello", frontmatter: {} }),
    });
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager: makeTestManager(vault) as unknown as VaultManager });

    const result = await handlers.get("vault_read_note")?.({ path: "notes/a" });
    const data = parseResult(result);
    expect(data.name).toBe("a");
    expect(result.isError).toBeFalsy();
  });

  it("returns error when note not found", async () => {
    const vault = makeVault({ readNote: vi.fn().mockRejectedValue(new Error("not found")) });
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager: makeTestManager(vault) as unknown as VaultManager });

    const result = await handlers.get("vault_read_note")?.({ path: "missing" });
    const data = parseResult(result);
    expect(data.error).toMatch("not found");
    expect(result.isError).toBe(true);
  });
});

// ── vault_write_note ──────────────────────────────────────────────────────────

describe("vault_write_note", () => {
  it("returns result on success", async () => {
    const vault = makeVault({ writeNote: vi.fn().mockResolvedValue({ ok: true, path: "notes/b.md" }) });
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager: makeTestManager(vault) as unknown as VaultManager });

    const result = await handlers.get("vault_write_note")?.({ path: "notes/b", content: "content" });
    const data = parseResult(result);
    expect(data.ok).toBe(true);
  });

  it("calls vaultSync.handleUpsert after write", async () => {
    const vault = makeVault({ writeNote: vi.fn().mockResolvedValue({ ok: true, path: "notes/b.md" }) });
    const vaultSync = {
      handleUpsert: vi.fn().mockResolvedValue(undefined),
      handleDelete: vi.fn(),
      handleRename: vi.fn().mockResolvedValue(undefined),
      runFullSync: vi.fn(),
    };
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager: makeTestManager(vault, { vaultSync }) as unknown as VaultManager });

    await handlers.get("vault_write_note")?.({ path: "notes/b", content: "content" });
    await vi.waitFor(() => expect(vaultSync.handleUpsert).toHaveBeenCalledWith("notes/b.md"));
  });

  it("returns error on write failure", async () => {
    const vault = makeVault({ writeNote: vi.fn().mockRejectedValue(new Error("disk full")) });
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager: makeTestManager(vault) as unknown as VaultManager });

    const result = await handlers.get("vault_write_note")?.({ path: "notes/c", content: "x" });
    expect(result.isError).toBe(true);
  });
});

// ── vault_search keyword ──────────────────────────────────────────────────────

describe("vault_search keyword", () => {
  it("returns FTS results from searchStore", async () => {
    searchStore.upsert("notes/fox.md", "The quick brown fox", "h1", "fox", { type: "note" });
    const vault = makeVault();
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager: makeTestManager(vault, { searchStore }) as unknown as VaultManager });

    const result = await handlers.get("vault_search")?.({ query: "fox", mode: "keyword" });
    const data = parseResult(result) as Array<{ path: string }>;
    expect(data.some((r) => r.path === "notes/fox.md")).toBe(true);
  });

  it("falls back to vault.searchByPathOrName when no searchStore", async () => {
    const vault = makeVault({ searchByPathOrName: vi.fn().mockResolvedValue([{ path: "notes/dog.md", name: "dog" }]) });
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager: makeTestManager(vault) as unknown as VaultManager });

    const result = await handlers.get("vault_search")?.({ query: "dog", mode: "keyword" });
    const data = parseResult(result) as Array<{ path: string }>;
    expect(vault.searchByPathOrName).toHaveBeenCalled();
    expect(data[0]?.path).toBe("notes/dog.md");
  });

  it("filters by tag in keyword mode", async () => {
    searchStore.upsert("notes/tagged.md", "Tagged note", "h1", "tagged", { tags: ["ai"] });
    searchStore.upsert("notes/other.md", "Other note tagged", "h2", "other", { tags: ["work"] });
    const vault = makeVault();
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager: makeTestManager(vault, { searchStore }) as unknown as VaultManager });

    const result = await handlers.get("vault_search")?.({ query: "note", mode: "keyword", tags: ["ai"] });
    const data = parseResult(result) as Array<{ path: string }>;
    expect(data.every((r) => r.path === "notes/tagged.md")).toBe(true);
  });
});

// ── vault_search semantic ─────────────────────────────────────────────────────

describe("vault_search semantic", () => {
  it("returns semantically matched results", async () => {
    searchStore.upsert("notes/ml.md", "machine learning topic", "h1", "ml", { type: "note" });
    const embedProvider = new MockEmbedProvider(4);
    const vec = new Float32Array([1, 0, 0, 0]);
    embeddingStore.upsert("notes/ml.md", vec, "h1", "mock");
    embeddingStore.load();

    const vault = makeVault();
    const { server, handlers } = createMockServer();
    registerTools({
      server,
      vaultManager: makeTestManager(vault, {
        searchStore,
        embeddingStore,
        embedProvider,
        embeddingConfig: { enabled: true, batchSize: 10, hybridAlpha: 0.5, model: "mock", dimensions: 4 },
      }) as unknown as VaultManager,
    });

    const result = await handlers.get("vault_search")?.({ query: "ml", mode: "semantic" });
    const data = parseResult(result) as Array<{ path: string }>;
    expect(Array.isArray(data)).toBe(true);
  });

  it("uses Math.max(limit*10, 100) as candidate count", async () => {
    const searchSpy = vi.spyOn(embeddingStore, "search").mockReturnValue([]);
    const embedProvider = new MockEmbedProvider(4);
    const vault = makeVault();
    const { server, handlers } = createMockServer();
    registerTools({
      server,
      vaultManager: makeTestManager(vault, {
        searchStore,
        embeddingStore,
        embedProvider,
        embeddingConfig: { enabled: true, batchSize: 10, hybridAlpha: 0.5, model: "mock", dimensions: 4 },
      }) as unknown as VaultManager,
    });

    await handlers.get("vault_search")?.({ query: "test", mode: "semantic", limit: 5 });
    expect(searchSpy).toHaveBeenCalledWith(expect.any(Float32Array), 100);

    await handlers.get("vault_search")?.({ query: "test", mode: "semantic", limit: 20 });
    expect(searchSpy).toHaveBeenCalledWith(expect.any(Float32Array), 200);
  });

  it("uses embeddingStore.size as candidate count when metadata filters are present", async () => {
    const searchSpy = vi.spyOn(embeddingStore, "search").mockReturnValue([]);
    vi.spyOn(embeddingStore, "size", "get").mockReturnValue(500);
    const embedProvider = new MockEmbedProvider(4);
    const vault = makeVault();
    const { server, handlers } = createMockServer();
    registerTools({
      server,
      vaultManager: makeTestManager(vault, {
        searchStore,
        embeddingStore,
        embedProvider,
        embeddingConfig: { enabled: true, batchSize: 10, hybridAlpha: 0.5, model: "mock", dimensions: 4 },
      }) as unknown as VaultManager,
    });

    await handlers.get("vault_search")?.({ query: "test", mode: "semantic", limit: 5, tags: ["ai"] });
    expect(searchSpy).toHaveBeenCalledWith(expect.any(Float32Array), 500);
  });

  it("uses embeddingStore.size as candidate count when folder filter is present", async () => {
    const searchSpy = vi.spyOn(embeddingStore, "search").mockReturnValue([]);
    vi.spyOn(embeddingStore, "size", "get").mockReturnValue(500);
    const embedProvider = new MockEmbedProvider(4);
    const vault = makeVault();
    const { server, handlers } = createMockServer();
    registerTools({
      server,
      vaultManager: makeTestManager(vault, {
        searchStore,
        embeddingStore,
        embedProvider,
        embeddingConfig: { enabled: true, batchSize: 10, hybridAlpha: 0.5, model: "mock", dimensions: 4 },
      }) as unknown as VaultManager,
    });

    await handlers.get("vault_search")?.({ query: "test", mode: "semantic", limit: 5, folder: "notes" });
    expect(searchSpy).toHaveBeenCalledWith(expect.any(Float32Array), 500);
  });

  it("applies tag filter on semantic results", async () => {
    const _now = Date.now();
    searchStore.upsert("notes/ai.md", "AI note", "h1", "ai", { tags: ["ai"] });
    searchStore.upsert("notes/other.md", "Other note", "h2", "other", { tags: ["work"] });

    vi.spyOn(embeddingStore, "search").mockReturnValue([
      { path: "notes/ai.md", similarity: 0.9 },
      { path: "notes/other.md", similarity: 0.8 },
    ]);
    const embedProvider = new MockEmbedProvider(4);
    const vault = makeVault();
    const { server, handlers } = createMockServer();
    registerTools({
      server,
      vaultManager: makeTestManager(vault, {
        searchStore,
        embeddingStore,
        embedProvider,
        embeddingConfig: { enabled: true, batchSize: 10, hybridAlpha: 0.5, model: "mock", dimensions: 4 },
      }) as unknown as VaultManager,
    });

    const result = await handlers.get("vault_search")?.({ query: "note", mode: "semantic", tags: ["ai"] });
    const data = parseResult(result) as Array<{ path: string }>;
    expect(data.length).toBe(1);
    expect(data[0]?.path).toBe("notes/ai.md");
  });

  it("applies type filter on semantic results", async () => {
    searchStore.upsert("notes/typed.md", "Typed note", "h1", "typed", { type: "project" });
    searchStore.upsert("notes/plain.md", "Plain note", "h2", "plain", { type: "note" });

    vi.spyOn(embeddingStore, "search").mockReturnValue([
      { path: "notes/typed.md", similarity: 0.9 },
      { path: "notes/plain.md", similarity: 0.8 },
    ]);
    const embedProvider = new MockEmbedProvider(4);
    const vault = makeVault();
    const { server, handlers } = createMockServer();
    registerTools({
      server,
      vaultManager: makeTestManager(vault, {
        searchStore,
        embeddingStore,
        embedProvider,
        embeddingConfig: { enabled: true, batchSize: 10, hybridAlpha: 0.5, model: "mock", dimensions: 4 },
      }) as unknown as VaultManager,
    });

    const result = await handlers.get("vault_search")?.({ query: "note", mode: "semantic", type: "project" });
    const data = parseResult(result) as Array<{ path: string }>;
    expect(data.every((r) => r.path === "notes/typed.md")).toBe(true);
  });

  it("applies modified_after filter on semantic results", async () => {
    const future = new Date(Date.now() + 86400_000).toISOString();
    searchStore.upsert("notes/new.md", "New note", "h1", "new", {});
    searchStore.upsert("notes/old.md", "Old note", "h2", "old", {});

    vi.spyOn(embeddingStore, "search").mockReturnValue([
      { path: "notes/new.md", similarity: 0.9 },
      { path: "notes/old.md", similarity: 0.8 },
    ]);
    const embedProvider = new MockEmbedProvider(4);
    const vault = makeVault();
    const { server, handlers } = createMockServer();
    registerTools({
      server,
      vaultManager: makeTestManager(vault, {
        searchStore,
        embeddingStore,
        embedProvider,
        embeddingConfig: { enabled: true, batchSize: 10, hybridAlpha: 0.5, model: "mock", dimensions: 4 },
      }) as unknown as VaultManager,
    });

    // filter to notes modified after tomorrow → none should pass
    const result = await handlers.get("vault_search")?.({ query: "note", mode: "semantic", modified_after: future });
    const data = parseResult(result) as Array<unknown>;
    expect(data.length).toBe(0);
  });
});

// ── vault_search hybrid ───────────────────────────────────────────────────────

describe("vault_search hybrid", () => {
  it("uses Math.max(limit*10, 100) as hybrid candidate count", async () => {
    const hybridSpy = vi.spyOn(searchStore, "searchHybrid").mockReturnValue([]);
    const embedProvider = new MockEmbedProvider(4);
    const vault = makeVault();
    const { server, handlers } = createMockServer();
    registerTools({
      server,
      vaultManager: makeTestManager(vault, {
        searchStore,
        embeddingStore,
        embedProvider,
        embeddingConfig: { enabled: true, batchSize: 10, hybridAlpha: 0.5, model: "mock", dimensions: 4 },
      }) as unknown as VaultManager,
    });

    const emptyAcl = { allowPaths: [], denyPaths: [] };
    await handlers.get("vault_search")?.({ query: "test", mode: "hybrid", limit: 3 });
    expect(hybridSpy).toHaveBeenCalledWith(
      "test",
      expect.any(Float32Array),
      embeddingStore,
      0.5,
      100,
      undefined,
      emptyAcl,
    );

    await handlers.get("vault_search")?.({ query: "test", mode: "hybrid", limit: 15 });
    expect(hybridSpy).toHaveBeenCalledWith(
      "test",
      expect.any(Float32Array),
      embeddingStore,
      0.5,
      150,
      undefined,
      emptyAcl,
    );
  });

  it("applies created_after filter on hybrid results", async () => {
    const past = new Date(Date.now() - 86400_000).toISOString();
    searchStore.upsert("notes/a.md", "Note A", "h1", "a", {});

    vi.spyOn(searchStore, "searchHybrid").mockReturnValue([
      { path: "notes/a.md", score: 0.9, snippet: "", name: "a", frontmatter: {} },
    ]);
    const embedProvider = new MockEmbedProvider(4);
    const vault = makeVault();
    const { server, handlers } = createMockServer();
    registerTools({
      server,
      vaultManager: makeTestManager(vault, {
        searchStore,
        embeddingStore,
        embedProvider,
        embeddingConfig: { enabled: true, batchSize: 10, hybridAlpha: 0.5, model: "mock", dimensions: 4 },
      }) as unknown as VaultManager,
    });

    // created_after = yesterday, note was just created → should pass
    const result = await handlers.get("vault_search")?.({ query: "note", mode: "hybrid", created_after: past });
    const data = parseResult(result) as Array<{ path: string }>;
    expect(data.some((r) => r.path === "notes/a.md")).toBe(true);
  });
});

// ── vault_list_tags ───────────────────────────────────────────────────────────

describe("vault_list_tags", () => {
  it("returns error when no searchStore", async () => {
    const vault = makeVault();
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager: makeTestManager(vault) as unknown as VaultManager });

    const result = await handlers.get("vault_list_tags")?.({});
    expect(result.isError).toBe(true);
  });

  it("lists tags from searchStore", async () => {
    searchStore.upsert("notes/a.md", "content", "h1", "a", { tags: ["ai", "work"] });
    const vault = makeVault();
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager: makeTestManager(vault, { searchStore }) as unknown as VaultManager });

    const result = await handlers.get("vault_list_tags")?.({});
    const data = parseResult(result) as { tags: Array<{ tag: string; count: number }>; total: number };
    expect(data.total).toBeGreaterThan(0);
    expect(data.tags.some((t) => t.tag === "ai")).toBe(true);
  });
});

// ── vault_classify ────────────────────────────────────────────────────────────

describe("vault_classify", () => {
  it("returns folder and title suggestion", async () => {
    const vault = makeVault();
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager: makeTestManager(vault) as unknown as VaultManager });

    const result = await handlers.get("vault_classify")?.({ text: "Meeting notes from standup" });
    const data = parseResult(result);
    expect(data).toHaveProperty("suggested_folder");
    expect(data).toHaveProperty("suggested_title");
  });

  it("uses custom classify rules when provided", async () => {
    const vault = makeVault();
    const { server, handlers } = createMockServer();
    const classifyRules = {
      recipe: { keywords: ["ingredient", "bake", "cook"], folder: "50_Recipes" },
    };
    registerTools({ server, vaultManager: makeTestManager(vault, { classifyRules }) as unknown as VaultManager });

    const result = await handlers.get("vault_classify")?.({ text: "ingredient list for cake" });
    const data = parseResult(result);
    expect(data.suggested_folder).toBe("50_Recipes");
    expect(data.category).toBe("recipe");
  });

  it("returns structured error for unknown vault name", async () => {
    const { server, handlers } = createMockServer();
    const vaultManager = {
      listVaults: vi.fn().mockReturnValue([{ name: "default" }]),
      getServices: vi.fn((name = "default") => {
        if (name !== "default") throw new Error(`Unknown vault: "${name}". Available: default`);
        return {
          vault: makeVault(),
          searchStore: undefined,
          vaultSync: undefined,
          capture: null,
          embeddingStore: undefined,
          embedProvider: undefined,
          embeddingConfig: { enabled: false, hybridAlpha: 0.5, batchSize: 20, intervalMinutes: 30 },
          aclConfig: { allowPaths: [], denyPaths: [] },
          vaultPath: "/vault",
          watcher: null,
          bootReady: Promise.resolve(),
          bootFailed: false,
        };
      }),
      config: MIN_VAULT_CONFIG,
    };
    registerTools({ server, vaultManager } as unknown as RegisterToolsOptions);

    const result = await handlers.get("vault_classify")?.({ text: "some text", vault: "nonexistent" });
    expect(result.isError).toBe(true);
    const data = parseResult(result);
    expect(data.error).toMatch(/Unknown vault/);
  });
});

// ── vault_list_folder ─────────────────────────────────────────────────────────

describe("vault_list_folder", () => {
  it("returns enriched results when searchStore present", async () => {
    searchStore.upsert("docs/a.md", "content", "h1", "a", { tags: ["x"], type: "note" });
    const vault = makeVault({ listFolder: vi.fn().mockResolvedValue([{ path: "docs/a.md", name: "a" }]) });
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager: makeTestManager(vault, { searchStore }) as unknown as VaultManager });

    const result = await handlers.get("vault_list_folder")?.({ folder: "docs" });
    const data = parseResult(result) as Array<{ path: string; tags?: unknown; type?: unknown }>;
    expect(data[0]?.tags).toBeDefined();
  });

  it("returns plain results without searchStore", async () => {
    const vault = makeVault({ listFolder: vi.fn().mockResolvedValue([{ path: "docs/b.md", name: "b" }]) });
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager: makeTestManager(vault) as unknown as VaultManager });

    const result = await handlers.get("vault_list_folder")?.({ folder: "docs" });
    const data = parseResult(result) as Array<{ path: string }>;
    expect(data[0]?.path).toBe("docs/b.md");
  });

  it("returns error on vault failure", async () => {
    const vault = makeVault({ listFolder: vi.fn().mockRejectedValue(new Error("no folder")) });
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager: makeTestManager(vault) as unknown as VaultManager });

    const result = await handlers.get("vault_list_folder")?.({ folder: "missing" });
    expect(result.isError).toBe(true);
  });
});

// ── vault_move_note ───────────────────────────────────────────────────────────

describe("vault_move_note", () => {
  it("returns isError when vault.moveNote fails", async () => {
    const vault = makeVault({
      moveNote: vi.fn().mockResolvedValue({ ok: false, path: "notes/a.md", message: "Destination already exists" }),
    });
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager: makeTestManager(vault) as unknown as VaultManager });

    const result = await handlers.get("vault_move_note")?.({ from_path: "notes/a", to_path: "notes/b" });
    expect(result?.isError).toBe(true);
    const data = parseResult(result);
    expect(data.ok).toBe(false);
    expect(vault.updateWikilinks).not.toHaveBeenCalled();
  });

  it("calls vault.updateWikilinks with stripped .md paths when update_backlinks=true", async () => {
    const vault = makeVault({
      moveNote: vi.fn().mockResolvedValue({ ok: true, path: "notes/b.md", message: "Moved" }),
    });
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager: makeTestManager(vault) as unknown as VaultManager });

    await handlers.get("vault_move_note")?.({ from_path: "notes/a.md", to_path: "notes/b.md", update_backlinks: true });
    expect(vault.updateWikilinks).toHaveBeenCalledWith("notes/a", "notes/b", undefined);
  });

  it("does not call vault.updateWikilinks when update_backlinks=false", async () => {
    const vault = makeVault({
      moveNote: vi.fn().mockResolvedValue({ ok: true, path: "notes/b.md", message: "Moved" }),
    });
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager: makeTestManager(vault) as unknown as VaultManager });

    await handlers.get("vault_move_note")?.({ from_path: "notes/a", to_path: "notes/b", update_backlinks: false });
    expect(vault.updateWikilinks).not.toHaveBeenCalled();
  });

  it("calls vaultSync.handleRename on success", async () => {
    const vault = makeVault({
      moveNote: vi.fn().mockResolvedValue({ ok: true, path: "notes/b.md", message: "Moved" }),
    });
    const vaultSync = {
      handleRename: vi.fn().mockResolvedValue(undefined),
      handleUpsert: vi.fn().mockResolvedValue(undefined),
      handleDelete: vi.fn(),
      runFullSync: vi.fn(),
    };
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager: makeTestManager(vault, { vaultSync }) as unknown as VaultManager });

    await handlers.get("vault_move_note")?.({ from_path: "notes/a", to_path: "notes/b" });
    expect(vaultSync.handleRename).toHaveBeenCalledWith("notes/a.md", "notes/b.md");
  });

  it("includes backlinksUpdated in response on success", async () => {
    const vault = makeVault({
      moveNote: vi.fn().mockResolvedValue({ ok: true, path: "notes/b.md", message: "Moved" }),
      updateWikilinks: vi.fn().mockResolvedValue({ updated: 3, errors: [] }),
    });
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager: makeTestManager(vault) as unknown as VaultManager });

    const result = await handlers.get("vault_move_note")?.({ from_path: "notes/a", to_path: "notes/b" });
    expect(result?.isError).toBeUndefined();
    const data = parseResult(result);
    expect(data.backlinksUpdated).toBe(3);
  });
});

// ── vault_update_properties ───────────────────────────────────────────────────

describe("vault_update_properties", () => {
  it("returns serialized result on success", async () => {
    const vault = makeVault({
      updateProperties: vi
        .fn()
        .mockResolvedValue({ ok: true, path: "notes/x.md", message: "Note written successfully" }),
    });
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager: makeTestManager(vault) as unknown as VaultManager });

    const result = await handlers.get("vault_update_properties")?.({ path: "notes/x", properties: { status: "done" } });
    expect(result?.isError).toBeUndefined();
    const data = parseResult(result);
    expect(data.ok).toBe(true);
    expect(data.path).toBe("notes/x.md");
  });

  it("calls vaultSync.handleUpsert on success", async () => {
    const vault = makeVault({
      updateProperties: vi.fn().mockResolvedValue({ ok: true, path: "notes/x.md" }),
    });
    const vaultSync = {
      handleUpsert: vi.fn().mockResolvedValue(undefined),
      handleDelete: vi.fn(),
      handleRename: vi.fn().mockResolvedValue(undefined),
      runFullSync: vi.fn(),
    };
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager: makeTestManager(vault, { vaultSync }) as unknown as VaultManager });

    await handlers.get("vault_update_properties")?.({ path: "notes/x", properties: { status: "done" } });
    expect(vaultSync.handleUpsert).toHaveBeenCalledWith("notes/x.md");
  });

  it("returns isError when vault.updateProperties throws", async () => {
    const vault = makeVault({
      updateProperties: vi.fn().mockRejectedValue(new Error("read failed")),
    });
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager: makeTestManager(vault) as unknown as VaultManager });

    const result = await handlers.get("vault_update_properties")?.({ path: "notes/x", properties: {} });
    expect(result?.isError).toBe(true);
    const data = parseResult(result);
    expect(data.error).toContain("read failed");
  });
});

// ── vault_delete_note ─────────────────────────────────────────────────────────

describe("vault_delete_note", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vault-del-test-"));
    // create a note file
    await fs.mkdir(path.join(tmpDir, "notes"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "notes", "target.md"), "# Target\ncontent");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("soft-deletes note to .trash/ when trash=true", async () => {
    const vault = new VaultRepository({ vaultPath: tmpDir });
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager: makeTestManager(vault) as unknown as VaultManager });

    const result = await handlers.get("vault_delete_note")?.({ path: "notes/target", trash: true });
    const data = parseResult(result);
    expect(data.ok).toBe(true);
    expect(data.message).toMatch(".trash/");

    // original should be gone, .trash/ entry should exist
    await expect(fs.access(path.join(tmpDir, "notes", "target.md"))).rejects.toThrow();
    const trashEntries = await fs.readdir(path.join(tmpDir, ".trash"));
    expect(trashEntries.length).toBeGreaterThan(0);
  });

  it("permanently deletes when trash=false", async () => {
    const vault = makeVault({ deleteNote: vi.fn().mockResolvedValue({ ok: true, path: "notes/target.md" }) });
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager: makeTestManager(vault) as unknown as VaultManager });

    const result = await handlers.get("vault_delete_note")?.({ path: "notes/target", trash: false });
    const data = parseResult(result);
    expect(data.ok).toBe(true);
    expect(vault.deleteNote).toHaveBeenCalled();
  });

  it("calls vaultSync.handleDelete after soft-delete", async () => {
    const vaultSync = {
      handleDelete: vi.fn(),
      handleUpsert: vi.fn().mockResolvedValue(undefined),
      handleRename: vi.fn().mockResolvedValue(undefined),
      runFullSync: vi.fn(),
    };
    const vault = new VaultRepository({ vaultPath: tmpDir });
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager: makeTestManager(vault, { vaultSync }) as unknown as VaultManager });

    await handlers.get("vault_delete_note")?.({ path: "notes/target", trash: true });
    expect(vaultSync.handleDelete).toHaveBeenCalledWith("notes/target.md");
  });

  it("returns isError when ACL denies the path for soft-delete", async () => {
    const vault = new VaultRepository({
      vaultPath: tmpDir,
      acl: { allowPaths: [], denyPaths: ["notes"] },
    });
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager: makeTestManager(vault) as unknown as VaultManager });

    const result = await handlers.get("vault_delete_note")?.({ path: "notes/target", trash: true });
    expect(result?.isError).toBe(true);
  });
});

// ── vault_read_section ────────────────────────────────────────────────────────

describe("vault_read_section", () => {
  it("returns section content for existing heading", async () => {
    const vault = makeVault({
      readNote: vi.fn().mockResolvedValue({
        path: "notes/doc.md",
        name: "doc",
        content: "# Intro\nIntro text\n## Details\nDetail text\n# End\nEnd text",
        frontmatter: {},
      }),
    });
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager: makeTestManager(vault) as unknown as VaultManager });

    const result = await handlers.get("vault_read_section")?.({ path: "notes/doc", heading: "Details" });
    const data = parseResult(result);
    expect(data.content).toContain("Detail text");
    expect(data.content).not.toContain("End text");
  });

  it("returns error when heading not found", async () => {
    const vault = makeVault({
      readNote: vi
        .fn()
        .mockResolvedValue({ path: "notes/doc.md", name: "doc", content: "# Intro\ntext", frontmatter: {} }),
    });
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager: makeTestManager(vault) as unknown as VaultManager });

    const result = await handlers.get("vault_read_section")?.({ path: "notes/doc", heading: "Missing" });
    expect(result.isError).toBe(true);
    const data = parseResult(result);
    expect(data.error).toMatch("Missing");
  });

  it("matches Cyrillic heading exactly", async () => {
    const vault = makeVault({
      readNote: vi.fn().mockResolvedValue({
        path: "notes/doc.md",
        name: "doc",
        content: "# Введение\nВводный текст\n## Детали\nТекст деталей\n# Конец\nКонечный текст",
        frontmatter: {},
      }),
    });
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager: makeTestManager(vault) as unknown as VaultManager });

    const result = await handlers.get("vault_read_section")?.({ path: "notes/doc", heading: "Детали" });
    const data = parseResult(result);
    expect(data.content).toContain("Текст деталей");
    expect(data.content).not.toContain("Конечный текст");
  });

  it("matches Cyrillic heading case-insensitively", async () => {
    const vault = makeVault({
      readNote: vi.fn().mockResolvedValue({
        path: "notes/doc.md",
        name: "doc",
        content: "# ВВЕДЕНИЕ\nВводный текст",
        frontmatter: {},
      }),
    });
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager: makeTestManager(vault) as unknown as VaultManager });

    const result = await handlers.get("vault_read_section")?.({ path: "notes/doc", heading: "введение" });
    const data = parseResult(result);
    expect(data.content).toContain("Вводный текст");
  });

  it("matches CJK heading", async () => {
    const vault = makeVault({
      readNote: vi.fn().mockResolvedValue({
        path: "notes/doc.md",
        name: "doc",
        content: "# 简介\n简介内容\n## 详情\n详细内容\n# 结束\n结束内容",
        frontmatter: {},
      }),
    });
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager: makeTestManager(vault) as unknown as VaultManager });

    const result = await handlers.get("vault_read_section")?.({ path: "notes/doc", heading: "详情" });
    const data = parseResult(result);
    expect(data.content).toContain("详细内容");
    expect(data.content).not.toContain("结束内容");
  });
});

// ── vault_triage_inbox ────────────────────────────────────────────────────────

describe("vault_triage_inbox", () => {
  it("returns ok with empty result when inbox is empty", async () => {
    const vault = makeVault({ listFolder: vi.fn().mockResolvedValue([]) });
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager: makeTestManager(vault) as unknown as VaultManager });

    const result = await handlers.get("vault_triage_inbox")?.({});
    expect(result?.isError).toBeFalsy();
    const data = parseResult(result);
    expect(data.moved).toHaveLength(0);
  });

  it("returns isError when getSvc throws (vault boot failed)", async () => {
    const rejected = Promise.reject(new Error("vault not ready"));
    rejected.catch(() => {});

    const vaultManager = {
      getServices: () => ({
        bootReady: rejected,
        bootFailed: true,
        vault: makeVault(),
        searchStore: undefined,
        vaultSync: undefined,
        capture: null,
        embeddingStore: undefined,
        embedProvider: undefined,
        embeddingConfig: { enabled: false },
        aclConfig: { allowPaths: [], denyPaths: [] },
        vaultPath: "/vault",
        watcher: null,
      }),
      listVaults: () => [],
      config: MIN_VAULT_CONFIG,
    };
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager } as unknown as RegisterToolsOptions);

    const result = await handlers.get("vault_triage_inbox")?.({});
    expect(result?.isError).toBe(true);
  });
});

// ── vault_periodic_note ───────────────────────────────────────────────────────

describe("vault_periodic_note", () => {
  it("creates a daily note and returns its content", async () => {
    const mockNote = { path: "Journal/2026/2026-05-11.md", name: "2026-05-11", content: "", frontmatter: {} };
    const vaultSync = {
      handleUpsert: vi.fn().mockResolvedValue(undefined),
      handleDelete: vi.fn(),
      handleRename: vi.fn(),
      runFullSync: vi.fn(),
    };
    const vault = makeVault({
      // readNote: first call fails (note doesn't exist), second call succeeds after write
      readNote: vi.fn().mockRejectedValueOnce(new Error("not found")).mockResolvedValueOnce(mockNote),
      writeNote: vi.fn().mockResolvedValue({ path: "Journal/2026/2026-05-11.md" }),
    });
    const { server, handlers } = createMockServer();
    registerTools({
      server,
      vaultManager: makeTestManager(vault, { vaultSync, periodicNotesRoot: "Journal" }) as unknown as VaultManager,
    });

    const result = await handlers.get("vault_periodic_note")?.({ period: "daily", date: "2026-05-11" });
    expect(result?.isError).toBeFalsy();
    const data = parseResult(result);
    expect(data.path).toContain("2026-05-11");
    await new Promise((r) => setTimeout(r, 10));
    expect(vaultSync.handleUpsert).toHaveBeenCalled();
  });

  it("handles vaultSync.handleUpsert rejection gracefully (fire-and-forget)", async () => {
    const mockNote = { path: "Journal/2026/2026-05-11.md", name: "2026-05-11", content: "", frontmatter: {} };
    // handleUpsert rejects — the catch callback should just log and not surface to the caller
    const vaultSync = {
      handleUpsert: vi.fn().mockRejectedValue(new Error("sync failed")),
      handleDelete: vi.fn(),
      handleRename: vi.fn(),
      runFullSync: vi.fn(),
    };
    const vault = makeVault({ readNote: vi.fn().mockResolvedValue(mockNote) });
    const { server, handlers } = createMockServer();
    registerTools({
      server,
      vaultManager: makeTestManager(vault, { vaultSync, periodicNotesRoot: "Journal" }) as unknown as VaultManager,
    });

    const result = await handlers.get("vault_periodic_note")?.({ period: "daily", date: "2026-05-11" });
    expect(result?.isError).toBeFalsy();
    // Give the rejected promise time to trigger the catch handler
    await new Promise((r) => setTimeout(r, 10));
  });

  it("returns isError when vault throws an unexpected error", async () => {
    const vault = makeVault({
      readNote: vi.fn().mockRejectedValue(new Error("disk failure")),
    });
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager: makeTestManager(vault) as unknown as VaultManager });

    const result = await handlers.get("vault_periodic_note")?.({ period: "daily" });
    expect(result?.isError).toBe(true);
    const data = parseResult(result);
    expect(data.error).toMatch("disk failure");
  });
});

// ── vault_batch ───────────────────────────────────────────────────────────────

describe("vault_batch", () => {
  it("processes move operations", async () => {
    const vault = makeVault({ moveNote: vi.fn().mockResolvedValue({ ok: true, path: "dest/b.md" }) });
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager: makeTestManager(vault) as unknown as VaultManager });

    const result = await handlers.get("vault_batch")?.({
      operations: [{ type: "move", path: "src/a", to_path: "dest/b" }],
    });
    const data = parseResult(result) as Array<{ ok: boolean }>;
    expect(data[0]?.ok).toBe(true);
  });

  it("triggers vaultSync handleRename after a successful move", async () => {
    const vault = makeVault({ moveNote: vi.fn().mockResolvedValue({ ok: true, path: "dest/b.md" }) });
    const vaultSync = {
      handleDelete: vi.fn(),
      handleUpsert: vi.fn(),
      handleRename: vi.fn().mockResolvedValue(undefined),
      runFullSync: vi.fn(),
    };
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager: makeTestManager(vault, { vaultSync }) as unknown as VaultManager });

    await handlers.get("vault_batch")?.({
      operations: [{ type: "move", path: "src/a", to_path: "dest/b" }],
    });
    // handleRename is fire-and-forget; give it time to resolve
    await new Promise((r) => setTimeout(r, 10));
    expect(vaultSync.handleRename).toHaveBeenCalledWith("src/a.md", "dest/b.md");
  });

  it("continues to next op when move has no to_path and continue_on_error=true", async () => {
    const vault = makeVault({ moveNote: vi.fn().mockResolvedValue({ ok: true, path: "dest/b.md" }) });
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager: makeTestManager(vault) as unknown as VaultManager });

    const result = await handlers.get("vault_batch")?.({
      operations: [
        { type: "move", path: "src/a" }, // missing to_path → error entry, then continue
        { type: "move", path: "src/b", to_path: "dest/b" },
      ],
      continue_on_error: true,
    });
    const data = parseResult(result) as Array<{ ok: boolean }>;
    expect(data).toHaveLength(2);
    expect(data[0]?.ok).toBe(false);
    expect(data[1]?.ok).toBe(true);
  });

  it("returns error for move without to_path", async () => {
    const vault = makeVault({ moveNote: vi.fn() });
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager: makeTestManager(vault) as unknown as VaultManager });

    const result = await handlers.get("vault_batch")?.({
      operations: [{ type: "move", path: "src/a" }],
    });
    const data = parseResult(result) as Array<{ ok: boolean; message: string }>;
    expect(data[0]?.ok).toBe(false);
    expect(data[0]?.message).toMatch("to_path");
  });

  it("processes delete operations (permanent)", async () => {
    const vault = makeVault({ deleteNote: vi.fn().mockResolvedValue({ ok: true, path: "notes/x.md" }) });
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager: makeTestManager(vault) as unknown as VaultManager });

    const result = await handlers.get("vault_batch")?.({
      operations: [{ type: "delete", path: "notes/x", trash: false }],
    });
    const data = parseResult(result) as Array<{ ok: boolean }>;
    expect(data[0]?.ok).toBe(true);
    expect(vault.deleteNote).toHaveBeenCalled();
  });

  it("notifies vaultSync after permanent delete when vaultSync is provided", async () => {
    const vault = makeVault({ deleteNote: vi.fn().mockResolvedValue({ ok: true, path: "notes/x.md" }) });
    const vaultSync = { handleDelete: vi.fn(), handleUpsert: vi.fn(), handleRename: vi.fn(), runFullSync: vi.fn() };
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager: makeTestManager(vault, { vaultSync }) as unknown as VaultManager });

    await handlers.get("vault_batch")?.({
      operations: [{ type: "delete", path: "notes/x", trash: false }],
    });
    expect(vaultSync.handleDelete).toHaveBeenCalledWith("notes/x.md");
  });

  it("moves file to .trash dir when trash:true", async () => {
    const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), "vault-trash-"));
    const noteFile = path.join(vaultDir, "to-delete.md");
    await fs.writeFile(noteFile, "# Delete me");

    const vault = new VaultRepository({ vaultPath: vaultDir });
    const vaultSync = { handleDelete: vi.fn(), handleUpsert: vi.fn(), handleRename: vi.fn(), runFullSync: vi.fn() };
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager: makeTestManager(vault, { vaultSync }) as unknown as VaultManager });

    const result = await handlers.get("vault_batch")?.({
      operations: [{ type: "delete", path: "to-delete", trash: true }],
    });
    const data = parseResult(result) as Array<{ ok: boolean; message?: string }>;
    expect(data[0]?.ok).toBe(true);
    expect(data[0]?.message).toMatch(/\.trash\//);
    expect(vaultSync.handleDelete).toHaveBeenCalled();

    await fs.rm(vaultDir, { recursive: true, force: true });
  });

  it("processes update_properties operations", async () => {
    const vault = makeVault({ updateProperties: vi.fn().mockResolvedValue({ ok: true, path: "notes/p.md" }) });
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager: makeTestManager(vault) as unknown as VaultManager });

    const result = await handlers.get("vault_batch")?.({
      operations: [{ type: "update_properties", path: "notes/p", properties: { status: "done" } }],
    });
    const data = parseResult(result) as Array<{ ok: boolean }>;
    expect(data[0]?.ok).toBe(true);
  });

  it("stops on first error without continue_on_error", async () => {
    const vault = makeVault({
      moveNote: vi.fn().mockResolvedValue({ ok: false, path: "src/a.md", message: "not found" }),
      deleteNote: vi.fn().mockResolvedValue({ ok: true, path: "notes/b.md" }),
    });
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager: makeTestManager(vault) as unknown as VaultManager });

    const result = await handlers.get("vault_batch")?.({
      operations: [
        { type: "move", path: "src/a", to_path: "dest/a" },
        { type: "delete", path: "notes/b", trash: false },
      ],
    });
    const data = parseResult(result) as Array<{ ok: boolean }>;
    expect(data.length).toBe(1);
    expect(vault.deleteNote).not.toHaveBeenCalled();
  });

  it("continues on error when continue_on_error=true", async () => {
    const vault = makeVault({
      moveNote: vi.fn().mockResolvedValue({ ok: false, path: "src/a.md" }),
      deleteNote: vi.fn().mockResolvedValue({ ok: true, path: "notes/b.md" }),
    });
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager: makeTestManager(vault) as unknown as VaultManager });

    const result = await handlers.get("vault_batch")?.({
      operations: [
        { type: "move", path: "src/a", to_path: "dest/a" },
        { type: "delete", path: "notes/b", trash: false },
      ],
      continue_on_error: true,
    });
    const data = parseResult(result) as Array<{ ok: boolean }>;
    expect(data.length).toBe(2);
    expect(vault.deleteNote).toHaveBeenCalled();
  });

  it("returns error for update_properties without properties", async () => {
    const vault = makeVault({ updateProperties: vi.fn() });
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager: makeTestManager(vault) as unknown as VaultManager });

    const result = await handlers.get("vault_batch")?.({
      operations: [{ type: "update_properties", path: "notes/p" }],
    });
    const data = parseResult(result) as Array<{ ok: boolean; message: string }>;
    expect(data[0]?.ok).toBe(false);
    expect(data[0]?.message).toMatch("properties");
  });

  it("returns ok:false for delete op when ACL denies the path", async () => {
    const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), "vault-acl-batch-"));
    await fs.mkdir(path.join(vaultDir, "private"), { recursive: true });
    await fs.writeFile(path.join(vaultDir, "private", "secret.md"), "# Secret");
    const vault = new VaultRepository({ vaultPath: vaultDir, acl: { allowPaths: [], denyPaths: ["private"] } });
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager: makeTestManager(vault) as unknown as VaultManager });

    const result = await handlers.get("vault_batch")?.({
      operations: [{ type: "delete", path: "private/secret", trash: true }],
    });
    const data = parseResult(result) as Array<{ ok: boolean }>;
    expect(data[0]?.ok).toBe(false);

    await fs.rm(vaultDir, { recursive: true, force: true });
  });
});

// ── vault_sync ────────────────────────────────────────────────────────────────

describe("vault_sync", () => {
  it("returns error when vaultSync not configured", async () => {
    const vault = makeVault();
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager: makeTestManager(vault) as unknown as VaultManager });

    const result = await handlers.get("vault_sync")?.({});
    expect(result.isError).toBe(true);
  });

  it("runs full sync when configured", async () => {
    const vault = makeVault();
    const vaultSync = {
      runFullSync: vi.fn().mockResolvedValue({ indexed: 5, removed: 0 }),
      handleUpsert: vi.fn().mockResolvedValue(undefined),
      handleDelete: vi.fn(),
      handleRename: vi.fn().mockResolvedValue(undefined),
    };
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager: makeTestManager(vault, { vaultSync }) as unknown as VaultManager });

    const result = await handlers.get("vault_sync")?.({});
    const data = parseResult(result);
    expect(data.indexed).toBe(5);
  });
});

// ── vault_embed_backlog ───────────────────────────────────────────────────────

describe("vault_embed_backlog", () => {
  it("returns error when embeddings not enabled", async () => {
    const vault = makeVault();
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager: makeTestManager(vault) as unknown as VaultManager });

    const result = await handlers.get("vault_embed_backlog")?.({});
    expect(result.isError).toBe(true);
  });

  it("runs backlog task when embeddings are configured", async () => {
    const vault = makeVault();
    const embedProvider = new MockEmbedProvider();
    const embeddingConfig = {
      enabled: true,
      apiKey: "",
      endpoint: "",
      model: "text-embedding-3-small",
      hybridAlpha: 0.5,
      batchSize: 10,
      intervalMinutes: 30,
    };
    const { server, handlers } = createMockServer();
    registerTools({
      server,
      vaultManager: makeTestManager(vault, {
        searchStore,
        embeddingStore,
        embedProvider,
        embeddingConfig,
      }) as unknown as VaultManager,
    });

    const result = await handlers.get("vault_embed_backlog")?.({});
    expect(result?.isError).toBeFalsy();
    const data = parseResult(result);
    expect(data.ok).toBe(true);
  });
});

// ── vault_find_connections ────────────────────────────────────────────────────

describe("vault_find_connections", () => {
  it("returns error when embeddings not configured", async () => {
    const vault = makeVault();
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager: makeTestManager(vault) as unknown as VaultManager });

    const result = await handlers.get("vault_find_connections")?.({});
    expect(result.isError).toBe(true);
  });

  it("returns ok with empty suggestions when stores are empty", async () => {
    const vault = makeVault();
    const embedProvider = new MockEmbedProvider();
    const { server, handlers } = createMockServer();
    registerTools({
      server,
      vaultManager: makeTestManager(vault, {
        searchStore,
        embeddingStore,
        embedProvider,
      }) as unknown as VaultManager,
    });

    const result = await handlers.get("vault_find_connections")?.({ limit: 5, min_similarity: 0.5 });
    expect(result?.isError).toBeFalsy();
    const data = parseResult(result);
    expect(data.ok).toBe(true);
    expect(data.suggestions).toBeInstanceOf(Array);
  });
});

// ── vault_backup_db ───────────────────────────────────────────────────────────

describe("vault_backup_db", () => {
  it("returns error when backup not enabled", async () => {
    const vault = makeVault();
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager: makeTestManager(vault) as unknown as VaultManager });

    const result = await handlers.get("vault_backup_db")?.({});
    expect(result.isError).toBe(true);
  });

  it("runs backup successfully when searchStore and backupConfig are provided", async () => {
    const fsp = await import("node:fs/promises");
    const nodePath = await import("node:path");
    const nodeOs = await import("node:os");
    const backupDir = await fsp.mkdtemp(nodePath.join(nodeOs.tmpdir(), "vault-backup-test-"));
    try {
      const vault = makeVault();
      const backupConfig = { enabled: true, dir: backupDir, maxBackups: 3, intervalHours: 24 };
      const { server, handlers } = createMockServer();
      registerTools({
        server,
        vaultManager: makeTestManager(vault, { searchStore, backupConfig }) as unknown as VaultManager,
      });

      const result = await handlers.get("vault_backup_db")?.({});
      expect(result?.isError).toBeFalsy();
      const data = parseResult(result);
      expect(data).toHaveProperty("ok");
    } finally {
      await fsp.rm(backupDir, { recursive: true, force: true });
    }
  });
});

// ── vault_capture ─────────────────────────────────────────────────────────────

describe("vault_capture", () => {
  it("returns error when capture pipeline is disabled", async () => {
    const vault = makeVault();
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager: makeTestManager(vault) as unknown as VaultManager });

    const result = await handlers.get("vault_capture")?.({ text: "test" });
    expect(result.isError).toBe(true);
    const data = parseResult(result);
    expect(data.error).toMatch("ENABLE_CAPTURE_PIPELINE");
  });

  it("returns result when capture pipeline processes successfully", async () => {
    const vault = makeVault();
    const capture = {
      processCapture: vi.fn().mockResolvedValue({ ok: true, notePath: "Inbox/captured.md", category: "note" }),
    };
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager: makeTestManager(vault, { capture }) as unknown as VaultManager });

    const result = await handlers.get("vault_capture")?.({ text: "some text" });
    expect(result?.isError).toBeFalsy();
    const data = parseResult(result);
    expect(data.ok).toBe(true);
  });

  it("triggers vaultSync handleUpsert after capture when notePath is set", async () => {
    const vault = makeVault();
    const capture = {
      processCapture: vi.fn().mockResolvedValue({ ok: true, notePath: "Inbox/captured.md", category: "note" }),
    };
    const vaultSync = {
      runFullSync: vi.fn(),
      handleUpsert: vi.fn().mockResolvedValue(undefined),
      handleDelete: vi.fn(),
      handleRename: vi.fn(),
    };
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager: makeTestManager(vault, { capture, vaultSync }) as unknown as VaultManager });

    const result = await handlers.get("vault_capture")?.({ text: "some text" });
    expect(result?.isError).toBeFalsy();
    // Allow fire-and-forget to resolve
    await new Promise((r) => setTimeout(r, 10));
    expect(vaultSync.handleUpsert).toHaveBeenCalledWith("Inbox/captured.md");
  });
});

// ── vault_list_vaults ─────────────────────────────────────────────────────────

describe("vault_list_vaults", () => {
  it("returns default vault entry from vaultManager", async () => {
    const vault = makeVault();
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager: makeTestManager(vault) as unknown as VaultManager });

    const result = await handlers.get("vault_list_vaults")?.({});
    expect(result.isError).toBeFalsy();
    const data = parseResult(result);
    expect(data.vaults).toHaveLength(1);
    expect(data.vaults[0].name).toBe("default");
  });

  it("does not expose filesystem paths", async () => {
    const vault = makeVault();
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager: makeTestManager(vault) as unknown as VaultManager });

    const result = await handlers.get("vault_list_vaults")?.({});
    const data = parseResult(result);
    expect(data.vaults[0].path).toBeUndefined();
  });

  it("returns all vault names from vaultManager without paths", async () => {
    const { server, handlers } = createMockServer();
    const vaultManager = {
      listVaults: vi.fn().mockReturnValue([{ name: "default" }, { name: "work" }]),
      getServices: vi.fn(),
      config: MIN_VAULT_CONFIG,
    };
    registerTools({ server, vaultManager } as unknown as RegisterToolsOptions);

    const result = await handlers.get("vault_list_vaults")?.({});
    expect(result.isError).toBeFalsy();
    const data = parseResult(result);
    expect(data.vaults).toHaveLength(2);
    expect(data.total).toBe(2);
    expect(data.vaults).toEqual(expect.arrayContaining([{ name: "default" }, { name: "work" }]));
    expect(data.vaults[0].path).toBeUndefined();
  });
});

// ── vault routing via vaultManager ───────────────────────────────────────────

describe("vault routing via vaultManager", () => {
  function makeVaultManager(vaults: Record<string, ReturnType<typeof makeVault>>) {
    return {
      listVaults: vi.fn().mockReturnValue(Object.keys(vaults).map((n) => ({ name: n }))),
      getServices: vi.fn((name = "default") => {
        const v = vaults[name];
        if (!v) throw new Error(`Unknown vault: "${name}". Available: ${Object.keys(vaults).join(", ")}`);
        return {
          vault: v,
          searchStore: undefined,
          vaultSync: undefined,
          capture: null,
          embeddingStore: undefined,
          embedProvider: undefined,
          embeddingConfig: { enabled: false, hybridAlpha: 0.5, batchSize: 20, intervalMinutes: 30 },
          aclConfig: { allowPaths: [], denyPaths: [] },
          vaultPath: `/${name}`,
          watcher: null,
          bootReady: Promise.resolve(),
          bootFailed: false,
        };
      }),
      config: MIN_VAULT_CONFIG,
    };
  }

  it("routes tool call with vault param to the correct VaultRepository", async () => {
    const defaultVault = makeVault({
      readNote: vi.fn().mockResolvedValue({ path: "note.md", name: "note", content: "default", frontmatter: {} }),
    });
    const workVault = makeVault({
      readNote: vi.fn().mockResolvedValue({ path: "note.md", name: "note", content: "work", frontmatter: {} }),
    });
    const vaultManager = makeVaultManager({ default: defaultVault, work: workVault });
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager } as unknown as RegisterToolsOptions);

    const result = await handlers.get("vault_read_note")?.({ path: "note", vault: "work" });
    const data = parseResult(result);
    expect(data.content).toBe("work");
    expect(workVault.readNote).toHaveBeenCalled();
    expect(defaultVault.readNote).not.toHaveBeenCalled();
  });

  it("returns structured error response for unknown vault name", async () => {
    const vaultManager = makeVaultManager({ default: makeVault() });
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager } as unknown as RegisterToolsOptions);

    const result = await handlers.get("vault_read_note")?.({ path: "note", vault: "nonexistent" });
    expect(result.isError).toBe(true);
    const data = parseResult(result);
    expect(data.error).toMatch(/Unknown vault/);
  });
});

// ── wrapHandler: timeout + telemetry ─────────────────────────────────────────

describe("wrapHandler timeout enforcement", () => {
  it("returns isError response when tool exceeds toolTimeoutMs", async () => {
    const vault = makeVault({
      // Never resolves — simulates a hung operation
      readNote: vi.fn().mockImplementation(() => new Promise(() => {})),
    });
    const { server, handlers } = createMockServer();
    // Set a very short timeout so the test doesn't wait long
    registerTools({
      server,
      vaultManager: makeTestManager(vault, { toolTimeoutMs: 50 }) as unknown as VaultManager,
    });

    const result = await handlers.get("vault_read_note")?.({ path: "hang" });
    expect(result?.isError).toBe(true);
    const data = parseResult(result);
    expect(data.error).toMatch(/timed out/i);
  });

  it("does NOT timeout when toolTimeoutMs is 0 (disabled)", async () => {
    const vault = makeVault({
      readNote: vi.fn().mockResolvedValue({ path: "ok.md", name: "ok", content: "", frontmatter: {} }),
    });
    const { server, handlers } = createMockServer();
    registerTools({
      server,
      vaultManager: makeTestManager(vault, { toolTimeoutMs: 0 }) as unknown as VaultManager,
    });

    const result = await handlers.get("vault_read_note")?.({ path: "ok" });
    expect(result?.isError).toBeFalsy();
  });

  it("fires endSpan with an error and oSpan.end with the error when a tool times out", async () => {
    const telemetryMod = await import("../utils/telemetry.js");
    const otelMod = await import("../utils/otel.js");

    const endSpanSpy = vi.spyOn(telemetryMod, "endSpan");

    // Capture the OtelSpan created by otelSpan() so we can spy on its end()
    const oSpanEndSpy = vi.fn();
    vi.spyOn(otelMod, "otelSpan").mockReturnValue({ end: oSpanEndSpy });

    const vault = makeVault({
      readNote: vi.fn().mockImplementation(() => new Promise(() => {})),
    });
    const { server, handlers } = createMockServer();
    registerTools({
      server,
      vaultManager: makeTestManager(vault, { toolTimeoutMs: 50 }) as unknown as VaultManager,
    });

    await handlers.get("vault_read_note")?.({ path: "hang" });

    // endSpan must have been called with an Error (the TimeoutError)
    expect(endSpanSpy).toHaveBeenCalledOnce();
    expect(endSpanSpy.mock.calls[0]?.[1]).toBeInstanceOf(Error);

    // oSpan.end must have been called with the error (new unified API)
    expect(oSpanEndSpy).toHaveBeenCalledOnce();
    expect(oSpanEndSpy.mock.calls[0]?.[0]).toBeInstanceOf(Error);

    endSpanSpy.mockRestore();
    vi.mocked(otelMod.otelSpan).mockRestore();
  });
});

// ── vault_read_section (integration with real fs) ────────────────────────────

describe("vault_read_section integration", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sec-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns section content when heading exists", async () => {
    const notePath = path.join(tmpDir, "doc.md");
    await fs.writeFile(notePath, "# Introduction\nHello world.\n\n## Details\nSome details.\n");
    const vault = makeVault({
      readNote: vi.fn().mockResolvedValue({
        path: "doc.md",
        name: "doc",
        content: "# Introduction\nHello world.\n\n## Details\nSome details.\n",
        frontmatter: {},
      }),
    });
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager: makeTestManager(vault) as unknown as VaultManager });

    const result = await handlers.get("vault_read_section")?.({ path: "doc", heading: "Introduction" });
    expect(result?.isError).toBeFalsy();
    const data = parseResult(result);
    expect(data.content ?? data.text ?? data).toBeDefined();
  });

  it("returns error when heading not found", async () => {
    const vault = makeVault({
      readNote: vi.fn().mockResolvedValue({
        path: "doc.md",
        name: "doc",
        content: "# Introduction\nHello.\n",
        frontmatter: {},
      }),
    });
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager: makeTestManager(vault) as unknown as VaultManager });

    const result = await handlers.get("vault_read_section")?.({ path: "doc", heading: "NonExistent" });
    expect(result?.isError).toBe(true);
  });
});

// ── vault_get_note_with_links ─────────────────────────────────────────────────

describe("vault_get_note_with_links", () => {
  it("returns note with linked notes resolved", async () => {
    const noteA = { path: "A.md", name: "A", content: "Links to [[B]]", frontmatter: {} };
    const noteB = { path: "B.md", name: "B", content: "Note B", frontmatter: {} };
    const vault = makeVault({
      readNote: vi.fn().mockImplementation((p: string) => {
        if (p.includes("A")) return Promise.resolve(noteA);
        if (p.includes("B")) return Promise.resolve(noteB);
        return Promise.reject(new Error("not found"));
      }),
    });
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager: makeTestManager(vault) as unknown as VaultManager });

    const result = await handlers.get("vault_get_note_with_links")?.({ path: "A", max_links: 5 });
    expect(result?.isError).toBeFalsy();
    const data = parseResult(result);
    expect(data.note).toBeDefined();
    expect(data.linked_notes).toBeInstanceOf(Array);
  });

  it("returns just the note when it has no wikilinks", async () => {
    const vault = makeVault({
      readNote: vi.fn().mockResolvedValue({ path: "solo.md", name: "solo", content: "No links here", frontmatter: {} }),
    });
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager: makeTestManager(vault) as unknown as VaultManager });

    const result = await handlers.get("vault_get_note_with_links")?.({ path: "solo" });
    expect(result?.isError).toBeFalsy();
    const data = parseResult(result);
    expect(data.linked_notes).toHaveLength(0);
  });

  it("falls back to searchByPathOrName when readNote fails for a linked note", async () => {
    const noteA = { path: "A.md", name: "A", content: "Links to [[SomeNote]]", frontmatter: {} };
    const noteB = { path: "Folder/SomeNote.md", name: "SomeNote", content: "Found via search", frontmatter: {} };
    const vault = makeVault({
      readNote: vi.fn().mockImplementation((p: string) => {
        // Only exact path resolves; wikilink text "SomeNote" (no folder, no .md) fails
        if (p === "A" || p === "A.md") return Promise.resolve(noteA);
        if (p === "Folder/SomeNote.md") return Promise.resolve(noteB);
        return Promise.reject(new Error("not found"));
      }),
      searchByPathOrName: vi.fn().mockResolvedValue([{ path: "Folder/SomeNote.md", name: "SomeNote.md" }]),
    });
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager: makeTestManager(vault) as unknown as VaultManager });

    const result = await handlers.get("vault_get_note_with_links")?.({ path: "A", max_links: 5 });
    expect(result?.isError).toBeFalsy();
    const data = parseResult(result);
    expect(data.linked_notes).toBeInstanceOf(Array);
    expect(vault.searchByPathOrName).toHaveBeenCalled();
  });
});

// ── vault_batch (additional coverage) ────────────────────────────────────────

describe("vault_batch additional", () => {
  it("processes update_properties operations", async () => {
    const vault = makeVault({
      updateProperties: vi.fn().mockResolvedValue({ ok: true, path: "note.md" }),
    });
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager: makeTestManager(vault) as unknown as VaultManager });

    const result = await handlers.get("vault_batch")?.({
      operations: [{ type: "update_properties", path: "note", properties: { status: "done" } }],
    });
    expect(result?.isError).toBeFalsy();
    const data: Array<{ ok: boolean; path: string }> = parseResult(result);
    expect(data).toHaveLength(1);
    expect(data[0]?.ok).toBe(true);
  });

  it("stops on first error when continue_on_error is false", async () => {
    const vault = makeVault({
      moveNote: vi.fn().mockRejectedValue(new Error("move failed")),
    });
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager: makeTestManager(vault) as unknown as VaultManager });

    const result = await handlers.get("vault_batch")?.({
      operations: [
        { type: "move", path: "a", to_path: "b" },
        { type: "move", path: "c", to_path: "d" },
      ],
      continue_on_error: false,
    });
    expect(result?.isError).toBeFalsy();
    const data: Array<{ ok: boolean }> = parseResult(result);
    // Should stop after first failure
    expect(data).toHaveLength(1);
    expect(data[0]?.ok).toBe(false);
  });

  it("continues after error when continue_on_error is true", async () => {
    const vault = makeVault({
      moveNote: vi
        .fn()
        .mockRejectedValueOnce(new Error("first fails"))
        .mockResolvedValueOnce({ ok: true, path: "d.md" }),
    });
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager: makeTestManager(vault) as unknown as VaultManager });

    const result = await handlers.get("vault_batch")?.({
      operations: [
        { type: "move", path: "a", to_path: "b" },
        { type: "move", path: "c", to_path: "d" },
      ],
      continue_on_error: true,
    });
    expect(result?.isError).toBeFalsy();
    const data: Array<{ ok: boolean }> = parseResult(result);
    expect(data).toHaveLength(2);
    expect(data[0]?.ok).toBe(false);
    expect(data[1]?.ok).toBe(true);
  });

  it("returns error entry for move operation missing to_path", async () => {
    const vault = makeVault();
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager: makeTestManager(vault) as unknown as VaultManager });

    const result = await handlers.get("vault_batch")?.({
      operations: [{ type: "move", path: "a" }],
    });
    expect(result?.isError).toBeFalsy();
    const data: Array<{ ok: boolean; message?: string }> = parseResult(result);
    expect(data[0]?.ok).toBe(false);
    expect(data[0]?.message).toMatch(/to_path/);
  });

  it("continues after update_properties missing properties when continue_on_error=true", async () => {
    const vault = makeVault({
      moveNote: vi.fn().mockResolvedValue({ ok: true, path: "b.md" }),
    });
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager: makeTestManager(vault) as unknown as VaultManager });

    const result = await handlers.get("vault_batch")?.({
      operations: [
        { type: "update_properties", path: "note" }, // missing properties
        { type: "move", path: "a", to_path: "b" },
      ],
      continue_on_error: true,
    });
    expect(result?.isError).toBeFalsy();
    const data: Array<{ ok: boolean; message?: string }> = parseResult(result);
    expect(data).toHaveLength(2);
    expect(data[0]?.ok).toBe(false);
    expect(data[0]?.message).toMatch(/properties/);
    expect(data[1]?.ok).toBe(true);
  });

  it("triggers vaultSync handleUpsert after successful update_properties", async () => {
    const vault = makeVault({
      updateProperties: vi.fn().mockResolvedValue({ ok: true, path: "note.md" }),
    });
    const vaultSync = {
      handleUpsert: vi.fn().mockResolvedValue(undefined),
      handleDelete: vi.fn(),
      handleRename: vi.fn(),
      runFullSync: vi.fn(),
    };
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager: makeTestManager(vault, { vaultSync }) as unknown as VaultManager });

    const result = await handlers.get("vault_batch")?.({
      operations: [{ type: "update_properties", path: "note", properties: { status: "done" } }],
    });
    expect(result?.isError).toBeFalsy();
    const data: Array<{ ok: boolean }> = parseResult(result);
    expect(data[0]?.ok).toBe(true);
    // Give the fire-and-forget promise time to resolve
    await new Promise((r) => setTimeout(r, 10));
    expect(vaultSync.handleUpsert).toHaveBeenCalledWith("note.md");
  });
});

// ── vault boot failure propagation ────────────────────────────────────────────

describe("getSvc boot failure propagation", () => {
  it("vault_batch returns isError when getSvc throws", async () => {
    const rejected = Promise.reject(new Error("vault boot failed"));
    rejected.catch(() => {});

    const vaultManager = {
      getServices: () => ({
        bootReady: rejected,
        bootFailed: true,
        vault: makeVault(),
        searchStore: undefined,
        vaultSync: undefined,
        capture: null,
        embeddingStore: undefined,
        embedProvider: undefined,
        embeddingConfig: { enabled: false },
        aclConfig: { allowPaths: [], denyPaths: [] },
        vaultPath: "/vault",
        watcher: null,
      }),
      listVaults: () => [],
      config: MIN_VAULT_CONFIG,
    };
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager } as unknown as RegisterToolsOptions);

    const result = await handlers.get("vault_batch")?.({
      operations: [{ type: "move", path: "a", to_path: "b" }],
    });
    expect(result?.isError).toBe(true);
  });

  it("returns isError when vaultManager.bootReady rejects", async () => {
    const rejected = Promise.reject(new Error("boot failed: disk error"));
    rejected.catch(() => {}); // prevent unhandled rejection warning

    const vaultManager = {
      getServices: () => ({
        bootReady: rejected,
        bootFailed: true,
        vault: makeVault(),
        searchStore: undefined,
        vaultSync: undefined,
        capture: null,
        embeddingStore: undefined,
        embedProvider: undefined,
        embeddingConfig: { enabled: false },
        aclConfig: { allowPaths: [], denyPaths: [] },
        vaultPath: "/vault",
        watcher: null,
      }),
      listVaults: () => [],
      config: MIN_VAULT_CONFIG,
    };
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager } as unknown as RegisterToolsOptions);

    const result = await handlers.get("vault_read_note")?.({ path: "foo.md" });
    expect(result?.isError).toBe(true);
    const data = parseResult(result);
    expect(data.error).toBeDefined();
  });

  function makeBootFailManager() {
    const rejected = Promise.reject(new Error("boot failed"));
    rejected.catch(() => {});
    return {
      getServices: () => ({
        bootReady: rejected,
        bootFailed: true,
        vault: makeVault(),
        searchStore: undefined,
        vaultSync: undefined,
        capture: null,
        embeddingStore: undefined,
        embedProvider: undefined,
        embeddingConfig: { enabled: false },
        aclConfig: { allowPaths: [], denyPaths: [] },
        vaultPath: "/vault",
        watcher: null,
      }),
      listVaults: () => [],
      config: MIN_VAULT_CONFIG,
    };
  }

  it("vault_get_note_with_links returns isError when getSvc throws", async () => {
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager: makeBootFailManager() } as unknown as RegisterToolsOptions);

    const result = await handlers.get("vault_get_note_with_links")?.({ path: "note.md" });
    expect(result?.isError).toBe(true);
  });

  it("vault_capture returns isError when getSvc throws", async () => {
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager: makeBootFailManager() } as unknown as RegisterToolsOptions);

    const result = await handlers.get("vault_capture")?.({ text: "test" });
    expect(result?.isError).toBe(true);
  });

  it("vault_sync returns isError when getSvc throws", async () => {
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager: makeBootFailManager() } as unknown as RegisterToolsOptions);

    const result = await handlers.get("vault_sync")?.({});
    expect(result?.isError).toBe(true);
  });

  it("vault_embed_backlog returns isError when getSvc throws", async () => {
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager: makeBootFailManager() } as unknown as RegisterToolsOptions);

    const result = await handlers.get("vault_embed_backlog")?.({});
    expect(result?.isError).toBe(true);
  });

  it("vault_find_connections returns isError when getSvc throws", async () => {
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager: makeBootFailManager() } as unknown as RegisterToolsOptions);

    const result = await handlers.get("vault_find_connections")?.({});
    expect(result?.isError).toBe(true);
  });

  it("vault_backup_db returns isError when getSvc throws", async () => {
    const { server, handlers } = createMockServer();
    registerTools({ server, vaultManager: makeBootFailManager() } as unknown as RegisterToolsOptions);

    const result = await handlers.get("vault_backup_db")?.({});
    expect(result?.isError).toBe(true);
  });
});
