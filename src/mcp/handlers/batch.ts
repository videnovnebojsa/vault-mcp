import { VaultError, VaultErrorCode } from "../../utils/errors.js";
import { logger } from "../../utils/logger.js";
import { beginSpan } from "../../utils/span.js";
import type { SyncTracker, VaultServices } from "../../vault/manager.js";
import { successResult, type ToolResult } from "../format.js";
import { trackDelete } from "./sync-tracking.js";

export interface BatchOperation {
  type: "move" | "delete" | "update_properties";
  path: string;
  to_path?: string | undefined;
  properties?: Record<string, unknown> | undefined;
  trash?: boolean | undefined;
  confirm?: true | undefined;
}

interface BatchOperationResult {
  type: string;
  ok: boolean;
  path: string;
  message?: string;
  code?: string;
  backlinksUpdated?: number;
}

export async function handleVaultBatch(
  args: { operations: BatchOperation[]; continue_on_error?: boolean | undefined; vault?: string | undefined },
  services: VaultServices,
  syncTracker: SyncTracker,
): Promise<ToolResult> {
  const { vault, vaultSync, searchStore } = services;
  const results: BatchOperationResult[] = [];

  for (const op of args.operations) {
    const span = beginSpan(`vault_batch.${op.type}`, args.vault ?? "default");
    let spanError: Error | undefined;
    try {
      if (op.type === "move") {
        if (!op.to_path) {
          const message = "to_path is required for move";
          spanError = new Error(message);
          results.push({ type: op.type, ok: false, path: op.path, message, code: VaultErrorCode.VALIDATION });
          if (!args.continue_on_error) break;
          continue;
        }
        const result = await vault.moveNote(op.path, op.to_path, op.confirm === true);
        if (result.ok && vaultSync) {
          syncTracker.trackSync(
            vaultSync
              .handleRename(
                op.path.endsWith(".md") ? op.path : `${op.path}.md`,
                op.to_path.endsWith(".md") ? op.to_path : `${op.to_path}.md`,
              )
              .catch((err: unknown) =>
                logger.error("tools", "vault_batch rename sync failed", {
                  err: err instanceof Error ? err.message : String(err),
                }),
              ),
          );
        }
        let backlinksUpdated = 0;
        if (result.ok) {
          const { updated, errors } = await vault.updateWikilinks(
            op.path.replace(/\.md$/, ""),
            op.to_path.replace(/\.md$/, ""),
            searchStore,
          );
          backlinksUpdated = updated;
          if (errors.length > 0) {
            logger.warn("tools", "vault_batch move: some wikilink updates failed", { errors });
          }
        }
        results.push({
          type: op.type,
          ok: result.ok,
          path: result.path,
          ...(!result.ok ? { code: classifyMoveFailure(result.message) } : {}),
          ...(result.ok ? { backlinksUpdated } : {}),
          ...(result.message ? { message: result.message } : {}),
        });
      } else if (op.type === "delete") {
        const useTrash = op.trash !== false;
        if (useTrash) {
          const result = await vault.softDeleteNote(op.path);
          if (result.ok && vaultSync) {
            trackDelete(syncTracker, vaultSync, result.path, "vault_batch delete sync failed");
          }
          results.push({
            type: op.type,
            ok: result.ok,
            path: result.path,
            ...(!result.ok ? { code: VaultErrorCode.NOT_FOUND } : {}),
            ...(result.message ? { message: result.message } : {}),
          });
        } else {
          if (op.confirm !== true) {
            const message =
              "Permanent deletion requires confirm=true. This operation is IRREVERSIBLE. " +
              "Set trash=true to move to .trash/ instead.";
            spanError = new Error(message);
            results.push({
              type: op.type,
              ok: false,
              path: op.path,
              message,
              code: VaultErrorCode.CONFIRMATION_REQUIRED,
            });
            if (!args.continue_on_error) break;
            continue;
          }
          const result = await vault.deleteNote(op.path);
          if (result.ok && vaultSync) {
            trackDelete(
              syncTracker,
              vaultSync,
              op.path.endsWith(".md") ? op.path : `${op.path}.md`,
              "vault_batch delete sync failed",
            );
          }
          results.push({
            type: op.type,
            ok: result.ok,
            path: result.path,
            ...(!result.ok ? { code: VaultErrorCode.NOT_FOUND } : {}),
            ...(result.message ? { message: result.message } : {}),
          });
        }
      } else if (op.type === "update_properties") {
        if (!op.properties) {
          const message = "properties is required for update_properties";
          spanError = new Error(message);
          results.push({
            type: op.type,
            ok: false,
            path: op.path,
            message,
            code: VaultErrorCode.VALIDATION,
          });
          if (!args.continue_on_error) break;
          continue;
        }
        const result = await vault.updateProperties(op.path, op.properties);
        if (result.ok && vaultSync) {
          syncTracker.trackSync(
            vaultSync.handleUpsert(result.path).catch((err: unknown) =>
              logger.error("tools", "vault_batch upsert sync failed", {
                err: err instanceof Error ? err.message : String(err),
              }),
            ),
          );
        }
        results.push({
          type: op.type,
          ok: result.ok,
          path: result.path,
          ...(!result.ok ? { code: classifyUpdatePropertiesFailure(result.message) } : {}),
          ...(result.message ? { message: result.message } : {}),
        });
      } else {
        const message = `Unknown batch operation type: ${op.type}`;
        spanError = new Error(message);
        results.push({ type: op.type, ok: false, path: op.path, message, code: VaultErrorCode.VALIDATION });
        if (!args.continue_on_error) break;
      }
      const last = results[results.length - 1];
      if (last && !last.ok) {
        spanError = new Error(last.message ?? `${op.type} failed`);
        if (!args.continue_on_error) break;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      spanError = err instanceof Error ? err : new Error(message);
      results.push({
        type: op.type as string,
        ok: false,
        path: op.path as string,
        message,
        code: err instanceof VaultError ? err.code : VaultErrorCode.INTERNAL_ERROR,
      });
      if (!args.continue_on_error) break;
    } finally {
      span.end(spanError);
    }
  }
  return successResult({ operations: results, processedCount: results.length });
}

function classifyMoveFailure(message: string | undefined): VaultErrorCode {
  if (message?.includes("already exists")) return VaultErrorCode.CONFIRMATION_REQUIRED;
  return VaultErrorCode.NOT_FOUND;
}

function classifyUpdatePropertiesFailure(message: string | undefined): VaultErrorCode {
  if (message?.toLowerCase().includes("not found")) return VaultErrorCode.NOT_FOUND;
  return VaultErrorCode.INTERNAL_ERROR;
}
