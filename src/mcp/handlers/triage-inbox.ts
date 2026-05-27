import type { VaultFolders } from "../../config/folders.js";
import { triageInbox } from "../../triage/inbox.js";
import { VaultErrorCode } from "../../utils/errors.js";
import type { VaultServices } from "../../vault/manager.js";
import { errorResult, successResult, type ToolResult } from "../format.js";

export async function handleVaultTriageInbox(
  args: {
    dry_run: boolean;
    auto_move_threshold: number;
    suggest_threshold: number;
    inbox_folder: string;
    vault?: string | undefined;
  },
  services: VaultServices,
  folders: VaultFolders,
): Promise<ToolResult> {
  const { vault, vaultSync } = services;
  const autoMoveThreshold = args.auto_move_threshold;
  const suggestThreshold = args.suggest_threshold;
  if (suggestThreshold >= autoMoveThreshold) {
    return errorResult(
      VaultErrorCode.VALIDATION,
      "suggest_threshold must be less than auto_move_threshold so suggestions do not overlap auto-moves",
    );
  }
  const result = await triageInbox({
    vault,
    vaultSync,
    acl: services.aclConfig,
    autoMoveThreshold,
    suggestThreshold,
    inboxFolder: args.inbox_folder,
    dryRun: args.dry_run,
    folders,
  });
  return successResult(result);
}
