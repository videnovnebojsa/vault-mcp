import { classify } from "../../capture/classify.js";
import type { VaultFolders } from "../../config/folders.js";
import type { ClassifyRules } from "../../config.js";
import type { VaultServices } from "../../vault/manager.js";
import { successResult, type ToolResult } from "../format.js";

export async function handleVaultClassify(
  args: { text: string; vault?: string | undefined },
  _services: VaultServices,
  classifyRules: ClassifyRules | undefined,
  folders: VaultFolders,
): Promise<ToolResult> {
  const result = classify(args.text, classifyRules, folders);
  return successResult(result);
}
