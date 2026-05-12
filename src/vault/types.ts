export interface VaultFrontmatter {
  type?: string;
  category?: string;
  confidence?: number;
  status?: string;
  source?: string;
  created?: string;
  tags?: string[];
  [key: string]: unknown;
}

export interface AclConfig {
  allowPaths: string[];
  denyPaths: string[];
}

export interface VaultRepositoryOptions {
  vaultPath: string;
  acl?: AclConfig;
}

export interface VaultNote {
  path: string;
  absPath: string;
  name: string;
  content: string;
  frontmatter: VaultFrontmatter;
  raw: string;
  createdAt: number;
  updatedAt: number;
}

export interface VaultOperationResult {
  ok: boolean;
  path: string;
  message?: string;
  note?: VaultNote;
}

export interface WriteNoteInput {
  content: string;
  frontmatter?: VaultFrontmatter;
}

export interface ListFolderOptions {
  recursive?: boolean;
  limit?: number;
  modifiedAfter?: number; // epoch ms — only return notes with updatedAt >= this
}

export interface SearchOptions {
  limit?: number;
  folder?: string;
}

export interface VaultNoteSummary {
  path: string;
  name: string;
  frontmatter: VaultFrontmatter;
  createdAt: number;
  updatedAt: number;
}
