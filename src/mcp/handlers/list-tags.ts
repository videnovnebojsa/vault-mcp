import { VaultErrorCode } from "../../utils/errors.js";
import type { VaultServices } from "../../vault/manager.js";
import { errorResult, listResult, type ToolResult } from "../format.js";

export async function handleVaultListTags(
  args: { limit?: number | undefined; offset?: number | undefined; vault?: string | undefined },
  services: VaultServices,
): Promise<ToolResult> {
  const { searchStore, aclConfig } = services;
  if (!searchStore) {
    return errorResult(VaultErrorCode.STORE_UNAVAILABLE, "Search index not available");
  }
  const offset = args.offset ?? 0;
  const limit = args.limit ?? 50;
  const page = searchStore.listTagsPage(limit, offset, aclConfig);
  return listResult(page.items, { kind: "knownTotal", total: page.total, offset, limit });
}
