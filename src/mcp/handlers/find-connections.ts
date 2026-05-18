import { findConnections } from "../../search/connections.js";
import { VaultErrorCode } from "../../utils/errors.js";
import type { VaultServices } from "../../vault/manager.js";
import { errorResult, successResult, type ToolResult } from "../format.js";

export async function handleVaultFindConnections(
  args: {
    path?: string | undefined;
    limit?: number | undefined;
    min_similarity?: number | undefined;
    vault?: string | undefined;
  },
  services: VaultServices,
): Promise<ToolResult> {
  const { embeddingStore, embedProvider, searchStore } = services;
  if (!embeddingStore || !embedProvider || !searchStore) {
    return errorResult(VaultErrorCode.NOT_ENABLED, "Embeddings not enabled — set ENABLE_EMBEDDINGS=true");
  }
  const suggestions = await findConnections({
    ...(args.path !== undefined ? { notePath: args.path } : {}),
    limit: args.limit ?? 5,
    minSimilarity: args.min_similarity ?? 0.75,
    searchStore,
    embeddingStore,
    embedProvider,
  });
  return successResult({ count: suggestions.length, suggestions });
}
