import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { logger } from "../utils/logger.js";
import { parseFrontmatter, serializeNote, validateFrontmatter } from "./frontmatter.js";
import {
  assertAclSafe,
  assertRealPathSafe,
  ensureMarkdownPath,
  resolveVaultPath,
  toVaultRelative,
} from "./path-safety.js";
import type {
  AclConfig,
  ListFolderOptions,
  SearchOptions,
  VaultNote,
  VaultNoteSummary,
  VaultOperationResult,
  VaultRepositoryOptions,
  WriteNoteInput,
} from "./types.js";

export class VaultRepository {
  private readonly root: string;
  private readonly acl: AclConfig;

  constructor(opts: VaultRepositoryOptions) {
    this.root = opts.vaultPath;
    this.acl = opts.acl ?? { allowPaths: [], denyPaths: [] };
  }

  async readNote(notePath: string): Promise<VaultNote> {
    const safePath = ensureMarkdownPath(notePath);
    const absPath = resolveVaultPath(this.root, safePath);
    await assertRealPathSafe(this.root, absPath);
    assertAclSafe(this.root, absPath, this.acl);
    const [raw, stat] = await Promise.all([fs.readFile(absPath, "utf-8"), fs.stat(absPath)]);
    const parsed = parseFrontmatter(raw);

    return {
      path: toVaultRelative(this.root, absPath),
      absPath,
      name: path.basename(absPath),
      content: parsed.content,
      frontmatter: parsed.frontmatter,
      raw,
      createdAt: stat.birthtimeMs,
      updatedAt: stat.mtimeMs,
    };
  }

  async writeNote(notePath: string, input: WriteNoteInput): Promise<VaultOperationResult> {
    const safePath = ensureMarkdownPath(notePath);
    const absPath = resolveVaultPath(this.root, safePath);

    const fm = input.frontmatter ?? {};
    const validation = validateFrontmatter(fm);
    if (!validation.ok) {
      return {
        ok: false,
        path: toVaultRelative(this.root, absPath),
        message: `Frontmatter validation failed: ${validation.errors?.join(", ")}`,
      };
    }

    const serialized = serializeNote(input.content, fm);

    // Verify resolved path is safe before creating any directories
    await assertRealPathSafe(this.root, absPath);
    assertAclSafe(this.root, absPath, this.acl);

    // Ensure parent directory exists
    await fs.mkdir(path.dirname(absPath), { recursive: true });

    // Atomic write: tmp file → rename
    const tmpPath = `${absPath}.tmp-${randomUUID()}`;
    try {
      await fs.writeFile(tmpPath, serialized, "utf-8");
      await fs.rename(tmpPath, absPath);
    } catch (err) {
      // Clean up tmp file on failure
      await fs.unlink(tmpPath).catch(() => {});
      throw err;
    }

    const stat = await fs.stat(absPath);
    const relPath = toVaultRelative(this.root, absPath);
    return {
      ok: true,
      path: relPath,
      message: "Note written successfully",
      note: {
        path: relPath,
        absPath,
        name: path.basename(absPath),
        content: input.content,
        frontmatter: fm,
        raw: serialized,
        createdAt: stat.birthtimeMs,
        updatedAt: stat.mtimeMs,
      },
    };
  }

  async moveNote(oldPath: string, newPath: string): Promise<VaultOperationResult> {
    const safeOld = ensureMarkdownPath(oldPath);
    const safeNew = ensureMarkdownPath(newPath);
    const absOld = resolveVaultPath(this.root, safeOld);
    const absNew = resolveVaultPath(this.root, safeNew);
    await assertRealPathSafe(this.root, absOld);
    assertAclSafe(this.root, absOld, this.acl);
    await assertRealPathSafe(this.root, absNew);
    assertAclSafe(this.root, absNew, this.acl);

    // Ensure source exists
    try {
      await fs.stat(absOld);
    } catch {
      return { ok: false, path: toVaultRelative(this.root, absOld), message: "Source note does not exist" };
    }

    // Ensure parent directory for destination exists
    await fs.mkdir(path.dirname(absNew), { recursive: true });

    // Refuse to overwrite an existing note
    try {
      await fs.stat(absNew);
      return { ok: false, path: toVaultRelative(this.root, absNew), message: "Destination already exists" };
    } catch {
      // Destination does not exist — safe to proceed
    }

    await fs.rename(absOld, absNew);

    return {
      ok: true,
      path: toVaultRelative(this.root, absNew),
      message: `Moved ${toVaultRelative(this.root, absOld)} → ${toVaultRelative(this.root, absNew)}`,
    };
  }

