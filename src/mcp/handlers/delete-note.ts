import { VaultErrorCode } from "../../utils/errors.js";
import type { SyncTracker, VaultServices } from "../../vault/manager.js";
import { errorResult, successResult, type ToolResult } from "../format.js";
import { trackDelete } from "./sync-tracking.js";

export async function handleVaultDeleteNote(
  args: { path: string; trash: boolean; confirm?: true | undefined; vault?: string | undefined },
  services: VaultServices,
  syncTracker: SyncTracker,
): Promise<ToolResult> {
  const { vault, vaultSync } = services;

  if (args.trash === false && args.confirm !== true) {
    return errorResult(
      VaultErrorCode.CONFIRMATION_REQUIRED,
      "Permanent deletion requires confirm=true. This operation is IRREVERSIBLE. " +
        "Set trash=true to move to .trash/ instead.",
    );
  }

  if (args.trash) {
    const result = await vault.softDeleteNote(args.path);
    if (!result.ok) {
      return errorResult(VaultErrorCode.NOT_FOUND, result.message ?? "Note not found");
    }
    if (vaultSync) trackDelete(syncTracker, vaultSync, result.path, "delete sync failed");
    return successResult({ ok: result.ok, path: result.path, trashName: result.trashName, message: result.message });
  }

  const result = await vault.deleteNote(args.path);
  if (vaultSync && result.ok) {
    const canonical = args.path.endsWith(".md") ? args.path : `${args.path}.md`;
    trackDelete(syncTracker, vaultSync, canonical, "delete sync failed");
  }
  if (!result.ok) {
    return errorResult(VaultErrorCode.NOT_FOUND, result.message ?? "Note not found");
  }
  return successResult(result);
}
