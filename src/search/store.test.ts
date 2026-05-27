import type { Statement } from "bun:sqlite";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { logger } from "../utils/logger.js";
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

  it("warns when SQLite rejects WAL journal mode for a non-memory path [PERF-02]", () => {
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    // Force the WAL pragma to report "memory" regardless of SQLite version —
    // some CI environments (newer SQLite on Linux) accept WAL for shared-memory
    // URIs and would return "wal", making the warn never fire. We mock the
    // pragma result so the test is deterministic across environments.
    // Save the original before spyOn replaces it — Bun v1.3 doesn't expose .original.
    const origPrepare = Database.prototype.prepare;
    const prepareSpy = spyOn(Database.prototype, "prepare").mockImplementation(function (this: Database, sql: string) {
      if (sql.includes("journal_mode = WAL")) {
        return { get: () => ({ journal_mode: "memory" }) } as unknown as Statement;
      }
      return origPrepare.call(this, sql);
    });
    let uriStore: VaultSearchStore | undefined;
    try {
      uriStore = new VaultSearchStore("file::memory:?cache=shared");
      expect(warnSpy).toHaveBeenCalledWith("sqlite-shim", "WAL journal mode was not enabled", {
        dbPath: "file::memory:?cache=shared",
        journalMode: "memory",
      });
    } finally {
      uriStore?.close();
      prepareSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it("logs a warning when the WAL pragma itself is rejected [ERR-10]", () => {
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    const prepareSpy = spyOn(Database.prototype, "prepare").mockImplementation(function (this: Database, sql: string) {
      if (sql === "PRAGMA journal_mode = WAL") {
        throw new Error("readonly database");
      }
      return prepareSpy.original.call(this, sql);
    });

    try {
      expect(() => new VaultSearchStore("/tmp/rejected-wal.db")).toThrow("readonly database");
      expect(warnSpy).toHaveBeenCalledWith("sqlite-shim", "WAL journal mode pragma failed", {
        dbPath: "/tmp/rejected-wal.db",
        err: "readonly database",
      });
    } finally {
      prepareSpy.mockRestore();
      warnSpy.mockRestore();
    }
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

  it("retrieves content for multiple paths in one call", () => {
    store.upsert("notes/a.md", "Alpha", "h1", "a", {});
    store.upsert("notes/b.md", "Beta", "h2", "b", {});

    const contents = store.getContentBatchByPaths(["notes/a.md", "notes/b.md", "missing.md"]);
    expect(contents.get("notes/a.md")).toBe("Alpha");
    expect(contents.get("notes/b.md")).toBe("Beta");
    expect(contents.has("missing.md")).toBe(false);
  });

  it("chunks oversized path lookups to stay under SQLite variable limits", () => {
    store.upsert("notes/a.md", "Alpha", "h1", "a", {});
    store.upsert("notes/b.md", "Beta", "h2", "b", {});
    const paths = Array.from({ length: 40_000 }, (_, i) => `missing-${i}.md`);
    paths[123] = "notes/a.md";
    paths[30_123] = "notes/b.md";

    const entries = store.getBatchByPaths(paths);
    const contents = store.getContentBatchByPaths(paths);

    expect(entries.get("notes/a.md")?.content).toBe("Alpha");
    expect(entries.get("notes/b.md")?.content).toBe("Beta");
    expect(contents.get("notes/a.md")).toBe("Alpha");
    expect(contents.get("notes/b.md")).toBe("Beta");
  });

  it("builds a cached path index and extends it in-place on new inserts", () => {
    store.upsert("notes/Alpha.md", "Alpha", "h1", "Alpha", {});

    const first = store.getPathIndex();
    expect(first.get("Alpha")).toBe("notes/Alpha.md");
    expect(first.get("notes/Alpha")).toBe("notes/Alpha.md");

    store.upsert("notes/Beta.md", "Beta", "h2", "Beta", {});
    const second = store.getPathIndex();
    expect(second).toBe(first);
    expect(second.get("Beta")).toBe("notes/Beta.md");
  });

  it("updates pathIndexCache in-place on new-path insert instead of clearing it [PERF-05]", () => {
    store.upsert("notes/Alpha.md", "Alpha", "h1", "Alpha", {});
    const cache = store.getPathIndex(); // populate cache

    store.upsert("notes/Beta.md", "Beta", "h2", "Beta", {}); // brand-new path

    // Same Map reference — not rebuilt
    expect(store.getPathIndex()).toBe(cache);
    // New path entries are present in the same cache object
    expect(cache.get("Beta")).toBe("notes/Beta.md");
    expect(cache.get("notes/Beta")).toBe("notes/Beta.md");
    expect(cache.get("notes/Beta.md")).toBe("notes/Beta.md");
  });

  it("keeps the cached path index when only existing path content changes", () => {
    store.upsert("notes/Alpha.md", "Alpha", "h1", "Alpha", {});

    const first = store.getPathIndex();
    store.upsert("notes/Alpha.md", "Updated Alpha", "h2", "Alpha", {});

    expect(store.getPathIndex()).toBe(first);
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

  it("logs SQLite error codes when an upsert transaction fails [ERR-09]", () => {
    const errorSpy = spyOn(logger, "error").mockImplementation(() => {});
    const sqliteErr = Object.assign(new Error("constraint failed"), { code: "SQLITE_CONSTRAINT" });
    const insertSpy = spyOn((store as unknown as { stmtInsertFts: Statement }).stmtInsertFts, "run").mockImplementation(
      () => {
        throw sqliteErr;
      },
    );

    try {
      expect(() => store.upsert("a.md", "content", "hash1", "a", {})).toThrow("constraint failed");
      expect(errorSpy).toHaveBeenCalledWith("store", "upsert transaction failed", {
        path: "a.md",
        code: "SQLITE_CONSTRAINT",
        err: "constraint failed",
      });
    } finally {
      insertSpy.mockRestore();
      errorSpy.mockRestore();
    }
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

  it("paginates tags in SQL with a total count", () => {
    store.upsert("a.md", "content", "h1", "a", { tags: ["alpha", "beta"] });
    store.upsert("b.md", "content", "h2", "b", { tags: ["alpha", "gamma"] });

    const page = store.listTagsPage(1, 1);
    expect(page.total).toBe(3);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.tag).toBeTruthy();
  });

  it("bounds dynamic statement cache size", () => {
    store.upsert("a.md", "content", "h1", "a", {});

    for (let i = 1; i <= 300; i++) {
      store.count({ allowPaths: Array.from({ length: i }, (_, n) => `folder-${n}`), denyPaths: [] });
    }

    expect(store.getStatementCacheSize()).toBeLessThanOrEqual(256);
  });

  it("file-backed backup yields to the event loop before completion [PERF-01]", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-search-backup-"));
    const dbPath = path.join(dir, "search.db");
    const destPath = path.join(dir, "backup.db");
    const fileStore = new VaultSearchStore(dbPath);
    try {
      fileStore.upsert("a.md", "content", "h1", "a", {});

      const backup = fileStore.backup(destPath);
      const first = await Promise.race([
        backup.then(() => "backup" as const),
        new Promise<"tick">((resolve) => setTimeout(() => resolve("tick"), 0)),
      ]);

      expect(first).toBe("tick");
      await backup;
      expect(fs.existsSync(destPath)).toBe(true);
    } finally {
      fileStore.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("logs backup failure with the destination path [ERR-01]", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-search-backup-fail-"));
    const dbPath = path.join(dir, "search.db");
    const destPath = path.join(dir, "missing", "backup.db");
    const errorSpy = spyOn(logger, "error").mockImplementation(() => {});
    const fileStore = new VaultSearchStore(dbPath);
    try {
      fileStore.upsert("a.md", "content", "h1", "a", {});

      await expect(fileStore.backup(destPath)).rejects.toThrow();
      expect(errorSpy).toHaveBeenCalledWith(
        "sqlite-shim",
        "backup failed",
        expect.objectContaining({ destPath, err: expect.any(String) }),
      );
    } finally {
      fileStore.close();
      mock.restore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates a backup database that can be opened and queried [QA-02]", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-search-backup-integrity-"));
    const dbPath = path.join(dir, "search.db");
    const destPath = path.join(dir, "backup.db");
    const fileStore = new VaultSearchStore(dbPath);
    try {
      fileStore.upsert("notes/a.md", "Alpha backup content", "h1", "a", { tags: ["backup"] });

      await fileStore.backup(destPath);

      const backupDb = new Database(destPath, { readonly: true });
      try {
        const row = backupDb
          .query("SELECT canonical_path, content, metadata FROM vault_entries WHERE canonical_path = ?")
          .get("notes/a.md") as { canonical_path: string; content: string; metadata: string } | null;
        expect(row).toEqual({
          canonical_path: "notes/a.md",
          content: "Alpha backup content",
          metadata: JSON.stringify({ tags: ["backup"] }),
        });
      } finally {
        backupDb.close();
      }
    } finally {
      fileStore.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reuses cached statement for in-memory backup — no ephemeral prepare call [ERR-14]", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-erp14-"));
    const destPath = path.join(dir, "backup.db");
    const memStore = new VaultSearchStore(":memory:");
    const prepareSpy = spyOn(Database.prototype, "prepare");
    try {
      prepareSpy.mockClear();
      memStore.upsert("a.md", "content", "h1", "a", {});
      memStore.backup(destPath);
      expect(prepareSpy).not.toHaveBeenCalled();
    } finally {
      prepareSpy.mockRestore();
      memStore.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("backs up file-backed database when dest path contains a single quote [QA-07]", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-search-quote-"));
    const dbPath = path.join(dir, "search.db");
    // Path with a single quote in the directory name
    const quoteDir = path.join(dir, "it's a backup");
    fs.mkdirSync(quoteDir);
    const destPath = path.join(quoteDir, "backup.db");
    const fileStore = new VaultSearchStore(dbPath);
    try {
      fileStore.upsert("a.md", "content", "h1", "a", {});
      await fileStore.backup(destPath);
      expect(fs.existsSync(destPath)).toBe(true);
    } finally {
      fileStore.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("enables WAL journal mode on a real file-backed store [QA-08]", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-search-wal-"));
    const dbPath = path.join(dir, "search.db");
    const fileStore = new VaultSearchStore(dbPath);
    try {
      const checkDb = new Database(dbPath, { readonly: true });
      try {
        const row = checkDb.query("PRAGMA journal_mode").get() as { journal_mode: string };
        expect(row.journal_mode).toBe("wal");
      } finally {
        checkDb.close();
      }
    } finally {
      fileStore.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pages stale embeddings directly from SQL and removes orphans", () => {
    store.upsert("a.md", "Alpha", "hash-a", "a", {});
    store.upsert("b.md", "Beta", "hash-b", "b", {});
    store.upsert("c.md", "Gamma", "hash-c", "c", {});

    const embeddings = store.createEmbeddingStore();
    embeddings.initSchema();
    embeddings.upsert("a.md", new Float32Array([1, 0]), "hash-a", "model-a");
    embeddings.upsert("b.md", new Float32Array([0, 1]), "old-hash", "model-a");
    embeddings.upsert("orphan.md", new Float32Array([1, 1]), "hash-o", "model-a");

    expect(embeddings.deleteOrphansFromVaultEntries()).toBe(1);
    const stale = embeddings.getStaleOrMissingPage(1, "model-a");
    const stalePage = embeddings.getStaleOrMissingPageWithTotal(1, "model-a");
    expect(stale).toHaveLength(1);
    expect(stalePage.rows).toEqual(stale);
    expect(stalePage.total).toBe(2);
    expect(embeddings.countStaleOrMissing("model-a")).toBe(2);
    expect(stale[0]?.path).toBe("b.md");
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

  it("applies non-empty allow-list ACL clauses even when another allow path normalizes empty", () => {
    store.upsert("allowed/a.md", "content", "h1", "a", {});
    store.upsert("blocked/b.md", "content", "h2", "b", {});

    expect(store.listCanonicalPaths({ allowPaths: ["", "allowed"], denyPaths: [] })).toEqual(["allowed/a.md"]);
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
    // Schema version is now at 2 (initial schema + date indexes migration)
    expect(store.getSchemaVersion()).toBe(2);
  });

  it("reuses the prepared schema version statement across repeated calls [PERF-04]", () => {
    const dbPath = path.join(os.tmpdir(), `vault-schema-version-${Date.now()}.db`);
    const prepareSpy = spyOn(Database.prototype, "prepare");
    const localStore = new VaultSearchStore(dbPath);
    try {
      const preparesBeforeReads = prepareSpy.mock.calls.filter(
        ([sql]) => sql === "SELECT version FROM schema_version WHERE id = 1",
      ).length;
      expect(localStore.getSchemaVersion()).toBe(2);
      expect(localStore.getSchemaVersion()).toBe(2);

      const matchingPreparesAfterReads = prepareSpy.mock.calls.filter(
        ([sql]) => sql === "SELECT version FROM schema_version WHERE id = 1",
      ).length;
      expect(matchingPreparesAfterReads - preparesBeforeReads).toBe(0);
    } finally {
      localStore.close();
      prepareSpy.mockRestore();
      fs.rmSync(dbPath, { force: true });
    }
  });

  it("does not mask non-schema SQLite failures when reading schema version [ERR-08]", () => {
    const getSpy = spyOn(
      (store as unknown as { stmtGetSchemaVersion: { get(): unknown } }).stmtGetSchemaVersion,
      "get",
    ).mockImplementation(() => {
      throw new Error("disk I/O error");
    });
    expect(() => store.getSchemaVersion()).toThrow();
    getSpy.mockRestore();
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

  it("reuses transaction wrappers across repeated upserts and deletes [PERF-06]", () => {
    const dbPath = path.join(os.tmpdir(), `vault-transaction-cache-${Date.now()}.db`);
    const transactionSpy = spyOn(Database.prototype, "transaction");
    const localStore = new VaultSearchStore(dbPath);
    try {
      const transactionsBeforeOps = transactionSpy.mock.calls.length;

      localStore.upsert("a.md", "content-a", "h1", "a", {});
      localStore.upsert("b.md", "content-b", "h2", "b", {});
      localStore.deleteByPath("a.md");
      localStore.deleteByPath("b.md");

      expect(transactionSpy.mock.calls.length - transactionsBeforeOps).toBe(0);
    } finally {
      localStore.close();
      transactionSpy.mockRestore();
      fs.rmSync(dbPath, { force: true });
    }
  });
});

describe("VaultSearchStore — hybrid search", () => {
  let store: VaultSearchStore;
  let embDb: Database.Database;
  let embStore: EmbeddingStore;

  beforeEach(() => {
    store = new VaultSearchStore(":memory:");
    embDb = new Database(":memory:");
    embDb.exec("PRAGMA journal_mode = WAL;");
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

  it("filters vector candidates through ACL before hybrid scoring", () => {
    store.upsert("public/d.md", "Semantic-only allowed note", "h4", "d", {});
    store.upsert("secret/e.md", "Semantic-only denied note", "h5", "e", {});
    embStore.upsert("secret/e.md", new Float32Array([1, 0, 0]), "h5", "m");
    embStore.upsert("public/d.md", new Float32Array([0.9, 0.1, 0]), "h4", "m");

    const queryEmbed = new Float32Array([1, 0, 0]);
    const results = store.searchHybrid("no-ft-match", queryEmbed, embStore, 0.5, 10, undefined, {
      allowPaths: [],
      denyPaths: ["secret"],
    });

    expect(results.map((r) => r.path)).toContain("public/d.md");
    expect(results.map((r) => r.path)).not.toContain("secret/e.md");
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

  it("passes limit * candidateMultiplier as the FTS candidate pool size [API-11]", () => {
    const ftsSpy = spyOn(store, "searchFTS").mockReturnValue([]);
    try {
      embStore.upsert("a.md", new Float32Array([1, 0, 0]), "h1", "m");
      const queryEmbed = new Float32Array([1, 0, 0]);

      store.searchHybrid("query", queryEmbed, embStore, 0.5, 5, undefined, undefined, 3);

      // First positional argument to searchFTS after the query string is the limit.
      // With candidateMultiplier=3 and limit=5, it should be 5*3=15
      expect(ftsSpy).toHaveBeenCalledWith("query", 15, undefined, undefined, undefined);
    } finally {
      ftsSpy.mockRestore();
    }
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
