import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EmbeddingStore } from "./embeddings.js";
import { sanitizeFTS5Query, VaultSearchStore } from "./store.js";

describe("VaultSearchStore", () => {
  let store: VaultSearchStore;

  beforeEach(() => {
    store = new VaultSearchStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  it("creates schema without error", () => {
    expect(store.count()).toBe(0);
  });

  it("upserts and retrieves by path", () => {
    const { changed } = store.upsert("notes/hello.md", "Hello world", "abc123", "hello", { type: "note" });
    expect(changed).toBe(true);

    const entry = store.getByPath("notes/hello.md");
    expect(entry).toBeDefined();
    expect(entry?.canonicalPath).toBe("notes/hello.md");
    expect(entry?.content).toBe("Hello world");
    expect(entry?.contentHash).toBe("abc123");
    expect(entry?.fileName).toBe("hello");
    expect(entry?.metadata).toEqual({ type: "note" });
  });

  it("skips upsert when hash unchanged", () => {
    store.upsert("a.md", "content", "hash1", "a", {});
    const { changed } = store.upsert("a.md", "content", "hash1", "a", {});
    expect(changed).toBe(false);
  });

  it("updates when hash changes", () => {
    store.upsert("a.md", "old content", "hash1", "a", {});
    const { changed } = store.upsert("a.md", "new content", "hash2", "a", {});
    expect(changed).toBe(true);

    const entry = store.getByPath("a.md");
    expect(entry?.content).toBe("new content");
    expect(entry?.contentHash).toBe("hash2");
  });

  it("searches FTS basic query", () => {
    store.upsert("a.md", "The quick brown fox jumps over the lazy dog", "h1", "a", {});
    store.upsert("b.md", "A completely different document about cats", "h2", "b", {});

    const results = store.searchFTS("fox");
    expect(results.length).toBe(1);
    expect(results[0].path).toBe("a.md");
    expect(results[0].score).toBeGreaterThan(0);
  });

  it("searches FTS multi-word query", () => {
    store.upsert("a.md", "TypeScript is a typed superset of JavaScript", "h1", "a", {});
    store.upsert("b.md", "Python is a dynamic language", "h2", "b", {});

    const results = store.searchFTS("TypeScript JavaScript");
    expect(results.length).toBe(1);
    expect(results[0].path).toBe("a.md");
  });

  it("respects FTS search limit", () => {
    for (let i = 0; i < 5; i++) {
      store.upsert(`n${i}.md`, `Common keyword document ${i}`, `h${i}`, `n${i}`, {});
    }

    const results = store.searchFTS("keyword", 2);
    expect(results.length).toBe(2);
  });

  it("returns empty for empty query", () => {
    store.upsert("a.md", "Some content", "h1", "a", {});
    const results = store.searchFTS("");
    expect(results.length).toBe(0);
  });

  it("returns snippet content", () => {
    store.upsert("a.md", "The quick brown fox jumps over the lazy dog", "h1", "a", {});
    const results = store.searchFTS("fox");
    expect(results[0].snippet).toContain("fox");
  });

  it("returns frontmatter in search results", () => {
    store.upsert("a.md", "Some content about testing", "h1", "a", { type: "note", tags: ["test"] });
    const results = store.searchFTS("testing");
    expect(results[0].frontmatter).toEqual({ type: "note", tags: ["test"] });
  });

  it("deletes by path", () => {
    store.upsert("a.md", "content", "h1", "a", {});
    expect(store.count()).toBe(1);

    const deleted = store.deleteByPath("a.md");
    expect(deleted).toBe(true);
    expect(store.count()).toBe(0);
    expect(store.getByPath("a.md")).toBeUndefined();

    // FTS should also be cleaned
    const results = store.searchFTS("content");
    expect(results.length).toBe(0);
  });

  it("returns false when deleting non-existent path", () => {
    expect(store.deleteByPath("nonexistent.md")).toBe(false);
  });

  it("lists canonical paths", () => {
    store.upsert("a.md", "c1", "h1", "a", {});
    store.upsert("dir/b.md", "c2", "h2", "b", {});

    const paths = store.listCanonicalPaths();
    expect(paths.sort()).toEqual(["a.md", "dir/b.md"]);
  });

  it("counts entries", () => {
    expect(store.count()).toBe(0);
    store.upsert("a.md", "c", "h", "a", {});
    expect(store.count()).toBe(1);
    store.upsert("b.md", "c", "h", "b", {});
    expect(store.count()).toBe(2);
  });

  it("searches by filename", () => {
    store.upsert("projects/weekly-review.md", "Nothing special here", "h1", "weekly-review", {});
    store.upsert("inbox/random.md", "Some other content", "h2", "random", {});

    const results = store.searchFTS("weekly-review");
    expect(results.length).toBe(1);
    expect(results[0].path).toBe("projects/weekly-review.md");
  });

  it("filters by folder", () => {
    store.upsert("inbox/note1.md", "Meeting about project alpha", "h1", "note1", {});
    store.upsert("projects/note2.md", "Meeting about project beta", "h2", "note2", {});
    store.upsert("inbox/note3.md", "Meeting about project gamma", "h3", "note3", {});

    const results = store.searchFTS("meeting", 20, "inbox");
    expect(results.length).toBe(2);
    expect(results.every((r) => r.path.startsWith("inbox/"))).toBe(true);
  });

  it("folder filter returns empty when no matches in folder", () => {
    store.upsert("projects/note.md", "Important meeting notes", "h1", "note", {});

    const results = store.searchFTS("meeting", 20, "inbox");
    expect(results.length).toBe(0);
  });

  it("filters by tags", () => {
    store.upsert("a.md", "Content about dogs", "h1", "a", { tags: ["animals", "pets"] });
    store.upsert("b.md", "Content about cats", "h2", "b", { tags: ["animals"] });
    store.upsert("c.md", "Content about cars", "h3", "c", { tags: ["vehicles"] });

    const results = store.searchFTS("content", 20, undefined, { tags: ["pets"] });
    expect(results.length).toBe(1);
    expect(results[0].path).toBe("a.md");
  });

  it("filters by type", () => {
    store.upsert("a.md", "Content A", "h1", "a", { type: "note" });
    store.upsert("b.md", "Content B", "h2", "b", { type: "capture" });
    store.upsert("c.md", "Content C", "h3", "c", { type: "note" });

    const results = store.searchFTS("content", 20, undefined, { type: "capture" });
    expect(results.length).toBe(1);
    expect(results[0].path).toBe("b.md");
  });

  it("combines tag and type filters", () => {
    store.upsert("a.md", "Content A", "h1", "a", { type: "note", tags: ["work"] });
    store.upsert("b.md", "Content B", "h2", "b", { type: "capture", tags: ["work"] });
    store.upsert("c.md", "Content C", "h3", "c", { type: "note", tags: ["personal"] });

    const results = store.searchFTS("content", 20, undefined, { tags: ["work"], type: "note" });
    expect(results.length).toBe(1);
    expect(results[0].path).toBe("a.md");
  });

  it("filters before limit — returns full count when more matches exist", () => {
    // Insert 10 entries: 5 with type "note", 5 with type "capture", all matching "keyword"
    for (let i = 0; i < 5; i++) {
      store.upsert(`note${i}.md`, `Keyword document ${i}`, `hn${i}`, `note${i}`, { type: "note" });
    }
    for (let i = 0; i < 5; i++) {
      store.upsert(`cap${i}.md`, `Keyword document ${i}`, `hc${i}`, `cap${i}`, { type: "capture" });
    }

    // Ask for limit=3 with type filter — should get 3 results, not fewer
    const results = store.searchFTS("keyword", 3, undefined, { type: "note" });
    expect(results.length).toBe(3);
    expect(results.every((r) => r.frontmatter.type === "note")).toBe(true);
  });

  it("tag filter before limit — returns correct count", () => {
    for (let i = 0; i < 5; i++) {
      store.upsert(`tagged${i}.md`, `Keyword content ${i}`, `ht${i}`, `tagged${i}`, { tags: ["target"] });
    }
    for (let i = 0; i < 5; i++) {
      store.upsert(`other${i}.md`, `Keyword content ${i}`, `ho${i}`, `other${i}`, { tags: ["other"] });
    }

    const results = store.searchFTS("keyword", 3, undefined, { tags: ["target"] });
    expect(results.length).toBe(3);
    expect(results.every((r) => (r.frontmatter.tags as string[]).includes("target"))).toBe(true);
  });

  it("ACL deny-list excludes denied paths before LIMIT", () => {
    // 5 denied (Private/) + 5 allowed (Work/) — all match "secret"
    for (let i = 0; i < 5; i++) {
      store.upsert(`Private/note${i}.md`, `secret document ${i}`, `hp${i}`, `note${i}`, {});
    }
    for (let i = 0; i < 5; i++) {
      store.upsert(`Work/note${i}.md`, `secret document ${i}`, `hw${i}`, `note${i}`, {});
    }

    // With limit=3 and deny=Private, should return 3 Work results, not 0
    const results = store.searchFTS("secret", 3, undefined, undefined, {
      allowPaths: [],
      denyPaths: ["Private"],
    });
    expect(results.length).toBe(3);
    expect(results.every((r) => r.path.startsWith("Work/"))).toBe(true);
  });

  it("ACL allow-list restricts to allowed paths before LIMIT", () => {
    for (let i = 0; i < 5; i++) {
      store.upsert(`Private/note${i}.md`, `important content ${i}`, `hp${i}`, `note${i}`, {});
    }
    for (let i = 0; i < 5; i++) {
      store.upsert(`Work/note${i}.md`, `important content ${i}`, `hw${i}`, `note${i}`, {});
    }

    const results = store.searchFTS("important", 3, undefined, undefined, {
      allowPaths: ["Work"],
      denyPaths: [],
    });
    expect(results.length).toBe(3);
    expect(results.every((r) => r.path.startsWith("Work/"))).toBe(true);
  });

  it("ACL deny-list does not over-block on partial prefix match", () => {
    store.upsert(`WorkExtra/note.md`, `unique term xyz`, `he1`, `note`, {});
    store.upsert(`Work/note.md`, `unique term xyz`, `he2`, `note`, {});

    // Deny "Work" should NOT block "WorkExtra/"
    const results = store.searchFTS("xyz", 20, undefined, undefined, {
      allowPaths: [],
      denyPaths: ["Work"],
    });
    expect(results.some((r) => r.path === "WorkExtra/note.md")).toBe(true);
    expect(results.some((r) => r.path === "Work/note.md")).toBe(false);
  });

  it("ACL deny-list is case-sensitive", () => {
    store.upsert(`Private/note.md`, `sensitive data abc`, `hcs1`, `note`, {});
    store.upsert(`private/note.md`, `sensitive data abc`, `hcs2`, `note`, {});

    // Deny "Private" (capital P) must NOT block "private/" (lowercase)
    const results = store.searchFTS("sensitive", 20, undefined, undefined, {
      allowPaths: [],
      denyPaths: ["Private"],
    });
    expect(results.some((r) => r.path === "Private/note.md")).toBe(false);
    expect(results.some((r) => r.path === "private/note.md")).toBe(true);
  });

  it("ACL deny-list treats GLOB special chars as literals", () => {
    store.upsert(`Projects/[Archive]/note.md`, `glob chars content`, `hgl1`, `note`, {});
    store.upsert(`Projects/Active/note.md`, `glob chars content`, `hgl2`, `note`, {});

    // Deny the literal folder name "Projects/[Archive]" — must not affect "Projects/Active"
    const results = store.searchFTS("glob", 20, undefined, undefined, {
      allowPaths: [],
      denyPaths: ["Projects/[Archive]"],
    });
    expect(results.some((r) => r.path.startsWith("Projects/[Archive]/"))).toBe(false);
    expect(results.some((r) => r.path.startsWith("Projects/Active/"))).toBe(true);
  });

  it("ACL deny-list blocks exact-path match (no trailing slash)", () => {
    store.upsert("Secret.md", "secret content", "hs1", "Secret", {});
    store.upsert("Work/note.md", "work content", "hw1", "note", {});

    const results = store.searchFTS("content", 20, undefined, undefined, {
      allowPaths: [],
      denyPaths: ["Secret.md"],
    });
    expect(results.some((r) => r.path === "Secret.md")).toBe(false);
    expect(results.some((r) => r.path === "Work/note.md")).toBe(true);
  });

  it("ACL allow-list passes exact-path match (no trailing slash)", () => {
    store.upsert("Allowed.md", "allowed content", "ha1", "Allowed", {});
    store.upsert("Blocked.md", "blocked content", "hb1", "Blocked", {});

    const results = store.searchFTS("content", 20, undefined, undefined, {
      allowPaths: ["Allowed.md"],
      denyPaths: [],
    });
    expect(results.some((r) => r.path === "Allowed.md")).toBe(true);
    expect(results.some((r) => r.path === "Blocked.md")).toBe(false);
  });

  it("searches Cyrillic content with Cyrillic query", () => {
    store.upsert("ru.md", "кириллица и Unicode поддержка", "hru1", "ru", {});
    store.upsert("en.md", "Latin alphabet text only", "hen1", "en", {});

    const results = store.searchFTS("кириллица");
    expect(results.length).toBe(1);
    expect(results[0].path).toBe("ru.md");
  });

  it("searches CJK content with CJK query", () => {
    // unicode61 tokenizes on whitespace/punctuation — space-delimited CJK words are
    // indexed as individual tokens and can be searched independently.
    store.upsert("zh.md", "机器学习 笔记 测试", "hzh1", "zh", {});
    store.upsert("en.md", "English only text here", "hen2", "en", {});

    const results = store.searchFTS("笔记");
    expect(results.length).toBe(1);
    expect(results[0].path).toBe("zh.md");
  });

  it("returns schema version", () => {
    expect(store.getSchemaVersion()).toBe(1);
  });

  it("preserves created_at on update", () => {
    store.upsert("a.md", "old", "h1", "a", {});
    const first = store.getByPath("a.md");

    // Small delay to ensure different timestamp
    const before = first?.createdAt;
    store.upsert("a.md", "new", "h2", "a", {});
    const second = store.getByPath("a.md");

    expect(second?.createdAt).toBe(before);
    expect(second?.updatedAt).toBeGreaterThanOrEqual(before);
  });
});

describe("VaultSearchStore — hybrid search", () => {
  let store: VaultSearchStore;
  let embDb: Database.Database;
  let embStore: EmbeddingStore;

  beforeEach(() => {
    store = new VaultSearchStore(":memory:");
    embDb = new Database(":memory:");
    embDb.pragma("journal_mode = WAL");
    embStore = new EmbeddingStore(embDb);
    embStore.initSchema();

    // Populate search store
    store.upsert("a.md", "Machine learning and neural networks", "h1", "a", { type: "note" });
    store.upsert("b.md", "Deep learning with transformers", "h2", "b", { type: "note" });
    store.upsert("c.md", "Cooking recipes and kitchen tips", "h3", "c", { type: "note" });
  });

  afterEach(() => {
    store.close();
    embDb.close();
  });

  it("fuses FTS and vector scores correctly", () => {
    // c.md has highest cosine sim but no FTS match for "cooking"
    // a.md has moderate cosine and FTS match
    embStore.upsert("a.md", new Float32Array([0.5, 0.5, 0]), "h1", "m");
    embStore.upsert("b.md", new Float32Array([0, 0, 1]), "h2", "m");
    embStore.upsert("c.md", new Float32Array([1, 0, 0]), "h3", "m");

    const queryEmbed = new Float32Array([1, 0, 0]);
    // alpha=0.5 blends FTS and vector equally
    const results = store.searchHybrid("cooking", queryEmbed, embStore, 0.5, 10);

    expect(results.length).toBeGreaterThan(0);
    // c.md has both FTS match ("cooking recipes") AND cosine=1.0, should be first
    expect(results[0].path).toBe("c.md");
    // All 3 should appear: c.md from both, a.md/b.md from vector
    expect(results.length).toBe(3);
  });

  it("falls back to FTS-only when no embeddings exist", () => {
    const queryEmbed = new Float32Array([1, 0, 0]);
    const results = store.searchHybrid("machine learning", queryEmbed, embStore, 0.5, 10);

    // Should still return FTS results
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].path).toBe("a.md");
  });

  it("respects folder filter in hybrid search", () => {
    store.upsert("inbox/d.md", "Machine learning intro", "h4", "d", {});
    embStore.upsert("a.md", new Float32Array([1, 0, 0]), "h1", "m");
    embStore.upsert("inbox/d.md", new Float32Array([0.95, 0.05, 0]), "h4", "m");

    const queryEmbed = new Float32Array([1, 0, 0]);
    const results = store.searchHybrid("machine", queryEmbed, embStore, 0.5, 10, "inbox");

    expect(results.every((r) => r.path.startsWith("inbox/"))).toBe(true);
  });

  it("getContentHashMap returns correct entries", () => {
    const map = store.getContentHashMap();
    expect(map.size).toBe(3);
    expect(map.get("a.md")).toBe("h1");
    expect(map.get("b.md")).toBe("h2");
    expect(map.get("c.md")).toBe("h3");
  });

  it("single FTS result gets non-zero BM25 weight in hybrid mode", () => {
    // Only c.md matches "cooking", but vector favors a.md
    embStore.upsert("a.md", new Float32Array([1, 0, 0]), "h1", "m");
    embStore.upsert("c.md", new Float32Array([0, 0, 1]), "h3", "m");

    const queryEmbed = new Float32Array([1, 0, 0]);
    // alpha=0.7 (FTS-heavy): the single FTS match should get BM25 normalized to 1.0
    const results = store.searchHybrid("cooking", queryEmbed, embStore, 0.7, 10);

    // c.md has FTS match (normalized=1.0) + low cosine, a.md has no FTS + high cosine
    // c.md score: 0.7*1.0 + 0.3*0.0 = 0.7
    // a.md score: 0.7*0.0 + 0.3*1.0 = 0.3
    // c.md should win
    expect(results[0].path).toBe("c.md");
    expect(results[0].score).toBeGreaterThan(0);
  });
});

describe("sanitizeFTS5Query", () => {
  it("quotes individual terms", () => {
    expect(sanitizeFTS5Query("hello world")).toBe('"hello" "world"');
  });

  it("preserves quoted phrases for phrase search", () => {
    expect(sanitizeFTS5Query('say "hello world"')).toBe('"say" "hello world"');
  });

  it("escapes double quotes inside terms", () => {
    expect(sanitizeFTS5Query('say he"llo')).toBe('"say" "he""llo"');
  });

  it("handles empty string", () => {
    expect(sanitizeFTS5Query("")).toBe("");
  });

  it("handles whitespace-only string", () => {
    expect(sanitizeFTS5Query("   ")).toBe("");
  });

  it("handles empty quoted phrase", () => {
    expect(sanitizeFTS5Query('"" hello')).toBe('"hello"');
  });

  it("quotes Cyrillic terms", () => {
    expect(sanitizeFTS5Query("обучение нейросеть")).toBe('"обучение" "нейросеть"');
  });

  it("quotes CJK terms as a single token", () => {
    expect(sanitizeFTS5Query("机器学习")).toBe('"机器学习"');
  });
});
