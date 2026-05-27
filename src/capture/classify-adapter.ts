import { VAULT_FOLDERS, type VaultFolders } from "../config/folders.js";
import { classify } from "./classify.js";
import type { CaptureClassification } from "./types.js";

export function classifyWithHeuristic(text: string, folders: VaultFolders = VAULT_FOLDERS): CaptureClassification {
  const result = classify(text, undefined, folders);
  return {
    category: result.category,
    confidence: result.confidence,
    suggested_title: result.suggested_title,
    tags: result.tags,
    properties: {},
    sensitivity: "low",
  };
}
