import { VaultErrorCode } from "../../utils/errors.js";
import { logger } from "../../utils/logger.js";
import type { SyncTracker, VaultServices } from "../../vault/manager.js";
import { errorResult, successResult, type ToolResult } from "../format.js";

export async function handleVaultMoveNote(
  args: {
    from_path: string;
    to_path: string;
    update_backlinks: boolean;
    confirm?: true | undefined;
    vault?: string | undefined;
  },
  services: VaultServices,
  syncTracker: SyncTracker,
): Promise<ToolResult> {
  const { vault, vaultSync, searchStore } = services;
  const result = await vault.moveNote(args.from_path, args.to_path, args.confirm === true);
  if (!result.ok) {
    const code = result.message?.includes("already exists")
      ? VaultErrorCode.CONFIRMATION_REQUIRED
      : VaultErrorCode.NOT_FOUND;
    const message =
      code === VaultErrorCode.CONFIRMATION_REQUIRED
        ? `Destination already exists — pass confirm: true to overwrite`
        : (result.message ?? "Move failed");
    return errorResult(code, message);
  }

  if (vaultSync) {
    syncTracker.trackSync(
      vaultSync
        .handleRename(`${args.from_path.replace(/\.md$/, "")}.md`, `${args.to_path.replace(/\.md$/, "")}.md`)
        .catch((err) =>
          logger.error("tools", "sync index update failed", {
            err: err instanceof Error ? err.message : String(err),
          }),
        ),
    );
  }

  let backlinksUpdated = 0;
  if (args.update_backlinks) {
    const { updated, errors } = await vault.updateWikilinks(
      args.from_path.replace(/\.md$/, ""),
      args.to_path.replace(/\.md$/, ""),
      searchStore,
    );
    backlinksUpdated = updated;
    if (errors.length > 0) {
      logger.warn("tools", "vault_move_note: some wikilink updates failed", { errors });
    }
  }

  return successResult({ ...result, backlinksUpdated });
}
