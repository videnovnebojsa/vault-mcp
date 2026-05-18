import fs from "node:fs/promises";
import path from "node:path";
import { assertRealPathSafe, resolveVaultPath } from "../vault/path-safety.js";
import { buildAuditLogPath } from "./filename.js";
import type { CaptureClassification } from "./types.js";

export async function appendClassificationLog(
  vaultPath: string,
  classification: CaptureClassification,
  notePath: string,
  rawInput?: string,
): Promise<void> {
  const logRelPath = buildAuditLogPath();
  const absPath = resolveVaultPath(vaultPath, logRelPath);
  await assertRealPathSafe(vaultPath, absPath);

  // Ensure parent directory exists
  await fs.mkdir(path.dirname(absPath), { recursive: true });

  const timestamp = new Date().toISOString();
  const entry = [
    `## ${timestamp}`,
    "",
    `- **Category**: ${classification.category}`,
    `- **Confidence**: ${classification.confidence}`,
    `- **Title**: ${classification.suggested_title}`,
    `- **Tags**: ${classification.tags.join(", ") || "none"}`,
    `- **Filed to**: [[${notePath}]]`,
    ...(rawInput ? [`- **Raw input**: ${rawInput.slice(0, 200)}${rawInput.length > 200 ? "..." : ""}`] : []),
    "",
  ].join("\n");

  // Check if file exists; if not, write header first
  try {
    await fs.access(absPath);
  } catch {
    const header = `---\ntype: audit-log\ncreated: ${timestamp}\n---\n\n# Classification Log\n\n`;
    await fs.writeFile(absPath, header, "utf-8");
  }

  // Atomic append — no read-modify-write race
  await fs.appendFile(absPath, entry, "utf-8");
}
