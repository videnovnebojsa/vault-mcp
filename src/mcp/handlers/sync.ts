import { VaultErrorCode } from "../../utils/errors.js";
import type { VaultServices } from "../../vault/manager.js";
import { errorResult, successResult, type ToolResult } from "../format.js";

export async function handleVaultSync(
  _args: { vault?: string | undefined },
  services: VaultServices,
): Promise<ToolResult> {
  const { vaultSync } = services;
  if (vaultSync.isSyncing()) {
    return errorResult(VaultErrorCode.ALREADY_RUNNING, "Sync already in progress");
  }
  const result = await vaultSync.runFullSync();
  return successResult(result);
}
