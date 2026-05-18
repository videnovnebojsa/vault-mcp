import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { VaultError, VaultErrorCode } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { parseFrontmatter, serializeNote, validateFrontmatter } from "./frontmatter.js";
import {
  AclViolationError,
  assertAclSafe,
  assertRealPathSafe,
  ensureMarkdownPath,
  PathTraversalError,
  resolveVaultPath,
  toVaultRelative,
} from "./path-safety.js";
import type { IVaultRepository, WikilinkSearchIndex } from "./repository-interface.js";
import type {
  AclConfig,
  ListFolderOptions,
  ListFolderPage,
  SearchOptions,
  VaultNote,
  VaultNoteSummary,
  VaultOperationResult,
  VaultRepositoryOptions,
  WriteNoteInput,
} from "./types.js";

interface FolderCandidate {
  fullPath: string;
  relPath: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

function rethrowSecurityError(err: unknown): void {
  if (err instanceof PathTraversalError || err instanceof AclViolationError) throw err;
}

export class VaultRepository implements IVaultRepository {
  private readonly root: string;
  private readonly acl: AclConfig;
  private realRoot: Promise<string> | undefined;

  get vaultPath(): string {
    return this.root;
  }

  constructor(opts: VaultRepositoryOptions) {
    this.root = opts.vaultPath;
    this.acl = opts.acl ?? { allowPaths: [], denyPaths: [] };
  }

  private async assertRealPathSafe(absPath: string): Promise<void> {
    this.realRoot ??= fs.realpath(this.root);
    await assertRealPathSafe(this.root, absPath, await this.realRoot);
  }

  async readNote(notePath: string): Promise<VaultNote> {
    const safePath = ensureMarkdownPath(notePath);
    const absPath = resolveVaultPath(this.root, safePath);
    await this.assertRealPathSafe(absPath);
    assertAclSafe(this.root, absPath, this.acl);
    let raw: string;
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      [raw, stat] = await Promise.all([fs.readFile(absPath, "utf-8"), fs.stat(absPath)]);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new VaultError(`Note not found: ${notePath}`, VaultErrorCode.NOT_FOUND, err);
      }
      throw err;
    }
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
    await this.assertRealPathSafe(absPath);
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