  async deleteNote(notePath: string): Promise<VaultOperationResult> {
    const safePath = ensureMarkdownPath(notePath);
    const absPath = resolveVaultPath(this.root, safePath);
    await assertRealPathSafe(this.root, absPath);
    assertAclSafe(this.root, absPath, this.acl);

    try {
      await fs.unlink(absPath);
    } catch {
      return {
        ok: false,
        path: toVaultRelative(this.root, absPath),
        message: "Note does not exist or cannot be deleted",
      };
    }

    return {
      ok: true,
      path: toVaultRelative(this.root, absPath),
      message: "Note deleted",
    };
  }

  /**
   * Move a note to the vault's .trash/ folder instead of deleting it.
   * ACL is enforced against this.acl. Returns the trash filename on success.
   */
  async softDeleteNote(notePath: string): Promise<VaultOperationResult & { trashName: string }> {
    const safePath = ensureMarkdownPath(notePath);
    const absPath = resolveVaultPath(this.root, safePath);
    await assertRealPathSafe(this.root, absPath);
    assertAclSafe(this.root, absPath, this.acl);

    const trashDir = path.join(this.root, ".trash");
    await fs.mkdir(trashDir, { recursive: true });
    const trashBaseName = path.relative(this.root, absPath).replace(/[\\/]/g, "_");
    const trashPath = await uniqueTrashPath(trashDir, trashBaseName);
    const trashName = path.basename(trashPath);

    // Check denyPaths for the trash destination (skip allowPaths — .trash is an internal folder).
    assertAclSafe(this.root, trashPath, { allowPaths: [], denyPaths: this.acl.denyPaths });

    try {
      await fs.rename(absPath, trashPath);
    } catch {
      return {
        ok: false,
        path: toVaultRelative(this.root, absPath),
        message: "Note does not exist or cannot be moved to trash",
        trashName: "",
      };
    }

    return {
      ok: true,
      path: toVaultRelative(this.root, absPath),
      message: `Moved to .trash/${trashName}`,
      trashName,
    };
  }

