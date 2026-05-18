import { logger } from "../../utils/logger.js";
import type { SyncTracker, VaultServices } from "../../vault/manager.js";

export function trackDelete(
  syncTracker: SyncTracker,
  vaultSync: Pick<VaultServices["vaultSync"], "handleDelete">,
  path: string,
  logMessage: string,
): void {
  syncTracker.trackSync(
    Promise.resolve()
      .then(() => {
        vaultSync.handleDelete(path);
      })
      .catch((err: unknown) =>
        logger.error("tools", logMessage, {
          err: err instanceof Error ? err.message : String(err),
        }),
      ),
  );
}
