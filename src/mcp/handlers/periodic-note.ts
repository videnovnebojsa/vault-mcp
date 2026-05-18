import { VaultError, VaultErrorCode } from "../../utils/errors.js";
import { logger } from "../../utils/logger.js";
import type { SyncTracker, VaultServices } from "../../vault/manager.js";
import type { Period } from "../../vault/periodic.js";
import { buildPeriodicPath, openOrCreatePeriodicNote } from "../../vault/periodic.js";
import { errorResult, successResult, type ToolResult, toClientNote } from "../format.js";

export async function handleVaultPeriodicNote(
  args: {
    period: string;
    date?: string | undefined;
    create_if_missing: boolean;
    vault?: string | undefined;
  },
  services: VaultServices,
  syncTracker: SyncTracker,
  periodicNotesRoot: string,
): Promise<ToolResult> {
  const { vault, vaultSync } = services;
  const d = args.date ? new Date(args.date) : new Date();
  const root = periodicNotesRoot;
  const createIfMissing = args.create_if_missing;

  if (!createIfMissing) {
    const notePath = buildPeriodicPath(args.period as Period, d, root).replace(/\.md$/, "");
    try {
      const note = await vault.readNote(notePath);
      return successResult(toClientNote(note));
    } catch (err) {
      if (err instanceof VaultError && err.code === VaultErrorCode.NOT_FOUND) {
        const dateStr = d.toISOString().slice(0, 10);
        return errorResult(
          VaultErrorCode.NOT_FOUND,
          `No ${args.period} note for ${dateStr} — pass create_if_missing=true to create it`,
        );
      }
      throw err;
    }
  }

  const note = await openOrCreatePeriodicNote(vault, args.period as Period, d, root);
  if (vaultSync) {
    syncTracker.trackSync(
      vaultSync.handleUpsert(note.path).catch((err) =>
        logger.error("tools", "sync index update failed", {
          err: err instanceof Error ? err.message : String(err),
        }),
      ),
    );
  }
  return successResult(toClientNote(note));
}