  /**
   * Rewrite wikilinks in the vault when a note is renamed.
   * If a searchStore is provided, uses FTS to find candidate notes first (faster).
   * Falls back to a full vault walk when FTS returns 0 candidates (e.g. cold index).
   * ACL-denied paths are skipped, not thrown.
   */
  async updateWikilinks(
    oldPath: string,
    newPath: string,
    searchStore?: { searchFTS(query: string, limit: number): Array<{ path: string }> },
  ): Promise<{ updated: number; errors: string[] }> {
    const oldBasename = path.basename(oldPath, ".md");
    const newBasename = path.basename(newPath, ".md");
    const errors: string[] = [];
    let updated = 0;

    const buildRegexReplacer = (old: string, replacement: string) => (content: string) =>
      content.replace(
        new RegExp(`\\[\\[${escapeRegexLocal(old)}(\\|[^\\]]+)?\\]\\]`, "g"),
        (_match, alias) => `[[${replacement}${alias ?? ""}]]`,
      );

    const replaceBasename = buildRegexReplacer(oldBasename, newBasename);
    const replaceFullPath = buildRegexReplacer(oldPath, newPath);

    const processFile = async (absPath: string): Promise<void> => {
      try {
        assertAclSafe(this.root, absPath, this.acl);
      } catch {
        return; // ACL-denied path — skip silently
      }
      try {
        const raw = await fs.readFile(absPath, "utf-8");
        const replaced = replaceFullPath(replaceBasename(raw));
        if (replaced !== raw) {
          await fs.writeFile(absPath, replaced, "utf-8");
          updated++;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${absPath}: ${msg}`);
        logger.warn("vault", "updateWikilinks: failed to update file", { path: absPath, err: msg });
      }
    };

    // Try FTS candidate selection first to avoid a full vault walk
    let candidatePaths: string[] | null = null;
    if (searchStore) {
      const hits = searchStore.searchFTS(oldBasename, 1000);
      if (hits.length > 0) {
        candidatePaths = hits.map((h) => path.join(this.root, h.path));
      }
    }

    if (candidatePaths !== null) {
      await Promise.all(candidatePaths.map(processFile));
    } else {
      // Full vault walk fallback
      await this._walkForWikilinks(this.root, processFile);
    }

    return { updated, errors };
  }

  private async _walkForWikilinks(dir: string, process: (abs: string) => Promise<void>): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(
      entries.map(async (entry) => {
        if (entry.name.startsWith(".")) return;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await this._walkForWikilinks(fullPath, process);
        } else if (entry.isFile() && entry.name.endsWith(".md")) {
          await process(fullPath);
        }
      }),
    );
  }

  async updateProperties(notePath: string, props: Record<string, unknown>): Promise<VaultOperationResult> {
    const existing = await this.readNote(notePath);
    const merged = { ...existing.frontmatter, ...props };
    return this.writeNote(existing.path, {
      content: existing.content,
      frontmatter: merged,
    });
  }

  async listFolder(folder: string, opts?: ListFolderOptions): Promise<VaultNoteSummary[]> {
    const recursive = opts?.recursive ?? true;
    const limit = opts?.limit ?? 200;
    const modifiedAfter = opts?.modifiedAfter;
    const absFolder = resolveVaultPath(this.root, folder);
    await assertRealPathSafe(this.root, absFolder);
    assertAclSafe(this.root, absFolder, this.acl);

    const results: VaultNoteSummary[] = [];
    await this.walkDir(absFolder, recursive, limit, results, modifiedAfter);
    return results;
  }

  async searchByPathOrName(query: string, opts?: SearchOptions): Promise<VaultNoteSummary[]> {
    const limit = opts?.limit ?? 20;
    const folder = opts?.folder ?? ".";
    const absFolder = resolveVaultPath(this.root, folder);
    await assertRealPathSafe(this.root, absFolder);
    assertAclSafe(this.root, absFolder, this.acl);

    const lowerQuery = query.toLowerCase();
    const matches: VaultNoteSummary[] = [];
    await this.walkPathsFiltered(absFolder, lowerQuery, limit, matches);

    return matches;
  }

  /**
   * Walk directory collecting full summaries (with frontmatter) for listFolder.
   */
  private async walkDir(
    dir: string,
    recursive: boolean,
    limit: number,
    results: VaultNoteSummary[],
    modifiedAfter?: number,
  ): Promise<void> {
    if (results.length >= limit) return;

    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => null);
    if (!entries) return;

    for (const entry of entries) {
      if (results.length >= limit) return;
      if (entry.name.startsWith(".")) continue;

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory() && recursive) {
        try {
          await assertRealPathSafe(this.root, fullPath);
          assertAclSafe(this.root, fullPath, this.acl);
        } catch {
          continue;
        }
        await this.walkDir(fullPath, recursive, limit, results, modifiedAfter);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        try {
          const [stat, raw] = await Promise.all([fs.stat(fullPath), fs.readFile(fullPath, "utf-8")]);
          if (modifiedAfter !== undefined && stat.mtimeMs < modifiedAfter) continue;
          const parsed = parseFrontmatter(raw);
          results.push({
            path: toVaultRelative(this.root, fullPath),
            name: entry.name,
            frontmatter: parsed.frontmatter,
            createdAt: stat.birthtimeMs,
            updatedAt: stat.mtimeMs,
          });
        } catch {
          // Skip unreadable files
        }
      }
    }
  }

  /**
   * Walk directory matching paths against a query, skipping file reads.
   * Only reads frontmatter for matched files.
   */
  private async walkPathsFiltered(
    dir: string,
    lowerQuery: string,
    limit: number,
    results: VaultNoteSummary[],
  ): Promise<void> {
    if (results.length >= limit) return;

    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => null);
    if (!entries) return;

    for (const entry of entries) {
      if (results.length >= limit) return;
      if (entry.name.startsWith(".")) continue;

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        try {
          await assertRealPathSafe(this.root, fullPath);
          assertAclSafe(this.root, fullPath, this.acl);
        } catch {
          continue;
        }
        await this.walkPathsFiltered(fullPath, lowerQuery, limit, results);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        const relPath = toVaultRelative(this.root, fullPath);
        if (relPath.toLowerCase().includes(lowerQuery) || entry.name.toLowerCase().includes(lowerQuery)) {
          try {
            const [raw, stat] = await Promise.all([fs.readFile(fullPath, "utf-8"), fs.stat(fullPath)]);
            const parsed = parseFrontmatter(raw);

            results.push({
              path: relPath,
              name: entry.name,
              frontmatter: parsed.frontmatter,
              createdAt: stat.birthtimeMs,
              updatedAt: stat.mtimeMs,
            });
          } catch {
            // Skip unreadable files
          }
        }
      }
    }
  }
}

async function uniqueTrashPath(trashDir: string, baseName: string): Promise<string> {
  const candidate = path.join(trashDir, baseName);
  try {
    await fs.stat(candidate);
    const ext = path.extname(baseName);
    const stem = baseName.slice(0, baseName.length - ext.length);
    return path.join(trashDir, `${stem}-${Date.now()}${ext}`);
  } catch {
    return candidate;
  }
}

function escapeRegexLocal(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
