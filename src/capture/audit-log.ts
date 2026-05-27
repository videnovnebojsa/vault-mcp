import fs from "node:fs/promises";
import path from "node:path";
import { VAULT_FOLDERS, type VaultFolders } from "../config/folders.js";
import { assertRealPathSafe, resolveVaultPath } from "../vault/path-safety.js";
import { buildAuditLogPath } from "./filename.js";
import type { CaptureClassification } from "./types.js";

export async function appendClassificationLog(
  vaultPath: string,
  classification: CaptureClassification,
  notePath: string,
  folders: VaultFolders = VAULT_FOLDERS,
  rawInput?: string,
): Promise<void> {
  const logRelPath = buildAuditLogPath(folders);
  const absPath = resolveVaultPath(vaultPath, logRelPath);
  await assertRealPathSafe(vaultPath, absPath);

  // Ensure parent directory exists
  await fs.mkdir(path.dirname(absPath), { recursive: true });

  const timestamp = new Date().toISOString();
  // Strip [[ and ]] to prevent wikilink injection from attacker-controlled suggested_title
  const safeTitle = classification.suggested_title.replace(/\[\[|\]\]/g, "");
  const entry = [
    `## ${timestamp}`,
    "",
    `- **Category**: ${classification.category}`,
    `- **Confidence**: ${classification.confidence}`,
    `- **Title**: ${safeTitle}`,
    `- **Tags**: ${classification.tags.join(", ") || "none"}`,
    `- **Filed to**: [[${notePath}]]`,
    ...(rawInput
      ? [`- **Raw input**: ${rawInput.replace(/[\r\n]+/g, " ").slice(0, 200)}${rawInput.length > 200 ? "..." : ""}`]
      : []),
    "",
  ].join("\n");

  // Create the log file with its header if it does not yet exist.
  // 'wx' = O_WRONLY | O_CREAT | O_EXCL — exactly one concurrent opener wins;
  // all others get EEXIST and skip straight to the appendFile below.
  // We write ONLY the header here and let every writer — including this one —
  // use appendFile for the entry, so all entry writes go through O_APPEND and
  // are individually atomic (no torn writes under concurrent captures) [SEC-04].
  const header = `---\ntype: audit-log\ncreated: ${timestamp}\n---\n\n# Classification Log\n\n`;
  try {
    const fh = await fs.open(absPath, "wx");
    try {
      await fh.writeFile(header, "utf-8");
    } finally {
      await fh.close();
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    // Another writer already created the file with its header — nothing to do.
  }

  // O_APPEND guarantees each write is placed atomically at EOF [SEC-04]
  await fs.appendFile(absPath, entry, "utf-8");
}
