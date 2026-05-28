import { VaultError, VaultErrorCode } from "../../utils/errors.js";
import { logger } from "../../utils/logger.js";
import type { SyncTracker, VaultServices } from "../../vault/manager.js";
import type { VaultFrontmatter } from "../../vault/types.js";
import { successResult, type ToolResult, toClientNote } from "../format.js";

export async function handleVaultWriteNote(
  args: {
    path: string;
    content: string;
    frontmatter?: Record<string, unknown> | undefined;
    vault?: string | undefined;
  },
  services: VaultServices,
  syncTracker: SyncTracker,
): Promise<ToolResult> {
  const { vault, vaultSync } = services;
  const result = await vault.writeNote(args.path, {
    content: args.content,
    ...(args.frontmatter !== undefined ? { frontmatter: args.frontmatter as VaultFrontmatter } : {}),
  });
  if (!result.ok) {
    throw new VaultError(result.message ?? "Write failed", VaultErrorCode.INTERNAL_ERROR);
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
  return successResult(result.note ? { ...result, note: toClientNote(result.note) } : result);
}
