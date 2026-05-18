import type { VaultServices } from "../../vault/manager.js";
import { listResult, type ToolResult } from "../format.js";

export async function handleVaultListFolder(
  args: {
    folder: string;
    recursive?: boolean | undefined;
    limit?: number | undefined;
    offset?: number | undefined;
    modified_after?: string | undefined;
    vault?: string | undefined;
  },
  services: VaultServices,
): Promise<ToolResult> {
  const { vault, searchStore } = services;
  const offset = args.offset ?? 0;
  const limit = args.limit ?? 100;
  const modifiedAfterMs = args.modified_after ? new Date(args.modified_after).getTime() : undefined;
  const results = await vault.listFolderPage(args.folder, {
    ...(args.recursive !== undefined ? { recursive: args.recursive } : {}),
    limit,
    offset,
    ...(modifiedAfterMs !== undefined && !Number.isNaN(modifiedAfterMs) ? { modifiedAfter: modifiedAfterMs } : {}),
  });
  const enriched = searchStore
    ? (() => {
        const entries = searchStore.getBatchByPaths(results.items.map((note) => note.path));
        return results.items.map((note) => {
          const entry = entries.get(note.path);
          if (!entry) return note;
          return {
            ...note,
            tags: entry.metadata?.["tags"],
            type: entry.metadata?.["type"],
            createdAt: entry.createdAt,
          };
        });
      })()
    : results.items;
  return listResult(enriched, { kind: "knownTotal", total: results.total, offset, limit });
}
