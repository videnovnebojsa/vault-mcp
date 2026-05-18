import { successResult, type ToolResult } from "../format.js";

export async function handleVaultListVaults(
  _args: Record<string, unknown>,
  vaults: Array<{ name: string }>,
): Promise<ToolResult> {
  return successResult({ vaults });
}
