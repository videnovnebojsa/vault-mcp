export interface VaultEntry {
  canonicalPath: string;
  content: string;
  contentHash: string;
  fileName: string;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface SearchResult {
  path: string;
  name: string;
  score: number;
  snippet: string;
  frontmatter: Record<string, unknown>;
}

export interface VaultSyncResult {
  scanned: number;
  upserted: number;
  skippedUnchanged: number;
  deletedStale: number;
  durationMs: number;
}
