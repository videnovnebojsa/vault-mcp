const CATEGORY_FOLDERS: Record<string, string> = {
  person: "80_People",
  project: "10_Projects",
  idea: "30_Zettelkasten",
  admin: "90_Admin",
  unknown: "00_Inbox",
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
  const targetFolder = folder ?? CATEGORY_FOLDERS[category] ?? "00_Inbox";
  const safe = sanitizeFilename(title) || "untitled";
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `${targetFolder}/${safe}-${ts}.md`;
}

export function buildAuditLogPath(): string {
  const date = new Date().toISOString().slice(0, 10);
  return `70_AI_Logs/classifications/${date}-classifications.md`;
}
