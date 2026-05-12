import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EmbeddingStore } from "./embeddings.js";

describe("EmbeddingStore", () => {
  let db: Database.Database;
  let store: EmbeddingStore;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    store = new EmbeddingStore(db);
    store.initSchema();
  });

  afterEach(() => {
    db.close();
  });

  it("starts empty", () => {
    store.load();
    expect(store.size).toBe(0);
  });

  it("upsert + load round-trip preserves Float32Array", () => {
    const vec = new Float32Array([1, 0, 0]);
    store.upsert("a.md", vec, "hash1", "test-model");
    expect(store.size).toBe(1);

    // Create a new store on the same db to test load from SQLite
    const store2 = new EmbeddingStore(db);
    store2.initSchema();
    store2.load();
    expect(store2.size).toBe(1);

    const results = store2.search(new Float32Array([1, 0, 0]), 10);
    expect(results.length).toBe(1);
    expect(results[0].path).toBe("a.md");
    expect(results[0].similarity).toBeCloseTo(1.0, 5);
  });

  it("cosine similarity: parallel vectors = 1.0", () => {
    store.upsert("a.md", new Float32Array([1, 0, 0]), "h1", "m");
    const results = store.search(new Float32Array([1, 0, 0]), 10);
    expect(results[0].similarity).toBeCloseTo(1.0, 5);
  });

  it("cosine similarity: orthogonal vectors = 0.0", () => {
    store.upsert("a.md", new Float32Array([1, 0, 0]), "h1", "m");
    const results = store.search(new Float32Array([0, 1, 0]), 10);
    expect(results[0].similarity).toBeCloseTo(0.0, 5);
  });

  it("cosine similarity: opposite vectors = -1.0", () => {
    store.upsert("a.md", new Float32Array([1, 0, 0]), "h1", "m");
    const results = store.search(new Float32Array([-1, 0, 0]), 10);
    expect(results[0].similarity).toBeCloseTo(-1.0, 5);
  });

  it("search returns results sorted by similarity", () => {
    store.upsert("a.md", new Float32Array([1, 0, 0]), "h1", "m");
    store.upsert("b.md", new Float32Array([0.7, 0.7, 0]), "h2", "m");
    store.upsert("c.md", new Float32Array([0, 1, 0]), "h3", "m");

    const results = store.search(new Float32Array([1, 0, 0]), 10);
    expect(results.length).toBe(3);
    expect(results[0].path).toBe("a.md");
    expect(results[0].similarity).toBeGreaterThan(results[1].similarity);
    expect(results[1].similarity).toBeGreaterThan(results[2].similarity);
  });

  it("search respects limit", () => {
    store.upsert("a.md", new Float32Array([1, 0, 0]), "h1", "m");
    store.upsert("b.md", new Float32Array([0.9, 0.1, 0]), "h2", "m");
    store.upsert("c.md", new Float32Array([0.8, 0.2, 0]), "h3", "m");

    const results = store.search(new Float32Array([1, 0, 0]), 2);
    expect(results.length).toBe(2);
  });

  it("delete removes from both SQLite and memory", () => {
    store.upsert("a.md", new Float32Array([1, 0, 0]), "h1", "m");
    expect(store.size).toBe(1);

    store.delete("a.md");
    expect(store.size).toBe(0);

    const results = store.search(new Float32Array([1, 0, 0]), 10);
    expect(results.length).toBe(0);

    // Verify SQLite is also clean
    const store2 = new EmbeddingStore(db);
    store2.initSchema();
    store2.load();
    expect(store2.size).toBe(0);
  });

  it("getStaleOrMissing detects missing entries", () => {
    const current = new Map([
      ["a.md", "hash_a"],
      ["b.md", "hash_b"],
    ]);

    store.upsert("a.md", new Float32Array([1, 0, 0]), "hash_a", "m");
    // b.md is missing from embeddings

    const stale = store.getStaleOrMissing(current);
    expect(stale).toEqual(["b.md"]);
  });

  it("getStaleOrMissing detects hash mismatches", () => {
    const current = new Map([["a.md", "hash_a_new"]]);

    store.upsert("a.md", new Float32Array([1, 0, 0]), "hash_a_old", "m");

    const stale = store.getStaleOrMissing(current);
    expect(stale).toEqual(["a.md"]);
  });

  it("getStaleOrMissing returns empty when all up to date", () => {
    const current = new Map([["a.md", "hash_a"]]);
    store.upsert("a.md", new Float32Array([1, 0, 0]), "hash_a", "m");

    const stale = store.getStaleOrMissing(current);
    expect(stale).toEqual([]);
  });

  it("upsert overwrites existing entry", () => {
    store.upsert("a.md", new Float32Array([1, 0, 0]), "hash1", "m");
    store.upsert("a.md", new Float32Array([0, 1, 0]), "hash2", "m");
    expect(store.size).toBe(1);

    const results = store.search(new Float32Array([0, 1, 0]), 10);
    expect(results[0].similarity).toBeCloseTo(1.0, 5);
  });

  it("getStaleOrMissing detects model change", () => {
    const current = new Map([["a.md", "hash_a"]]);
    store.upsert("a.md", new Float32Array([1, 0, 0]), "hash_a", "old-model");

    // Without model check — not stale
    const stale1 = store.getStaleOrMissing(current);
    expect(stale1).toEqual([]);

    // With model check — stale because model changed
    const stale2 = store.getStaleOrMissing(current, "new-model");
    expect(stale2).toEqual(["a.md"]);

    // With matching model — not stale
    const stale3 = store.getStaleOrMissing(current, "old-model");
    expect(stale3).toEqual([]);
  });

  it("deleteOrphans removes entries not in current paths", () => {
    store.upsert("a.md", new Float32Array([1, 0, 0]), "h1", "m");
    store.upsert("b.md", new Float32Array([0, 1, 0]), "h2", "m");
    store.upsert("c.md", new Float32Array([0, 0, 1]), "h3", "m");
    expect(store.size).toBe(3);

    // Only a.md and c.md still exist in vault
    const deleted = store.deleteOrphans(new Set(["a.md", "c.md"]));
    expect(deleted).toBe(1);
    expect(store.size).toBe(2);

    // b.md should not appear in search
    const results = store.search(new Float32Array([0, 1, 0]), 10);
    expect(results.every((r) => r.path !== "b.md")).toBe(true);
  });

  it("deleteOrphans returns 0 when no orphans", () => {
    store.upsert("a.md", new Float32Array([1, 0, 0]), "h1", "m");
    const deleted = store.deleteOrphans(new Set(["a.md"]));
    expect(deleted).toBe(0);
    expect(store.size).toBe(1);
  });
});
