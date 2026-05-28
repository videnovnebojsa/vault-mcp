import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AclViolationError, PathTraversalError } from "./path-safety.js";
import { VaultRepository } from "./repository.js";

describe("VaultRepository", () => {
  let tmpDir: string;
  let repo: VaultRepository;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vault-test-"));
    repo = new VaultRepository({ vaultPath: tmpDir });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe("writeNote + readNote roundtrip", () => {
    it("writes and reads a note with frontmatter", async () => {
      const result = await repo.writeNote("00_Inbox/test-note", {
        content: "# Hello\n\nThis is a test.",
        frontmatter: { type: "capture", tags: ["test"] },
      });

      expect(result.ok).toBe(true);
      expect(result.path).toBe("00_Inbox/test-note.md");
      expect(result.note).toBeDefined();
      expect(result.note?.frontmatter.type).toBe("capture");

      const note = await repo.readNote("00_Inbox/test-note");
      expect(note.content).toContain("# Hello");
      expect(note.frontmatter.type).toBe("capture");
      expect(note.frontmatter.tags).toEqual(["test"]);
      expect(note.name).toBe("test-note.md");
    });

    it("creates parent directories automatically", async () => {
      const result = await repo.writeNote("deeply/nested/dir/note", {
        content: "Deep note",
      });

      expect(result.ok).toBe(true);
      const note = await repo.readNote("deeply/nested/dir/note");
      expect(note.content).toBe("Deep note");
    });

    it("preserves trailing whitespace in content", async () => {
      const content = "# Hello\n\nTrailing newline\n";
      await repo.writeNote("ws-note", {
        content,
        frontmatter: { type: "capture" },
      });

      const note = await repo.readNote("ws-note");
      expect(note.content).toContain("Trailing newline\n");
    });

    it("round-trips Cyrillic content without corruption", async () => {
      const content = "# Привет мир\n\nЭто тестовая заметка на русском языке.\n";
      const result = await repo.writeNote("unicode/cyrillic-note", {
        content,
        frontmatter: { type: "capture", tags: ["кириллица"] },
      });

      expect(result.ok).toBe(true);
      const note = await repo.readNote("unicode/cyrillic-note");
      expect(note.content).toBe(content);
      expect(note.frontmatter.tags).toEqual(["кириллица"]);
    });

    it("round-trips CJK content without corruption", async () => {
      const content = "# 你好世界\n\n这是一个中文测试笔记。\n";
      const result = await repo.writeNote("unicode/cjk-note", {
        content,
        frontmatter: { type: "capture", tags: ["中文"] },
      });

      expect(result.ok).toBe(true);
      const note = await repo.readNote("unicode/cjk-note");
      expect(note.content).toBe(content);
      expect(note.frontmatter.tags).toEqual(["中文"]);
    });
  });

  describe("updateProperties preserves content", () => {
    it("does not strip whitespace during property update", async () => {
      const content = "# Note\n\nContent with trailing newline\n";
      await repo.writeNote("preserve-note", {
        content,
        frontmatter: { type: "capture" },
      });

      await repo.updateProperties("preserve-note", { status: "processed" });

      const note = await repo.readNote("preserve-note");
      expect(note.content).toContain("trailing newline\n");
      expect(note.frontmatter.status).toBe("processed");
    });
  });

  describe("writeNote validation", () => {
    it("rejects invalid frontmatter", async () => {
      const result = await repo.writeNote("bad-note", {
        content: "Content",
        frontmatter: { confidence: 1.5 },
      });

      expect(result.ok).toBe(false);
      expect(result.message).toContain("validation failed");
    });
  });

  describe("updateProperties", () => {
    it("merges properties into existing frontmatter", async () => {
      await repo.writeNote("note", {
        content: "Content",
        frontmatter: { type: "capture", status: "unprocessed" },
      });

      const result = await repo.updateProperties("note", {
        status: "processed",
        category: "person",
      });

      expect(result.ok).toBe(true);
      expect(result.note?.frontmatter.type).toBe("capture");
      expect(result.note?.frontmatter.status).toBe("processed");
      expect(result.note?.frontmatter.category).toBe("person");
    });
  });

  describe("path traversal", () => {
    it("blocks reading outside vault", async () => {
      await expect(repo.readNote("../../etc/passwd")).rejects.toThrow(PathTraversalError);
    });

    it("blocks writing outside vault", async () => {
      await expect(repo.writeNote("../../etc/evil", { content: "pwned" })).rejects.toThrow(PathTraversalError);
    });

    describe("symlink escape", () => {
      let outsideDir: string;

      beforeEach(async () => {
        outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "outside-"));
      });

      afterEach(async () => {
        await fs.rm(outsideDir, { recursive: true, force: true });
      });

      it("blocks symlink escape on read", async () => {
        await fs.writeFile(path.join(outsideDir, "secret.md"), "secret data");
        await fs.symlink(outsideDir, path.join(tmpDir, "escape-link"));

        await expect(repo.readNote("escape-link/secret")).rejects.toThrow(PathTraversalError);
      });

      it("blocks symlink escape on write", async () => {
        await fs.symlink(outsideDir, path.join(tmpDir, "escape-link"));

        await expect(repo.writeNote("escape-link/evil", { content: "pwned" })).rejects.toThrow(PathTraversalError);
      });
    });
  });

  describe("listFolder", () => {
    beforeEach(async () => {
      await repo.writeNote("folder/note1", { content: "Note 1" });
      await repo.writeNote("folder/note2", { content: "Note 2" });
      await repo.writeNote("folder/sub/note3", { content: "Note 3" });
      // Create a hidden file
      await fs.writeFile(path.join(tmpDir, "folder", ".hidden.md"), "hidden");
    });

    it("lists files recursively", async () => {
      const results = await repo.listFolder("folder");
      expect(results.length).toBe(3);
    });

    it("respects limit", async () => {
      const results = await repo.listFolder("folder", { limit: 2 });
      expect(results.length).toBe(2);
    });

    it("excludes hidden files", async () => {
      const results = await repo.listFolder("folder");
      const names = results.map((r) => r.name);
      expect(names).not.toContain(".hidden.md");
    });

    it("lists non-recursively", async () => {
      const results = await repo.listFolder("folder", { recursive: false });
      expect(results.length).toBe(2); // note1 and note2, not sub/note3
    });

    it("applies modifiedAfter before offset in deterministic path order", async () => {
      await fs.mkdir(path.join(tmpDir, "paged", "a"), { recursive: true });
      await fs.writeFile(path.join(tmpDir, "paged", "a.md"), "Root A");
      await fs.writeFile(path.join(tmpDir, "paged", "a", "deep.md"), "Deep A");
      await fs.writeFile(path.join(tmpDir, "paged", "b.md"), "Root B");
      await fs.writeFile(path.join(tmpDir, "paged", "old.md"), "Old");

      const oldTime = new Date("2020-01-01T00:00:00.000Z");
      const freshTime = new Date("2020-01-02T00:00:00.000Z");
      await fs.utimes(path.join(tmpDir, "paged", "a.md"), freshTime, freshTime);
      await fs.utimes(path.join(tmpDir, "paged", "a", "deep.md"), freshTime, freshTime);
      await fs.utimes(path.join(tmpDir, "paged", "b.md"), freshTime, freshTime);
      await fs.utimes(path.join(tmpDir, "paged", "old.md"), oldTime, oldTime);

      const page = await repo.listFolderPage("paged", {
        limit: 1,
        offset: 1,
        modifiedAfter: new Date("2020-01-01T12:00:00.000Z").getTime(),
      });

      expect(page.total).toBe(3);
      expect(page.items.map((item) => item.path)).toEqual(["paged/a/deep.md"]);
    });

    it("reads note summaries in a page concurrently [PERF-01]", async () => {
      await repo.writeNote("parallel/a", { content: "A" });
      await repo.writeNote("parallel/b", { content: "B" });
      await repo.writeNote("parallel/c", { content: "C" });

      const realReadFile = fs.readFile;
      let activeReads = 0;
      let maxActiveReads = 0;
      const readFileSpy = spyOn(fs, "readFile").mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
        const target = String(args[0]);
        if (!target.includes(`${path.sep}parallel${path.sep}`) || !target.endsWith(".md")) {
          return realReadFile(...args);
        }
        activeReads++;
        maxActiveReads = Math.max(maxActiveReads, activeReads);
        await Bun.sleep(20);
        try {
          return await realReadFile(...args);
        } finally {
          activeReads--;
        }
      });

      try {
        await repo.listFolderPage("parallel", { limit: 3 });
      } finally {
        readFileSpy.mockRestore();
      }

      expect(maxActiveReads).toBeGreaterThan(1);
    });

    it("recurses into subdirectories concurrently [PERF-02]", async () => {
      await repo.writeNote("recursive/a/one", { content: "A" });
      await repo.writeNote("recursive/b/two", { content: "B" });

      const realReadDir = fs.readdir;
      let activeNestedReads = 0;
      let maxActiveNestedReads = 0;
      const readDirSpy = spyOn(fs, "readdir").mockImplementation(async (...args: Parameters<typeof fs.readdir>) => {
        const target = String(args[0]);
        const isNested = target.includes(`${path.sep}recursive${path.sep}`);
        if (isNested) {
          activeNestedReads++;
          maxActiveNestedReads = Math.max(maxActiveNestedReads, activeNestedReads);
          await Bun.sleep(20);
        }
        try {
          return await realReadDir(...args);
        } finally {
          if (isNested) activeNestedReads--;
        }
      });

      try {
        await repo.listFolderPage("recursive", { recursive: true });
      } finally {
        readDirSpy.mockRestore();
      }

      expect(maxActiveNestedReads).toBeGreaterThan(1);
    });

    it("propagates ACL violations encountered during recursive listing", async () => {
      await repo.writeNote("visible/note", { content: "Visible" });
      await repo.writeNote("visible/private/secret", { content: "Secret" });
      const aclRepo = new VaultRepository({
        vaultPath: tmpDir,
        acl: { allowPaths: [], denyPaths: ["visible/private"] },
      });

      await expect(aclRepo.listFolder("visible")).rejects.toThrow(AclViolationError);
    });
  });

  describe("searchByPathOrName", () => {
    beforeEach(async () => {
      await repo.writeNote("10_Projects/ML-Project", { content: "ML" });
      await repo.writeNote("00_Inbox/meeting-notes", { content: "Meeting" });
      await repo.writeNote("80_People/John", { content: "John" });
    });

    it("finds notes by name", async () => {
      const results = await repo.searchByPathOrName("john");
      expect(results.length).toBe(1);
      expect(results[0].name).toBe("John.md");
    });

    it("finds notes by path", async () => {
      const results = await repo.searchByPathOrName("projects");
      expect(results.length).toBe(1);
      expect(results[0].path).toContain("10_Projects");
    });

    it("is case-insensitive", async () => {
      const results = await repo.searchByPathOrName("ML-PROJECT");
      expect(results.length).toBe(1);
    });

    it("respects limit", async () => {
      const results = await repo.searchByPathOrName("", { limit: 1 });
      expect(results.length).toBe(1);
    });

    it("scopes to folder", async () => {
      const results = await repo.searchByPathOrName("", {
        folder: "80_People",
      });
      expect(results.length).toBe(1);
      expect(results[0].path).toContain("80_People");
    });

    it("propagates ACL violations encountered during path traversal", async () => {
      await repo.writeNote("docs/public", { content: "Public" });
      await repo.writeNote("docs/private/secret", { content: "Secret" });
      const aclRepo = new VaultRepository({
        vaultPath: tmpDir,
        acl: { allowPaths: [], denyPaths: ["docs/private"] },
      });
      await expect(aclRepo.searchByPathOrName("")).rejects.toThrow(AclViolationError);
    });
  });

  describe("atomic write", () => {
    it("does not leave tmp files on success", async () => {
      await repo.writeNote("clean-note", { content: "Clean" });
      const dir = await fs.readdir(tmpDir);
      const tmpFiles = dir.filter((f) => f.includes(".tmp-"));
      expect(tmpFiles.length).toBe(0);
    });
  });

  describe("moveNote", () => {
    it("moves a note to a new path", async () => {
      await repo.writeNote("old/note", { content: "Content", frontmatter: { type: "capture" } });

      const result = await repo.moveNote("old/note", "new/note");
      expect(result.ok).toBe(true);
      expect(result.path).toBe("new/note.md");

      // Old path should not exist
      await expect(repo.readNote("old/note")).rejects.toThrow();

      // New path should have the content
      const note = await repo.readNote("new/note");
      expect(note.content).toContain("Content");
      expect(note.frontmatter.type).toBe("capture");
    });

    it("returns error when source does not exist", async () => {
      const result = await repo.moveNote("nonexistent", "somewhere");
      expect(result.ok).toBe(false);
      expect(result.message).toContain("does not exist");
    });

    it("blocks path traversal on source", async () => {
      await expect(repo.moveNote("../../etc/passwd", "safe")).rejects.toThrow(PathTraversalError);
    });

    it("blocks path traversal on destination", async () => {
      await repo.writeNote("safe-note", { content: "data" });
      await expect(repo.moveNote("safe-note", "../../etc/evil")).rejects.toThrow(PathTraversalError);
    });

    it("creates parent directories for destination", async () => {
      await repo.writeNote("src-note", { content: "Move me" });
      const result = await repo.moveNote("src-note", "deep/nested/dir/moved");
      expect(result.ok).toBe(true);
      const note = await repo.readNote("deep/nested/dir/moved");
      expect(note.content).toContain("Move me");
    });

    it("throws AclViolationError when source is in denyPaths", async () => {
      const aclRepo = new VaultRepository({
        vaultPath: tmpDir,
        acl: { allowPaths: [], denyPaths: ["Restricted"] },
      });
      await repo.writeNote("Restricted/secret", { content: "hidden" });
      await expect(aclRepo.moveNote("Restricted/secret", "Safe/moved")).rejects.toThrow(AclViolationError);
    });

    it("throws AclViolationError when destination is in denyPaths", async () => {
      const aclRepo = new VaultRepository({
        vaultPath: tmpDir,
        acl: { allowPaths: [], denyPaths: ["Restricted"] },
      });
      await repo.writeNote("Safe/note", { content: "content" });
      await expect(aclRepo.moveNote("Safe/note", "Restricted/moved")).rejects.toThrow(AclViolationError);
    });
  });

  describe("updateWikilinks", () => {
    it("rewrites basename and full-path wikilinks while preserving aliases", async () => {
      await repo.writeNote("Refs/a", {
        content: "See [[Old Note]] and [[Projects/Old Note|the project]].",
      });
      await repo.writeNote("Refs/b", {
        content: "No matching links here.",
      });

      const result = await repo.updateWikilinks("Projects/Old Note", "Archive/New Note");

      expect(result).toEqual({ updated: 1, errors: [] });
      const updated = await repo.readNote("Refs/a");
      const untouched = await repo.readNote("Refs/b");
      expect(updated.content).toContain("[[New Note]]");
      expect(updated.content).toContain("[[Archive/New Note|the project]]");
      expect(untouched.content).toBe("No matching links here.");
    });

    it("uses searchStore candidates when available", async () => {
      await repo.writeNote("Refs/a", { content: "See [[Old Note]]." });
      await repo.writeNote("Refs/b", { content: "See [[Old Note]]." });
      const searchStore = {
        searchFTS: mock().mockReturnValue([{ path: "Refs/a.md" }]),
      };

      const result = await repo.updateWikilinks("Old Note", "New Note", searchStore);

      expect(searchStore.searchFTS).toHaveBeenCalledWith("Old Note", 1000);
      expect(result).toEqual({ updated: 1, errors: [] });
      expect((await repo.readNote("Refs/a")).content).toContain("[[New Note]]");
      expect((await repo.readNote("Refs/b")).content).toContain("[[Old Note]]");
    });

    it("reports ACL-denied files during wikilink updates", async () => {
      await repo.writeNote("Allowed/a", { content: "See [[Old Note]]." });
      await repo.writeNote("Private/b", { content: "See [[Old Note]]." });
      const aclRepo = new VaultRepository({
        vaultPath: tmpDir,
        acl: { allowPaths: ["Allowed"], denyPaths: [] },
      });

      const result = await aclRepo.updateWikilinks("Old Note", "New Note");

      expect(result.updated).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("Private/b.md");
      expect(result.errors[0]).toContain("Access denied");
      expect((await repo.readNote("Allowed/a")).content).toContain("[[New Note]]");
      expect((await repo.readNote("Private/b")).content).toContain("[[Old Note]]");
    });
  });

  describe("deleteNote", () => {
    it("deletes an existing note", async () => {
      await repo.writeNote("doomed-note", { content: "Goodbye" });
      const result = await repo.deleteNote("doomed-note");
      expect(result.ok).toBe(true);
      await expect(repo.readNote("doomed-note")).rejects.toThrow();
    });

    it("returns error when note does not exist", async () => {
      const result = await repo.deleteNote("ghost-note");
      expect(result.ok).toBe(false);
      expect(result.message).toContain("Note not found");
    });

    it("returns a distinct permission error when unlink is denied", async () => {
      const err = Object.assign(new Error("denied"), { code: "EACCES" });
      const unlinkSpy = spyOn(fs, "unlink").mockRejectedValueOnce(err);

      const result = await repo.deleteNote("denied-note");

      expect(result.ok).toBe(false);
      expect(result.message).toContain("Permission denied");
      unlinkSpy.mockRestore();
    });

    it("blocks path traversal", async () => {
      await expect(repo.deleteNote("../../etc/passwd")).rejects.toThrow(PathTraversalError);
    });
  });

  describe("softDeleteNote", () => {
    it("moves note to .trash/ and returns ok:true with trashName", async () => {
      await repo.writeNote("to-trash", { content: "Soft delete me" });
      const result = await repo.softDeleteNote("to-trash");
      expect(result.ok).toBe(true);
      expect(result.trashName).toMatch(/to-trash\.md/);
      expect(result.message).toContain(".trash/");

      const trashEntries = await fs.readdir(path.join(tmpDir, ".trash"));
      expect(trashEntries.some((e) => e.includes("to-trash"))).toBe(true);
      await expect(fs.access(path.join(tmpDir, "to-trash.md"))).rejects.toThrow();
    });

    it("returns ok:false when note does not exist", async () => {
      const result = await repo.softDeleteNote("ghost");
      expect(result.ok).toBe(false);
      expect(result.trashName).toBe("");
      expect(result.message).toContain("Note not found");
    });

    it("throws AclViolationError for ACL-denied path", async () => {
      const aclRepo = new VaultRepository({
        vaultPath: tmpDir,
        acl: { allowPaths: [], denyPaths: ["private"] },
      });
      await repo.writeNote("private/secret", { content: "hidden" });
      await expect(aclRepo.softDeleteNote("private/secret")).rejects.toThrow(AclViolationError);
    });
  });

  describe("ACL enforcement", () => {
    it("readNote throws AclViolationError for path outside allowPaths", async () => {
      const aclRepo = new VaultRepository({
        vaultPath: tmpDir,
        acl: { allowPaths: ["allowed"], denyPaths: [] },
      });
      await repo.writeNote("denied/x", { content: "hidden" });
      await expect(aclRepo.readNote("denied/x")).rejects.toThrow(AclViolationError);
    });

    it("readNote succeeds for path inside allowPaths", async () => {
      const aclRepo = new VaultRepository({
        vaultPath: tmpDir,
        acl: { allowPaths: ["allowed"], denyPaths: [] },
      });
      await repo.writeNote("allowed/x", { content: "visible" });
      const note = await aclRepo.readNote("allowed/x");
      expect(note.content).toBe("visible");
    });

    it("writeNote throws AclViolationError for path in denyPaths", async () => {
      const aclRepo = new VaultRepository({
        vaultPath: tmpDir,
        acl: { allowPaths: [], denyPaths: ["private"] },
      });
      await expect(aclRepo.writeNote("private/x", { content: "secret" })).rejects.toThrow(AclViolationError);
    });

    it("deleteNote throws AclViolationError for path in denyPaths", async () => {
      const aclRepo = new VaultRepository({
        vaultPath: tmpDir,
        acl: { allowPaths: [], denyPaths: ["private"] },
      });
      await repo.writeNote("private/x", { content: "secret" });
      await expect(aclRepo.deleteNote("private/x")).rejects.toThrow(AclViolationError);
    });
  });
});
