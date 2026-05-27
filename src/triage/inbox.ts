import { readdir } from "node:fs/promises";
import { VAULT_FOLDERS, type VaultFolders } from "../config/folders.js";
import type { VaultSync } from "../search/sync.js";
import { VaultError, VaultErrorCode } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { isAclAllowed } from "../vault/path-safety.js";
import type { IVaultRepository } from "../vault/repository-interface.js";
import type { AclConfig } from "../vault/types.js";

/** Strip numeric prefix for display or fallback matching (e.g. "10_Projects" → "Projects"). */
const folderLabel = (path: string) => path.replace(/^\d+_/, "");

export interface TriageClassification {
  folder: string;
  confidence: number;
  reason: string;
}

export interface TriageResult {
  moved: { path: string; destination: string }[];
  suggested: { path: string; destination: string; confidence: number; reason: string }[];
  skipped: string[];
}

export async function discoverVaultFolders(
  vaultRoot: string,
  excludeFolder: string,
  acl: AclConfig = { allowPaths: [], denyPaths: [] },
): Promise<string[]> {
  const entries = await readdir(vaultRoot, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== excludeFolder && isAclAllowed(e.name, acl))
    .map((e) => e.name)
    .sort();
}

/**
 * Heuristic folder classification based on note metadata and content keywords.
 * Returns low confidence — callers with LLM access should classify externally
 * and pass results via the `classifications` option on triageInbox.
 */
export function classifyForTriageHeuristic(
  _notePath: string,
  content: string,
  frontmatter: Record<string, unknown> | undefined,
  availableFolders: string[],
  inboxFolder: string,
  folders: VaultFolders = VAULT_FOLDERS,
): TriageClassification {
  const tags = Array.isArray(frontmatter?.["tags"]) ? (frontmatter["tags"] as string[]) : [];
  const type = typeof frontmatter?.["type"] === "string" ? (frontmatter["type"] as string) : "";
  const lowerContent = content.toLowerCase();

  // Try to match by type frontmatter
  for (const folder of availableFolders) {
    const folderLower = folder.replace(/^\d+_/, "").toLowerCase();
    if (type && folderLower.includes(type.toLowerCase())) {
      return { folder, confidence: 0.6, reason: `type "${type}" matches folder` };
    }
  }

  // Try to match by tags
  for (const tag of tags) {
    for (const folder of availableFolders) {
      const folderLower = folder.replace(/^\d+_/, "").toLowerCase();
      if (folderLower.includes(tag.toLowerCase())) {
        return { folder, confidence: 0.5, reason: `tag "${tag}" matches folder` };
      }
    }
  }

  // Keyword routing for VaultFolders-backed categories: exact match only.
  // Using the configured folder name directly avoids false-positive substring
  // routing when a custom folder name overlaps with the label of a default folder.
  const configuredKeywords: [string[], string][] = [
    [["project", "milestone", "deadline", "sprint"], folders.PROJECTS],
    [["person", "met with", "meeting", "1:1"], folders.PEOPLE],
    [["idea", "brainstorm", "concept"], folders.ZETTELKASTEN],
    [["admin", "invoice", "tax", "receipt"], folders.ADMIN],
  ];

  for (const [keywords, configuredFolder] of configuredKeywords) {
    if (keywords.some((kw) => lowerContent.includes(kw))) {
      if (availableFolders.includes(configuredFolder)) {
        return { folder: configuredFolder, confidence: 0.4, reason: `keyword match for "${configuredFolder}"` };
      }
    }
  }

  // Keyword routing for categories with no VaultFolders constant: stripped-label
  // exact match so the search adapts to custom naming conventions.
  const genericKeywords: [string[], string][] = [[["reference", "documentation", "guide", "howto"], "References"]];

  for (const [keywords, labelName] of genericKeywords) {
    if (keywords.some((kw) => lowerContent.includes(kw))) {
      const labelLower = labelName.toLowerCase();
      const match = availableFolders.find((f) => folderLabel(f).toLowerCase() === labelLower);
      if (match) {
        return { folder: match, confidence: 0.4, reason: `keyword match for "${labelName}"` };
      }
    }
  }

  return { folder: inboxFolder, confidence: 0, reason: "no heuristic match" };
}

