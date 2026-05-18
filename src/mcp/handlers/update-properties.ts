import { VaultError, VaultErrorCode } from "../../utils/errors.js";
import { logger } from "../../utils/logger.js";
import type { SyncTracker, VaultServices } from "../../vault/manager.js";
import { successResult, type ToolResult } from "../format.js";

export async function handleVaultUpdateProperties(
  args: { path: string; properties: Record<string, unknown>; vault?: string | undefined },
  services: VaultServices,
  syncTracker: SyncTracker,
): Promise<ToolResult> {
  const { vault, vaultSync } = services;
  const result = await vault.updateProperties(args.path, args.properties);
  if (!result.ok) {
    throw new VaultError(result.message ?? "Update properties failed", VaultErrorCode.INTERNAL_ERROR);
  }
  if (vaultSync && result.ok && result.path) {
    syncTracker.trackSync(
      vaultSync.handleUpsert(result.path).catch((err) =>
        logger.error("tools", "sync index update failed", {
          err: err instanceof Error ? err.message : String(err),
        }),
      ),
    );
  }
  return successResult(result);
}
