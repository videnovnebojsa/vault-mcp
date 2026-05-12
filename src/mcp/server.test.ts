import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EmbeddingStore } from "../search/embeddings.js";
import { VaultSearchStore } from "../search/store.js";
import { type ResourcesContext, registerResources } from "./server.js";

// ── test helpers ──────────────────────────────────────────────────────────────

type ResourceHandler = (uri: URL) => Promise<{
  contents: Array<{ uri: string; mimeType?: string; text: string }>;
}>;

function makeResourceMock() {
  const handlers = new Map<string, ResourceHandler>();
  const server = {
    resource: (_name: string, uri: string, _meta: unknown, fn: ResourceHandler) => {
      handlers.set(uri, fn);
    },
  };
  return { server: server as unknown as McpServer, handlers };
}

function assertDefined<T>(val: T | undefined): T {
  if (val === undefined) throw new Error("Expected defined value");
  return val;
}

function parseResource(result: { contents: Array<{ text: string }> }) {
  return JSON.parse(result.contents[0]?.text ?? "{}") as Record<string, unknown>;
}

async function readResource(handlers: Map<string, ResourceHandler>, uri: string) {
  const result = assertDefined(await handlers.get(uri)?.(new URL(uri)));
  return { result, data: parseResource(result) };
}

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

// ── vault://config ────────────────────────────────────────────────────────────

describe("vault://config resource", () => {
  it("returns feature flags (vaultPath is redacted)", async () => {
    const { server, handlers } = makeResourceMock();
    const opts: ResourcesContext = {
      watcherEnabled: true,
      captureEnabled: false,
      embeddingConfig: { enabled: false, hybridAlpha: 0.5, batchSize: 20, intervalMinutes: 30 },
      backupEnabled: true,
      mcpHost: "127.0.0.1",
      mcpPort: 3782,
    };
    registerResources(server, opts);

    const { result, data } = await readResource(handlers, "vault://config");

    expect(data.vaultPath).toBeUndefined();
    expect((data.features as Record<string, unknown>).watcher).toBe(true);
    expect((data.features as Record<string, unknown>).capture).toBe(false);
    expect((data.features as Record<string, unknown>).embeddings).toBe(false);
    expect((data.features as Record<string, unknown>).backup).toBe(true);
    expect((data.server as Record<string, unknown>).host).toBe("127.0.0.1");
    expect((data.server as Record<string, unknown>).port).toBe(3782);
    expect(result.contents[0]?.mimeType).toBe("application/json");
  });

  it("echoes the URI back in contents", async () => {
    const { server, handlers } = makeResourceMock();
    registerResources(server, { vaultPath: "/v" });

    const { result } = await readResource(handlers, "vault://config");
    expect(result.contents[0]?.uri).toBe("vault://config");
  });

  it("uses defaults when optional fields are omitted", async () => {
    const { server, handlers } = makeResourceMock();
    registerResources(server, { vaultPath: "/v" });

    const { data } = await readResource(handlers, "vault://config");

    expect(data.periodicNotesRoot).toBe("Journal");
    expect((data.features as Record<string, unknown>).embeddings).toBe(false);
    expect((data.features as Record<string, unknown>).watcher).toBe(false);
    expect((data.features as Record<string, unknown>).backup).toBe(false);
    expect((data.features as Record<string, unknown>).capture).toBe(false);
    expect((data.acl as Record<string, unknown>).allowCount).toBe(0);
    expect((data.acl as Record<string, unknown>).denyCount).toBe(0);
    expect((data.server as Record<string, unknown>).host).toBe("127.0.0.1");
    expect((data.server as Record<string, unknown>).port).toBe(3782);
  });

  it("reflects ACL counts when provided", async () => {
    const { server, handlers } = makeResourceMock();
    registerResources(server, {
      vaultPath: "/v",
      aclConfig: { allowPaths: ["notes/", "journal/"], denyPaths: ["private/"] },
    });

    const { data } = await readResource(handlers, "vault://config");

    expect((data.acl as Record<string, unknown>).allowCount).toBe(2);
    expect((data.acl as Record<string, unknown>).denyCount).toBe(1);
  });

  it("reflects embeddings enabled when set", async () => {
    const { server, handlers } = makeResourceMock();
    registerResources(server, {
      vaultPath: "/v",
      embeddingConfig: { enabled: true, hybridAlpha: 0.5, batchSize: 20, intervalMinutes: 30 },
    });

    const { data } = await readResource(handlers, "vault://config");
    expect((data.features as Record<string, unknown>).embeddings).toBe(true);
  });
});

