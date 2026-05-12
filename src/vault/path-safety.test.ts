import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AclViolationError,
  assertAclSafe,
  assertRealPathSafe,
  ensureMarkdownPath,
  isAclAllowed,
  PathTraversalError,
  resolveVaultPath,
  toVaultRelative,
} from "./path-safety.js";

const ROOT = "/vault";

describe("resolveVaultPath", () => {
  it("resolves a simple relative path", () => {
    expect(resolveVaultPath(ROOT, "00_Inbox/note.md")).toBe(path.resolve(ROOT, "00_Inbox/note.md"));
  });

  it("strips leading slashes", () => {
    expect(resolveVaultPath(ROOT, "/00_Inbox/note.md")).toBe(path.resolve(ROOT, "00_Inbox/note.md"));
  });

  it("blocks ../ traversal", () => {
    expect(() => resolveVaultPath(ROOT, "../etc/passwd")).toThrow(PathTraversalError);
  });

  it("blocks nested traversal", () => {
    expect(() => resolveVaultPath(ROOT, "foo/../../etc/passwd")).toThrow(PathTraversalError);
  });

  it("blocks absolute path outside vault", () => {
    expect(() => resolveVaultPath(ROOT, "/etc/passwd")).not.toThrow();
    // /etc/passwd with leading slash stripped becomes "etc/passwd" inside vault
  });

  it("allows the vault root itself", () => {
    expect(resolveVaultPath(ROOT, "")).toBe(path.resolve(ROOT));
  });
});

describe("ensureMarkdownPath", () => {
  it("appends .md if missing", () => {
    expect(ensureMarkdownPath("note")).toBe("note.md");
  });

  it("does not double-append .md", () => {
    expect(ensureMarkdownPath("note.md")).toBe("note.md");
  });

  it("handles paths with directories", () => {
    expect(ensureMarkdownPath("00_Inbox/note")).toBe("00_Inbox/note.md");
  });
});

describe("toVaultRelative", () => {
  it("converts absolute to relative with forward slashes", () => {
    const abs = path.resolve(ROOT, "00_Inbox", "note.md");
    expect(toVaultRelative(ROOT, abs)).toBe("00_Inbox/note.md");
  });

  it("returns empty string for vault root", () => {
    expect(toVaultRelative(ROOT, ROOT)).toBe("");
  });
});

describe("assertAclSafe", () => {
  const root = "/vault";

  it("allows everything when both lists are empty", () => {
    expect(() => assertAclSafe(root, `${root}/Private/note.md`, { allowPaths: [], denyPaths: [] })).not.toThrow();
  });

  it("deny list blocks a matching path", () => {
    expect(() => assertAclSafe(root, `${root}/Private/note.md`, { allowPaths: [], denyPaths: ["Private"] })).toThrow(
      AclViolationError,
    );
  });

  it("deny list allows a non-matching path", () => {
    expect(() => assertAclSafe(root, `${root}/Work/note.md`, { allowPaths: [], denyPaths: ["Private"] })).not.toThrow();
  });

  it("allow list passes a matching path", () => {
    expect(() => assertAclSafe(root, `${root}/Work/note.md`, { allowPaths: ["Work"], denyPaths: [] })).not.toThrow();
  });

  it("allow list blocks a non-matching path", () => {
    expect(() => assertAclSafe(root, `${root}/Private/note.md`, { allowPaths: ["Work"], denyPaths: [] })).toThrow(
      AclViolationError,
    );
  });

  it("deny wins over allow when both match", () => {
    expect(() =>
      assertAclSafe(root, `${root}/Private/note.md`, { allowPaths: ["Private"], denyPaths: ["Private"] }),
    ).toThrow(AclViolationError);
  });

  it("deny does not produce false positive on similar prefix", () => {
    expect(() =>
      assertAclSafe(root, `${root}/WorkExtra/note.md`, { allowPaths: [], denyPaths: ["Work"] }),
    ).not.toThrow();
  });

  it("normalizes trailing slash in config prefix", () => {
    expect(() => assertAclSafe(root, `${root}/Finance/budget.md`, { allowPaths: [], denyPaths: ["Finance/"] })).toThrow(
      AclViolationError,
    );
  });

  it("allows nested sub-folder when parent is in allow list", () => {
    expect(() =>
      assertAclSafe(root, `${root}/Work/Projects/2026.md`, { allowPaths: ["Work"], denyPaths: [] }),
    ).not.toThrow();
  });

  it("is case-sensitive", () => {
    expect(() => assertAclSafe(root, `${root}/Work/note.md`, { allowPaths: ["work"], denyPaths: [] })).toThrow(
      AclViolationError,
    );
  });

  it("exact path match works (path equals prefix)", () => {
    expect(() => assertAclSafe(root, `${root}/Work`, { allowPaths: ["Work"], denyPaths: [] })).not.toThrow();
  });
});

describe("isAclAllowed", () => {
  it("returns true when both lists are empty", () => {
    expect(isAclAllowed("Private/note.md", { allowPaths: [], denyPaths: [] })).toBe(true);
  });

  it("returns false for denied path", () => {
    expect(isAclAllowed("Private/note.md", { allowPaths: [], denyPaths: ["Private"] })).toBe(false);
  });

  it("returns true for allowed path under allow list", () => {
    expect(isAclAllowed("Work/note.md", { allowPaths: ["Work"], denyPaths: [] })).toBe(true);
  });

  it("returns false for path outside allow list", () => {
    expect(isAclAllowed("Private/note.md", { allowPaths: ["Work"], denyPaths: [] })).toBe(false);
  });

  it("deny wins over allow", () => {
    expect(isAclAllowed("Private/note.md", { allowPaths: ["Private"], denyPaths: ["Private"] })).toBe(false);
  });
});

describe("assertRealPathSafe", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vault-safe-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("allows paths within vault", async () => {
    await fs.mkdir(path.join(tmpDir, "subfolder"), { recursive: true });
    await expect(assertRealPathSafe(tmpDir, path.join(tmpDir, "subfolder", "note.md"))).resolves.toBeUndefined();
  });

  it("blocks symlink pointing outside vault", async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "outside-"));
    try {
      await fs.symlink(outsideDir, path.join(tmpDir, "escape"));

      await expect(assertRealPathSafe(tmpDir, path.join(tmpDir, "escape", "file.md"))).rejects.toThrow(
        PathTraversalError,
      );
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("allows symlink within vault", async () => {
    const realDir = path.join(tmpDir, "real");
    await fs.mkdir(realDir);
    await fs.writeFile(path.join(realDir, "note.md"), "content");
    await fs.symlink(realDir, path.join(tmpDir, "link"));

    await expect(assertRealPathSafe(tmpDir, path.join(tmpDir, "link", "note.md"))).resolves.toBeUndefined();
  });
});
