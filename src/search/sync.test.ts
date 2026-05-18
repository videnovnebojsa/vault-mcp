import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { logger } from "../utils/logger.js";
import { VaultSearchStore } from "./store.js";
import { collectMarkdownFiles, md5, toCanonicalPath, VaultSync } from "./sync.js";

describe("VaultSync", () => {
  let tmpDir: string;
  let store: VaultSearchStore;
  let sync: VaultSync;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vaultsync-"));
    store = new VaultSearchStore(":memory:");
    sync = new VaultSync({ vaultPath: tmpDir, store });
  });

  afterEach(async () => {
    store.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function writeFile(relPath: string, content: string) {
    const abs = path.join(tmpDir, relPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf-8");
  }

  it("syncs empty vault", async () => {
    const result = await sync.runFullSync();
    expect(result.scanned).toBe(0);
    expect(result.upserted).toBe(0);
    expect(result.deletedStale).toBe(0);
  });

  it("accepts a minimal sync store implementation", () => {
    const minimalStore = {
      upsert: mock().mockReturnValue({ changed: false }),
      listCanonicalPaths: mock().mockReturnValue([]),
      deleteByPath: mock().mockReturnValue(false),
    };

    const syncWithMinimalStore = new VaultSync({ vaultPath: tmpDir, store: minimalStore });

    expect(syncWithMinimalStore.isSyncing()).toBe(false);
  });

  it("syncs vault with markdown files", async () => {
    await writeFile("note1.md", "# Hello\nWorld");
    await writeFile("sub/note2.md", "Second note");

    const result = await sync.runFullSync();
    expect(result.scanned).toBe(2);
    expect(result.upserted).toBe(2);
    expect(store.count()).toBe(2);
  });

  it("skips hidden directories", async () => {
    await writeFile("visible.md", "Visible");
    await writeFile(".obsidian/config.md", "Hidden config");

    const result = await sync.runFullSync();
    expect(result.scanned).toBe(1);
    expect(result.upserted).toBe(1);
  });

  it("skips non-markdown files", async () => {
    await writeFile("note.md", "A markdown note");
    await writeFile("image.png", "not-actually-png");
    await writeFile("data.json", '{"key":"value"}');

    const result = await sync.runFullSync();
    expect(result.scanned).toBe(1);
  });

  it("is idempotent on second sync", async () => {
    await writeFile("note.md", "Content");

    const first = await sync.runFullSync();
    expect(first.upserted).toBe(1);

    const second = await sync.runFullSync();
    expect(second.scanned).toBe(1);
    expect(second.upserted).toBe(0);
    expect(second.skippedUnchanged).toBe(1);
  });

  it("detects modified files", async () => {
    await writeFile("note.md", "Original");
    await sync.runFullSync();

    // Modify with a small delay to ensure different mtime
    await new Promise((r) => setTimeout(r, 50));
    await writeFile("note.md", "Modified");

    const result = await sync.runFullSync();
    expect(result.upserted).toBe(1);

    const entry = store.getByPath("note.md");
    expect(entry?.content).toBe("Modified");
  });

  it("deletes stale entries", async () => {
    await writeFile("keep.md", "Keep");
    await writeFile("remove.md", "Remove");
    await sync.runFullSync();
    expect(store.count()).toBe(2);

    await fs.unlink(path.join(tmpDir, "remove.md"));
    const result = await sync.runFullSync();
    expect(result.deletedStale).toBe(1);
    expect(store.count()).toBe(1);
  });

  it("handleUpsert indexes a single file", async () => {
    await writeFile("new.md", "---\ntype: note\n---\nNew content");
    await sync.handleUpsert("new.md");

    const entry = store.getByPath("new.md");
    expect(entry).toBeDefined();
    expect(entry?.content).toContain("New content");
    expect(entry?.metadata).toEqual({ type: "note" });
  });

  it("stores parsed note body without YAML frontmatter", async () => {
    await writeFile("parsed.md", "---\ntype: note\ntags:\n  - search\n---\n# Searchable body");

    await sync.handleUpsert("parsed.md");

    const entry = store.getByPath("parsed.md");
    expect(entry?.content).toBe("# Searchable body");
    expect(entry?.metadata).toEqual({ type: "note", tags: ["search"] });
  });

  it("handleDelete removes from index", async () => {
    await writeFile("del.md", "To delete");
    await sync.handleUpsert("del.md");
    expect(store.count()).toBe(1);

    const removed = sync.handleDelete("del.md");
    expect(removed).toBe(true);
    expect(store.count()).toBe(0);
  });

  it("concurrent syncs coalesce — both callers get the real result", async () => {
    await writeFile("note.md", "Content");

    // Both calls are in-flight at the same time; the coalescing gate ensures a single
    // underlying _doFullSync() runs and both promises resolve with the real stats.
    const [r1, r2] = await Promise.all([sync.runFullSync(), sync.runFullSync()]);

    // Both should report the same real sync — no silent no-op early return.
    expect(r1.scanned).toBe(1);
    expect(r2.scanned).toBe(1);
    expect(r1).toStrictEqual(r2);
  });

  it("handleRename moves entry", async () => {
    await writeFile("old.md", "Content");
    await sync.handleUpsert("old.md");

    // Simulate rename
    await fs.rename(path.join(tmpDir, "old.md"), path.join(tmpDir, "new.md"));
    await sync.handleRename("old.md", "new.md");

    expect(store.getByPath("old.md")).toBeUndefined();
    expect(store.getByPath("new.md")).toBeDefined();
  });
});

describe("helpers", () => {
  it("md5 produces hex string", () => {
    const hash = md5("hello");
    expect(hash).toMatch(/^[a-f0-9]{32}$/);
  });

  it("toCanonicalPath normalizes backslashes", () => {
    expect(toCanonicalPath("dir\\sub\\file.md")).toBe("dir/sub/file.md");
  });

  it("collectMarkdownFiles walks recursively", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "collect-"));
    try {
      await fs.mkdir(path.join(tmpDir, "sub"), { recursive: true });
      await fs.writeFile(path.join(tmpDir, "a.md"), "a");
      await fs.writeFile(path.join(tmpDir, "sub", "b.md"), "b");
      await fs.writeFile(path.join(tmpDir, "c.txt"), "c");

      const files = await collectMarkdownFiles(tmpDir);
      const names = files.map((f) => path.basename(f.path));
      expect(names.sort()).toEqual(["a.md", "b.md"]);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("collectMarkdownFiles logs stat failures instead of silently skipping markdown files [ERR-06]", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "collect-stat-fail-"));
    const goodPath = path.join(tmpDir, "good.md");
    const badPath = path.join(tmpDir, "bad.md");
    const realStat = fs.stat;
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    spyOn(fs, "stat").mockImplementation((target: Parameters<typeof fs.stat>[0]) => {
      if (target === badPath) return Promise.reject(new Error("stat denied"));
      return realStat(target);
    });

    try {
      await fs.writeFile(goodPath, "good");
      await fs.writeFile(badPath, "bad");

      const files = await collectMarkdownFiles(tmpDir);

      expect(files.map((file) => path.basename(file.path))).toEqual(["good.md"]);
      expect(warnSpy).toHaveBeenCalledWith("sync", "skipping unstatable markdown file", {
        path: badPath,
        err: "stat denied",
      });
    } finally {
      mock.restore();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
