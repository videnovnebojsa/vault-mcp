import { runEmbedBacklogTask } from "../../search/tasks.js";
import { VaultErrorCode } from "../../utils/errors.js";
import type { VaultServices } from "../../vault/manager.js";
import { errorResult, successResult, type ToolResult } from "../format.js";

export async function handleVaultEmbedBacklog(
  args: { max_notes?: number | undefined; vault?: string | undefined },
  services: VaultServices,
): Promise<ToolResult> {
  const { embeddingStore, embedProvider, searchStore, embeddingConfig } = services;
  if (!embeddingStore || !embedProvider || !searchStore || !embeddingConfig?.enabled) {
    return errorResult(VaultErrorCode.NOT_ENABLED, "Embeddings not enabled — set ENABLE_EMBEDDINGS=true");
  }
  const result = await runEmbedBacklogTask({
    searchStore,
    embeddingStore,
    embedProvider,
    batchSize: embeddingConfig.batchSize,
    ...(args.max_notes !== undefined ? { maxNotes: args.max_notes } : {}),
  });
  if (!result.ok) {
    return errorResult(VaultErrorCode.INTERNAL_ERROR, result.message ?? "Embed backlog failed");
  }
  return successResult(result);
}
