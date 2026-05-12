import { classify } from "../mcp/classify.js";
import type { CaptureClassification } from "./types.js";

export function classifyWithHeuristic(text: string): CaptureClassification {
  const result = classify(text);
  return {
    category: result.category,
    confidence: result.confidence,
    suggested_title: result.suggested_title,
    tags: result.tags,
    properties: {},
    sensitivity: "low",
  };
}
