import type { IVaultRepository } from "./repository-interface.js";
import type {
  ListFolderOptions,
  SearchOptions,
  VaultNote,
  VaultNoteSummary,
  VaultOperationResult,
  WriteNoteInput,
} from "./types.js";

/** In-memory implementation of IVaultRepository for tests. */
export class MockVaultRepository implements IVaultRepository {
  readonly vaultPath: string;
  private readonly notes = new Map<string, VaultNote>();

  constructor(vaultPath = "/mock-vault") {
    this.vaultPath = vaultPath;
  }

  seedNote(note: VaultNote): void {
    this.notes.set(note.path, note);
  }

  async readNote(notePath: string): Promise<VaultNote> {
    const normalized = notePath.endsWith(".md") ? notePath : `${notePath}.md`;
    const note = this.notes.get(normalized) ?? this.notes.get(notePath);
    if (!note) throw new Error(`Note not found: ${notePath}`);
    return note;
  }

  async writeNote(notePath: string, input: WriteNoteInput): Promise<VaultOperationResult> {
    const path = notePath.endsWith(".md") ? notePath : `${notePath}.md`;
    const note: VaultNote = {
      path,
      absPath: `${this.vaultPath}/${path}`,
      name: path.split("/").pop() ?? path,
      content: input.content,
      frontmatter: input.frontmatter ?? {},
      raw: input.content,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.notes.set(path, note);
    return { ok: true, path, message: "Note written successfully", note };
  }

  async moveNote(oldPath: string, newPath: string, overwrite = false): Promise<VaultOperationResult> {
    const normalOld = oldPath.endsWith(".md") ? oldPath : `${oldPath}.md`;
    const normalNew = newPath.endsWith(".md") ? newPath : `${newPath}.md`;
    const note = this.notes.get(normalOld);
    if (!note) return { ok: false, path: normalOld, message: "Source note does not exist" };
    if (!overwrite && this.notes.has(normalNew))
      return { ok: false, path: normalNew, message: "Destination already exists" };
    this.notes.delete(normalOld);
    const moved = { ...note, path: normalNew };
    this.notes.set(normalNew, moved);
    return { ok: true, path: normalNew, message: `Moved ${normalOld} → ${normalNew}` };
  }

  async deleteNote(notePath: string): Promise<VaultOperationResult> {
    const path = notePath.endsWith(".md") ? notePath : `${notePath}.md`;
    const existed = this.notes.delete(path);
    if (!existed) return { ok: false, path, message: "Note does not exist or cannot be deleted" };
    return { ok: true, path, message: "Note deleted" };
  }

  async softDeleteNote(notePath: string): Promise<VaultOperationResult & { trashName: string }> {
    const path = notePath.endsWith(".md") ? notePath : `${notePath}.md`;
    const existed = this.notes.delete(path);
    if (!existed) return { ok: false, path, message: "Note does not exist or cannot be moved to trash", trashName: "" };
    const trashName = `${path.replace(/[\\/]/g, "_")}`;
    return { ok: true, path, message: `Moved to .trash/${trashName}`, trashName };
  }

  async updateProperties(notePath: string, props: Record<string, unknown>): Promise<VaultOperationResult> {
    const path = notePath.endsWith(".md") ? notePath : `${notePath}.md`;
    const note = this.notes.get(path);
    if (!note) return { ok: false, path, message: "Note not found" };
    const updated = { ...note, frontmatter: { ...note.frontmatter, ...props } };
    this.notes.set(path, updated);
    return { ok: true, path, message: "Properties updated", note: updated };
  }

  async updateWikilinks(
    _oldPath: string,
    _newPath: string,
    _searchStore?: { searchFTS(query: string, limit: number): Array<{ path: string }> },
  ): Promise<{ updated: number; errors: string[] }> {
    return { updated: 0, errors: [] };
  }

  async listFolder(_folder: string, opts?: ListFolderOptions): Promise<VaultNoteSummary[]> {
    return (await this.listFolderPage(_folder, opts)).items;
  }

  async listFolderPage(
    folder: string,
    opts?: ListFolderOptions,
  ): Promise<{ items: VaultNoteSummary[]; total: number }> {
    const limit = opts?.limit ?? 200;
    const offset = opts?.offset ?? 0;
    const prefix = folder === "." || folder === "" ? "" : folder.endsWith("/") ? folder : `${folder}/`;
    const values = [...this.notes.values()].filter((n) => {
      if (prefix && !n.path.startsWith(prefix)) return false;
      if (opts?.recursive === false) {
        const rest = prefix ? n.path.slice(prefix.length) : n.path;
        if (rest.includes("/")) return false;
      }
      if (opts?.modifiedAfter !== undefined && n.updatedAt < opts.modifiedAfter) return false;
      return true;
    });
    return {
      items: values.slice(offset, offset + limit).map((n) => ({
        path: n.path,
        name: n.name,
        frontmatter: n.frontmatter,
        createdAt: n.createdAt,
        updatedAt: n.updatedAt,
      })),
      total: values.length,
    };
  }

  async searchByPathOrName(query: string, opts?: SearchOptions): Promise<VaultNoteSummary[]> {
    const limit = opts?.limit ?? 20;
    const lq = query.toLowerCase();
    return [...this.notes.values()]
      .filter((n) => n.path.toLowerCase().includes(lq) || n.name.toLowerCase().includes(lq))
      .slice(0, limit)
      .map((n) => ({
        path: n.path,
        name: n.name,
        frontmatter: n.frontmatter,
        createdAt: n.createdAt,
        updatedAt: n.updatedAt,
      }));
  }
}