export async function triageInbox(opts: {
  vault: IVaultRepository;
  vaultSync?: VaultSync;
  autoMoveThreshold: number;
  suggestThreshold: number;
  inboxFolder: string;
  dryRun?: boolean;
  acl?: AclConfig;
  /** Configured folder names — used by the heuristic classifier to map keywords to the right folders. */
  folders?: VaultFolders;
  /** External classifications (e.g., from LLM caller). Key is note path. */
  classifications?: Map<string, TriageClassification>;
}): Promise<TriageResult> {
  const { vault, vaultSync, autoMoveThreshold, suggestThreshold, inboxFolder, dryRun } = opts;

  const result: TriageResult = { moved: [], suggested: [], skipped: [] };

  // List inbox notes
  let notes: Array<{ path: string }>;
  try {
    notes = await vault.listFolder(inboxFolder, { recursive: false });
  } catch (err) {
    logger.warn("triage", "inbox listFolder failed", { err: err instanceof Error ? err.message : String(err) });
    throw new VaultError("Failed to list inbox folder", VaultErrorCode.STORE_UNAVAILABLE, err);
  }

  if (notes.length === 0) return result;

  // Discover available folders
  const vaultRoot = vault.vaultPath;
  const availableFolders = await discoverVaultFolders(vaultRoot, inboxFolder, opts.acl);

  if (availableFolders.length === 0) return result;

  // Process each note sequentially
  for (const note of notes) {
    try {
      const noteData = await vault.readNote(note.path);

      // Skip already-triaged notes
      if (noteData.frontmatter["triaged"] === true) {
        result.skipped.push(note.path);
        continue;
      }

      // Use external classification if provided, otherwise heuristic
      const classification =
        opts.classifications?.get(note.path) ??
        classifyForTriageHeuristic(
          note.path,
          noteData.content,
          noteData.frontmatter,
          availableFolders,
          inboxFolder,
          opts.folders,
        );

      if (classification.confidence >= autoMoveThreshold) {
        // Compute the full destination path regardless of dryRun so it's accurate in the result
        const fileName = note.path.split("/").at(-1) ?? note.path;
        const destPath = `${classification.folder}/${fileName}`;

        if (!dryRun) {
          await vault.updateProperties(note.path, { triaged: true });
          await vault.moveNote(note.path, destPath);

          if (vaultSync) {
            const fromCanonical = note.path.endsWith(".md") ? note.path : `${note.path}.md`;
            const toCanonical = destPath.endsWith(".md") ? destPath : `${destPath}.md`;
            await vaultSync.handleRename(fromCanonical, toCanonical).catch((err: unknown) =>
              logger.error("triage", "sync index update failed after auto-move", {
                from: fromCanonical,
                to: toCanonical,
                err: err instanceof Error ? err.message : String(err),
              }),
            );
          }
        }
        result.moved.push({ path: note.path, destination: destPath });
      } else if (classification.confidence >= suggestThreshold) {
        result.suggested.push({
          path: note.path,
          destination: classification.folder,
          confidence: classification.confidence,
          reason: classification.reason,
        });
      } else {
        result.skipped.push(note.path);
      }
    } catch (err) {
      logger.warn("triage", "error processing note", {
        path: note.path,
        err: err instanceof Error ? err.message : String(err),
      });
      result.skipped.push(note.path);
    }
  }

  return result;
}

export function formatTriageReport(result: TriageResult): string {
  const lines: string[] = [];

  if (result.moved.length > 0) {
    lines.push(`Moved (${result.moved.length}):`);
    for (const m of result.moved) {
      lines.push(`  ${m.path} -> ${m.destination}`);
    }
  }

  if (result.suggested.length > 0) {
    lines.push(`Suggestions (${result.suggested.length}):`);
    for (const [i, s] of result.suggested.entries()) {
      lines.push(`  [${i + 1}] ${s.path} -> ${s.destination} (${(s.confidence * 100).toFixed(0)}%) — ${s.reason}`);
    }
    lines.push("");
    lines.push("Use /triage <N> approve|skip|<folder> to act on suggestions.");
  }

  if (result.skipped.length > 0) {
    lines.push(`Skipped: ${result.skipped.length} note(s)`);
  }

  if (lines.length === 0) {
    return "Inbox is empty — nothing to triage.";
  }

  return lines.join("\n");
}
