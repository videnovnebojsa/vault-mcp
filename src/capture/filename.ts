import { VAULT_FOLDERS, type VaultFolders } from "../config/folders.js";

// Memoize by object reference — the same VaultFolders instance is reused across
// all captures in a single boot, so we avoid re-allocating on every call.
let _memoFolders: VaultFolders | undefined;
let _memoCategoryMap: Record<string, string> | undefined;

function buildCategoryFolders(folders: VaultFolders): Record<string, string> {
  if (folders !== _memoFolders || !_memoCategoryMap) {
    _memoFolders = folders;
    _memoCategoryMap = {
      person: folders.PEOPLE,
      project: folders.PROJECTS,
      idea: folders.ZETTELKASTEN,
      admin: folders.ADMIN,
      unknown: folders.INBOX,
    };
  }
  return _memoCategoryMap;
}

export function sanitizeFilename(title: string): string {
  return title
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80)
    .toLowerCase();
}

export function buildCapturePath(
  category: string,
  title: string,
  folders: VaultFolders = VAULT_FOLDERS,
  folder?: string,
): string {
  const categoryFolders = buildCategoryFolders(folders);
  const targetFolder = folder ?? categoryFolders[category] ?? folders.INBOX;
  const safe = sanitizeFilename(title) || "untitled";
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `${targetFolder}/${safe}-${ts}.md`;
}

export function buildAuditLogPath(folders: VaultFolders = VAULT_FOLDERS): string {
  const date = new Date().toISOString().slice(0, 10);
  return `${folders.AI_LOGS}/classifications/${date}-classifications.md`;
}