  async moveNote(oldPath: string, newPath: string, overwrite = false): Promise<VaultOperationResult> {
    const safeOld = ensureMarkdownPath(oldPath);
    const safeNew = ensureMarkdownPath(newPath);
    const absOld = resolveVaultPath(this.root, safeOld);
    const absNew = resolveVaultPath(this.root, safeNew);
    await this.assertRealPathSafe(absOld);
    assertAclSafe(this.root, absOld, this.acl);
    await this.assertRealPathSafe(absNew);
    assertAclSafe(this.root, absNew, this.acl);

    // Ensure source exists
    try {
      await fs.stat(absOld);
    } catch {
      return { ok: false, path: toVaultRelative(this.root, absOld), message: "Source note does not exist" };
    }

    // Ensure parent directory for destination exists
    await fs.mkdir(path.dirname(absNew), { recursive: true });

    // Check for existing destination; refuse unless overwrite flag is set
    try {
      await fs.stat(absNew);
      if (!overwrite) {
        return { ok: false, path: toVaultRelative(this.root, absNew), message: "Destination already exists" };
      }
      await fs.unlink(absNew);
    } catch (err) {
      // stat failed — destination does not exist, safe to proceed
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
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
    await this.assertRealPathSafe(absPath);
    assertAclSafe(this.root, absPath, this.acl);

    try {
      await fs.unlink(absPath);
    } catch (err) {
      return deleteFailureResult(this.root, absPath, notePath, err, "deleted");
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
    await this.assertRealPathSafe(absPath);
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
    } catch (err) {
      return { ...deleteFailureResult(this.root, absPath, notePath, err, "moved to trash"), trashName: "" };
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
   * ACL-denied paths are reported in errors and skipped, not thrown.
   */
  async updateWikilinks(
    oldPath: string,
    newPath: string,
    searchStore?: WikilinkSearchIndex,
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
      } catch (err) {
        if (!(err instanceof AclViolationError)) throw err;
        const msg = err.message;
        const relPath = toVaultRelative(this.root, absPath);
        errors.push(`${relPath}: ${msg}`);
        logger.warn("vault", "updateWikilinks: skipped ACL-denied file", { path: relPath, err: msg });
        return;
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
        const relPath = toVaultRelative(this.root, absPath);
        errors.push(`${relPath}: ${msg}`);
        logger.warn("vault", "updateWikilinks: failed to update file", { path: relPath, err: msg });
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
    return (await this.listFolderPage(folder, opts)).items;
  }

  async listFolderPage(folder: string, opts?: ListFolderOptions): Promise<ListFolderPage> {
    const recursive = opts?.recursive ?? true;
    const limit = opts?.limit ?? 200;
    const offset = opts?.offset ?? 0;
    const modifiedAfter = opts?.modifiedAfter;
    const absFolder = resolveVaultPath(this.root, folder);
    await this.assertRealPathSafe(absFolder);
    assertAclSafe(this.root, absFolder, this.acl);

    const candidates: FolderCandidate[] = [];
    await this.collectFolderCandidates(absFolder, recursive, candidates, modifiedAfter);
    candidates.sort((a, b) => a.relPath.localeCompare(b.relPath));

    const page: VaultNoteSummary[] = [];
    for (const candidate of candidates.slice(offset, offset + limit)) {
      const summary = await this.readFolderCandidate(candidate);
      if (summary) page.push(summary);
    }

    return { items: page, total: candidates.length };
  }

  async searchByPathOrName(query: string, opts?: SearchOptions): Promise<VaultNoteSummary[]> {
    const limit = opts?.limit ?? 20;
    const folder = opts?.folder ?? ".";
    const absFolder = resolveVaultPath(this.root, folder);
    await this.assertRealPathSafe(absFolder);
    assertAclSafe(this.root, absFolder, this.acl);

    const lowerQuery = query.toLowerCase();
    const matches: VaultNoteSummary[] = [];
    await this.walkPathsFiltered(absFolder, lowerQuery, limit, matches);

    return matches;
  }

  private async collectFolderCandidates(
    dir: string,
    recursive: boolean,
    candidates: FolderCandidate[],
    modifiedAfter?: number,
  ): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => null);
    if (!entries) return;

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory() && recursive) {
        try {
          await this.assertRealPathSafe(fullPath);
          assertAclSafe(this.root, fullPath, this.acl);
        } catch (err) {
          rethrowSecurityError(err);
          continue;
        }
        await this.collectFolderCandidates(fullPath, recursive, candidates, modifiedAfter);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        try {
          const stat = await fs.stat(fullPath);
          if (modifiedAfter !== undefined && stat.mtimeMs < modifiedAfter) continue;
          candidates.push({
            fullPath,
            relPath: toVaultRelative(this.root, fullPath),
            name: entry.name,
            createdAt: stat.birthtimeMs,
            updatedAt: stat.mtimeMs,
          });
        } catch (err) {
          logger.warn("vault", "skipping unreadable file", {
            path: toVaultRelative(this.root, fullPath),
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  private async readFolderCandidate(candidate: FolderCandidate): Promise<VaultNoteSummary | undefined> {
    try {
      const raw = await fs.readFile(candidate.fullPath, "utf-8");
      const parsed = parseFrontmatter(raw);
      return {
        path: candidate.relPath,
        name: candidate.name,
        frontmatter: parsed.frontmatter,
        createdAt: candidate.createdAt,
        updatedAt: candidate.updatedAt,
      };
    } catch (err) {
      logger.warn("vault", "skipping unreadable file", {
        path: candidate.relPath,
        err: err instanceof Error ? err.message : String(err),
      });
      return undefined;
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
          await this.assertRealPathSafe(fullPath);
          assertAclSafe(this.root, fullPath, this.acl);
        } catch (err) {
          rethrowSecurityError(err);
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
          } catch (err) {
            logger.warn("vault", "skipping unreadable file", {
              path: relPath,
              err: err instanceof Error ? err.message : String(err),
            });
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

function deleteFailureResult(
  root: string,
  absPath: string,
  notePath: string,
  err: unknown,
  action: "deleted" | "moved to trash",
): VaultOperationResult {
  const code = (err as NodeJS.ErrnoException).code;
  const path = toVaultRelative(root, absPath);
  if (code === "ENOENT") {
    return { ok: false, path, message: `Note not found: ${notePath}` };
  }
  if (code === "EACCES" || code === "EPERM") {
    return { ok: false, path, message: `Permission denied: note cannot be ${action}` };
  }
  if (code) {
    return { ok: false, path, message: `I/O error while deleting note (${code})` };
  }
  return { ok: false, path, message: `Unknown error while deleting note: ${String(err)}` };
}

function escapeRegexLocal(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