// ── vault://stats ─────────────────────────────────────────────────────────────

describe("vault://stats resource", () => {
  it("returns zero counts when searchStore is absent", async () => {
    const { server, handlers } = makeResourceMock();
    registerResources(server, { vaultPath: "/v" });

    const { data } = await readResource(handlers, "vault://stats");

    expect((data.notes as Record<string, unknown>).total).toBe(0);
    expect((data.notes as Record<string, unknown>).indexed).toBe(0);
    expect((data.tags as Record<string, unknown>).unique).toBe(0);
    expect((data.embeddings as Record<string, unknown>).enabled).toBe(false);
    expect((data.embeddings as Record<string, unknown>).coverage).toBeNull();
  });

  it("returns note count from searchStore", async () => {
    searchStore.upsert("a.md", "hello", "h1", "a", {});
    searchStore.upsert("b.md", "world", "h2", "b", {});

    const { server, handlers } = makeResourceMock();
    registerResources(server, { vaultPath: "/v", searchStore });

    const { data } = await readResource(handlers, "vault://stats");

    expect((data.notes as Record<string, unknown>).total).toBe(2);
    expect((data.notes as Record<string, unknown>).indexed).toBe(2);
  });

  it("returns unique tag count from searchStore", async () => {
    searchStore.upsert("a.md", "x", "h1", "a", { tags: ["ai", "ml"] });
    searchStore.upsert("b.md", "y", "h2", "b", { tags: ["ai", "productivity"] });

    const { server, handlers } = makeResourceMock();
    registerResources(server, { vaultPath: "/v", searchStore });

    const { data } = await readResource(handlers, "vault://stats");

    expect((data.tags as Record<string, unknown>).unique).toBe(3);
  });

  it("excludes denied paths from note count", async () => {
    searchStore.upsert("notes/public.md", "x", "h1", "public", {});
    searchStore.upsert("private/secret.md", "y", "h2", "secret", {});

    const { server, handlers } = makeResourceMock();
    registerResources(server, {
      vaultPath: "/v",
      searchStore,
      aclConfig: { allowPaths: [], denyPaths: ["private"] },
    });

    const { data } = await readResource(handlers, "vault://stats");

    expect((data.notes as Record<string, unknown>).total).toBe(1);
  });

  it("excludes denied paths from tag count", async () => {
    searchStore.upsert("notes/public.md", "x", "h1", "public", { tags: ["visible"] });
    searchStore.upsert("private/secret.md", "y", "h2", "secret", { tags: ["hidden"] });

    const { server, handlers } = makeResourceMock();
    registerResources(server, {
      vaultPath: "/v",
      searchStore,
      aclConfig: { allowPaths: [], denyPaths: ["private"] },
    });

    const { data } = await readResource(handlers, "vault://stats");

    expect((data.tags as Record<string, unknown>).unique).toBe(1);
  });

  it("uses embeddingStore.size for coverage (includes all embeddings, no intersection)", async () => {
    searchStore.upsert("notes/public.md", "x", "h1", "public", {});
    searchStore.upsert("private/secret.md", "y", "h2", "secret", {});
    embeddingStore.upsert("notes/public.md", new Float32Array([0.1, 0.2]), "hash1", "test-model");
    embeddingStore.upsert("private/secret.md", new Float32Array([0.3, 0.4]), "hash2", "test-model");

    const { server, handlers } = makeResourceMock();
    registerResources(server, {
      vaultPath: "/v",
      searchStore,
      embeddingStore,
      embeddingConfig: { enabled: true, hybridAlpha: 0.5, batchSize: 20, intervalMinutes: 30 },
      aclConfig: { allowPaths: [], denyPaths: ["private"] },
    });

    const { data } = await readResource(handlers, "vault://stats");
    // total=1 (ACL-filtered), embeddedCount=2 (embeddingStore.size, no intersection) → coverage=2.0
    expect((data.notes as Record<string, unknown>).total).toBe(1);
    expect((data.embeddings as Record<string, unknown>).coverage).toBeCloseTo(2.0);
  });

  it("includes orphaned embeddings in coverage (no intersection check)", async () => {
    searchStore.upsert("a.md", "x", "h1", "a", {});
    // b.md has an embedding but is not (or no longer) in the index
    embeddingStore.upsert("a.md", new Float32Array([0.1, 0.2]), "hash1", "test-model");
    embeddingStore.upsert("b.md", new Float32Array([0.3, 0.4]), "hash2", "test-model");

    const { server, handlers } = makeResourceMock();
    registerResources(server, {
      vaultPath: "/v",
      searchStore,
      embeddingStore,
      embeddingConfig: { enabled: true, hybridAlpha: 0.5, batchSize: 20, intervalMinutes: 30 },
    });

    const { data } = await readResource(handlers, "vault://stats");
    // total=1, embeddedCount=2 (embeddingStore.size includes orphan b.md) → coverage=2.0
    expect((data.notes as Record<string, unknown>).total).toBe(1);
    expect((data.embeddings as Record<string, unknown>).coverage).toBeCloseTo(2.0);
  });

  it("returns coverage = null when embeddings disabled", async () => {
    searchStore.upsert("a.md", "x", "h1", "a", {});

    const { server, handlers } = makeResourceMock();
    registerResources(server, {
      vaultPath: "/v",
      searchStore,
      embeddingConfig: { enabled: false, hybridAlpha: 0.5, batchSize: 20, intervalMinutes: 30 },
    });

    const { data } = await readResource(handlers, "vault://stats");

    expect((data.embeddings as Record<string, unknown>).enabled).toBe(false);
    expect((data.embeddings as Record<string, unknown>).coverage).toBeNull();
  });

  it("returns coverage = null when total = 0 (division-by-zero guard)", async () => {
    const { server, handlers } = makeResourceMock();
    registerResources(server, {
      vaultPath: "/v",
      searchStore,
      embeddingStore,
      embeddingConfig: { enabled: true, hybridAlpha: 0.5, batchSize: 20, intervalMinutes: 30 },
    });

    const { data } = await readResource(handlers, "vault://stats");

    expect((data.embeddings as Record<string, unknown>).coverage).toBeNull();
  });

  it("returns coverage ratio when embeddings enabled and notes exist", async () => {
    searchStore.upsert("a.md", "x", "h1", "a", {});
    searchStore.upsert("b.md", "y", "h2", "b", {});
    embeddingStore.upsert("a.md", new Float32Array([0.1, 0.2]), "hash1", "test-model");

    const { server, handlers } = makeResourceMock();
    registerResources(server, {
      vaultPath: "/v",
      searchStore,
      embeddingStore,
      embeddingConfig: { enabled: true, hybridAlpha: 0.5, batchSize: 20, intervalMinutes: 30 },
    });

    const { data } = await readResource(handlers, "vault://stats");

    expect((data.embeddings as Record<string, unknown>).enabled).toBe(true);
    expect((data.embeddings as Record<string, unknown>).coverage).toBeCloseTo(0.5);
  });

  it("echoes the URI back in contents", async () => {
    const { server, handlers } = makeResourceMock();
    registerResources(server, { vaultPath: "/v" });

    const { result } = await readResource(handlers, "vault://stats");
    expect(result.contents[0]?.uri).toBe("vault://stats");
    expect(result.contents[0]?.mimeType).toBe("application/json");
  });
});
