import path, { resolve } from "node:path";
import { runBackupTask } from "../../search/tasks.js";
import { VaultErrorCode } from "../../utils/errors.js";
import type { VaultServices } from "../../vault/manager.js";
import { errorResult, successResult, type ToolResult } from "../format.js";

export async function handleVaultBackupDb(
  args: { vault?: string | undefined },
  services: VaultServices,
  backupConfig: { enabled: boolean; dir: string; maxBackups: number; alertWebhookUrl?: string | undefined },
): Promise<ToolResult> {
  const { searchStore } = services;
  if (!backupConfig.enabled) {
    return errorResult(VaultErrorCode.NOT_ENABLED, "Backup is not enabled");
  }
  if (!searchStore) {
    return errorResult(VaultErrorCode.STORE_UNAVAILABLE, "Search index not available");
  }
  const resolvedVault = args.vault ?? "default";
  const backupDir = path.join(backupConfig.dir, resolvedVault);
  const resolvedBackupDir = resolve(backupDir);
  const resolvedBase = resolve(backupConfig.dir);
  if (resolvedBackupDir !== resolvedBase && !resolvedBackupDir.startsWith(resolvedBase + path.sep)) {
    return errorResult(VaultErrorCode.VALIDATION, "Backup path escapes backup directory");
  }
  const result = await runBackupTask({
    searchStore,
    backupDir,
    maxBackups: backupConfig.maxBackups,
    ...(backupConfig.alertWebhookUrl !== undefined ? { alertWebhookUrl: backupConfig.alertWebhookUrl } : {}),
  });
  if (!result.ok) {
    return errorResult(VaultErrorCode.INTERNAL_ERROR, result.message ?? "Backup failed");
  }
  const { outputPath: _outputPath, ...safeResult } = result;
  const outputFile = result.outputPath ? path.basename(result.outputPath) : undefined;
  return successResult(outputFile ? { ...safeResult, outputFile } : safeResult);
}
