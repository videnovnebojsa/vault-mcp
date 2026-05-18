import type {
  ListFolderOptions,
  ListFolderPage,
  SearchOptions,
  VaultNote,
  VaultNoteSummary,
  VaultOperationResult,
  WriteNoteInput,
} from "./types.js";

export interface WikilinkSearchIndex {
  searchFTS(query: string, limit: number): Array<{ path: string }>;
}

export interface IVaultRepository {
  readonly vaultPath: string;
  readNote(notePath: string): Promise<VaultNote>;
  writeNote(notePath: string, input: WriteNoteInput): Promise<VaultOperationResult>;
  moveNote(oldPath: string, newPath: string, overwrite?: boolean): Promise<VaultOperationResult>;
  deleteNote(notePath: string): Promise<VaultOperationResult>;
  softDeleteNote(notePath: string): Promise<VaultOperationResult & { trashName: string }>;
  updateProperties(notePath: string, props: Record<string, unknown>): Promise<VaultOperationResult>;
  updateWikilinks(
    oldPath: string,
    newPath: string,
    searchStore?: WikilinkSearchIndex,
  ): Promise<{ updated: number; errors: string[] }>;
  listFolder(folder: string, opts?: ListFolderOptions): Promise<VaultNoteSummary[]>;
  listFolderPage(folder: string, opts?: ListFolderOptions): Promise<ListFolderPage>;
  searchByPathOrName(query: string, opts?: SearchOptions): Promise<VaultNoteSummary[]>;
}
