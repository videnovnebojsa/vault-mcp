import { VAULT_FOLDERS } from "../config/folders.js";

const CATEGORY_FOLDERS: Record<string, string> = {
  person: VAULT_FOLDERS.PEOPLE,
  project: VAULT_FOLDERS.PROJECTS,
  idea: VAULT_FOLDERS.ZETTELKASTEN,
  admin: VAULT_FOLDERS.ADMIN,
  unknown: VAULT_FOLDERS.INBOX,
};

export function sanitizeFilename(title: string): string {
  return title
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80)
    .toLowerCase();
}

export function buildCapturePath(category: string, title: string, folder?: string): string {
  const targetFolder = folder ?? CATEGORY_FOLDERS[category] ?? VAULT_FOLDERS.INBOX;
  const safe = sanitizeFilename(title) || "untitled";
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `${targetFolder}/${safe}-${ts}.md`;
}

export function buildAuditLogPath(): string {
  const date = new Date().toISOString().slice(0, 10);
  return `${VAULT_FOLDERS.AI_LOGS}/classifications/${date}-classifications.md`;
}
