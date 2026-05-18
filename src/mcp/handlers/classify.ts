import type { ClassifyRules } from "../../config.js";
import type { VaultServices } from "../../vault/manager.js";
import { classify } from "../classify.js";
import { successResult, type ToolResult } from "../format.js";

export async function handleVaultClassify(
  args: { text: string; vault?: string | undefined },
  _services: VaultServices,
  classifyRules: ClassifyRules | undefined,
): Promise<ToolResult> {
  const result = classify(args.text, classifyRules);
  return successResult(result);
}
