import { readdir } from "node:fs/promises";
import type { VaultSync } from "../search/sync.js";
import type { VaultRepository } from "../vault/repository.js";

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

export interface TriageConfig {
  autoMoveThreshold: number;
  suggestThreshold: number;
  inboxFolder: string;
}

export class TriageState {
  private pending = new Map<number, { path: string; suggestedFolder: string; confidence: number; reason: string }>();
  private nextId = 1;

  add(entry: { path: string; suggestedFolder: string; confidence: number; reason: string }): number {
    const id = this.nextId++;
    this.pending.set(id, entry);
    return id;
  }

  get(id: number) {
    return this.pending.get(id);
  }

  remove(id: number): boolean {
    return this.pending.delete(id);
  }

  getAll(): Map<number, { path: string; suggestedFolder: string; confidence: number; reason: string }> {
    return new Map(this.pending);
  }

  clear(): void {
    this.pending.clear();
    this.nextId = 1;
  }

  get size(): number {
    return this.pending.size;
  }
}

export async function discoverVaultFolders(vaultRoot: string, excludeFolder: string): Promise<string[]> {
  const entries = await readdir(vaultRoot, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== excludeFolder)
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

  // Keyword matching (very basic)
  const keywordMap: [string[], string][] = [
    [["project", "milestone", "deadline", "sprint"], "Projects"],
    [["person", "met with", "meeting", "1:1"], "People"],
    [["idea", "brainstorm", "concept"], "Ideas"],
    [["admin", "invoice", "tax", "receipt"], "Admin"],
    [["reference", "documentation", "guide", "howto"], "References"],
  ];

  for (const [keywords, sectionName] of keywordMap) {
    if (keywords.some((kw) => lowerContent.includes(kw))) {
      const match = availableFolders.find((f) =>
        f.replace(/^\d+_/, "").toLowerCase().includes(sectionName.toLowerCase()),
      );
      if (match) {
        return { folder: match, confidence: 0.4, reason: `keyword match for "${sectionName}"` };
      }
    }
  }

  return { folder: inboxFolder, confidence: 0, reason: "no heuristic match" };
}

export async function triageInbox(opts: {
  vault: VaultRepository;
  vaultSync?: VaultSync;
  autoMoveThreshold: number;
  suggestThreshold: number;
  inboxFolder: string;
  dryRun?: boolean;
  vaultPath?: string;
  /** External classifications (e.g., from LLM caller). Key is note path. */
  classifications?: Map<string, TriageClassification>;
}): Promise<TriageResult> {
  const { vault, vaultSync, autoMoveThreshold, suggestThreshold, inboxFolder, dryRun } = opts;

  const result: TriageResult = { moved: [], suggested: [], skipped: [] };

  // List inbox notes
  let notes: Array<{ path: string }>;
  try {
    notes = await vault.listFolder(inboxFolder, { recursive: false });
  } catch {
    return result;
  }

  if (notes.length === 0) return result;

  // Discover available folders
  const vaultRoot = opts.vaultPath ?? (vault as unknown as { root: string }).root;
  const availableFolders = await discoverVaultFolders(vaultRoot, inboxFolder);

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
        classifyForTriageHeuristic(note.path, noteData.content, noteData.frontmatter, availableFolders, inboxFolder);

      if (classification.confidence >= autoMoveThreshold) {
        if (!dryRun) {
          // Determine destination path
          const fileName = note.path.split("/").at(-1) ?? note.path;
          const destPath = `${classification.folder}/${fileName}`;

          await vault.updateProperties(note.path, { triaged: true });
          await vault.moveNote(note.path, destPath);

          if (vaultSync) {
            const fromCanonical = note.path.endsWith(".md") ? note.path : `${note.path}.md`;
            const toCanonical = destPath.endsWith(".md") ? destPath : `${destPath}.md`;
            await vaultSync.handleRename(fromCanonical, toCanonical).catch(() => {});
          }
        }
        result.moved.push({ path: note.path, destination: classification.folder });
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
      console.error(`[triage] Error processing ${note.path}:`, err instanceof Error ? err.message : String(err));
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

export async function handleTriageApproval(
  state: TriageState,
  vault: VaultRepository,
  vaultSync: VaultSync | undefined,
  id: number,
  action: string,
): Promise<string> {
  const entry = state.get(id);
  if (!entry) return `No pending suggestion #${id}.`;

  if (action === "skip") {
    state.remove(id);
    return `Skipped: ${entry.path}`;
  }

  // "approve" uses suggested folder, anything else is a custom folder override
  const targetFolder = action === "approve" ? entry.suggestedFolder : action;

  const fileName = entry.path.split("/").at(-1) ?? entry.path;
  const destPath = `${targetFolder}/${fileName}`;

  try {
    await vault.updateProperties(entry.path, { triaged: true });
    await vault.moveNote(entry.path, destPath);

    if (vaultSync) {
      const fromCanonical = entry.path.endsWith(".md") ? entry.path : `${entry.path}.md`;
      const toCanonical = destPath.endsWith(".md") ? destPath : `${destPath}.md`;
      await vaultSync.handleRename(fromCanonical, toCanonical).catch(() => {});
    }

    state.remove(id);
    return `Moved: ${entry.path} -> ${destPath}`;
  } catch (err) {
    return `Failed to move ${entry.path}: ${err instanceof Error ? err.message : String(err)}`;
  }
}
