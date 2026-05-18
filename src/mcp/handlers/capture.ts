import { VaultErrorCode } from "../../utils/errors.js";
import { logger } from "../../utils/logger.js";
import type { SyncTracker, VaultServices } from "../../vault/manager.js";
import { errorResult, successResult, type ToolResult } from "../format.js";

export async function handleVaultCapture(
  args: { text: string; vault?: string | undefined },
  services: VaultServices,
  syncTracker: SyncTracker,
): Promise<ToolResult> {
  const { capture, vaultSync } = services;
  if (!capture) {
    return errorResult(VaultErrorCode.NOT_ENABLED, "Capture pipeline is disabled — set ENABLE_CAPTURE_PIPELINE=true");
  }
  const result = await capture.processCapture(args.text);
  if (vaultSync && result.ok && result.notePath) {
    syncTracker.trackSync(
      vaultSync.handleUpsert(result.notePath).catch((err) =>
        logger.error("tools", "sync index update failed", {
          err: err instanceof Error ? err.message : String(err),
        }),
      ),
    );
  }
  if (!result.ok) {
    return errorResult(VaultErrorCode.INTERNAL_ERROR, result.message ?? "Capture failed");
  }
  const { notePath, ...clientResult } = result;
  return successResult({
    ...clientResult,
    ...(notePath !== undefined ? { path: notePath } : {}),
  });
}
