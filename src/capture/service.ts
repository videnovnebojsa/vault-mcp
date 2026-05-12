import type { VaultRepository } from "../vault/repository.js";
import { appendClassificationLog } from "./audit-log.js";
import { classifyWithHeuristic } from "./classify-adapter.js";
import { buildCapturePath } from "./filename.js";
import type { CaptureClassification, CaptureResult, SecondBrainConfig } from "./types.js";

const CAPTURE_PREFIX = /^\/capture\s+/i;
const VALID_CATEGORIES = new Set(["person", "project", "idea", "admin", "unknown"]);

function sanitizeClassification(c: CaptureClassification): CaptureClassification {
  if (!VALID_CATEGORIES.has(c.category)) {
    return { ...c, category: "unknown", confidence: Math.min(c.confidence, 0.5) };
  }
  return c;
}

export class SecondBrainService {
  constructor(
    private readonly config: SecondBrainConfig,
    private readonly vault: VaultRepository,
  ) {}

  async processCapture(text: string): Promise<CaptureResult> {
    if (!this.config.enableCapturePipeline) {
      return { ok: false, message: "Capture pipeline is disabled" };
    }

    const content = CAPTURE_PREFIX.test(text) ? text.replace(CAPTURE_PREFIX, "").trim() : text.trim();
    if (!content) {
      return { ok: false, message: "Empty capture content" };
    }

    // Classify via heuristic (LLM classification handled by caller if needed)
    let classification = classifyWithHeuristic(content);
    classification = sanitizeClassification(classification);

    // Route low-confidence, unknown, or sensitive to inbox
    const useInbox =
      classification.confidence < 0.7 || classification.category === "unknown" || classification.sensitivity === "high";

    const folder = useInbox ? "00_Inbox" : undefined;
    const notePath = buildCapturePath(classification.category, classification.suggested_title, folder);

    // Write note
    const result = await this.vault.writeNote(notePath, {
      content,
      frontmatter: {
        type: "capture",
        category: classification.category,
        confidence: classification.confidence,
        created: new Date().toISOString(),
        tags: classification.tags,
      },
    });

    if (!result.ok) {
      return { ok: false, message: `Failed to write note: ${result.message}`, classification };
    }

    try {
      await appendClassificationLog(
        this.config.vaultPath,
        classification,
        result.path,
        this.config.logRawInput ? content : undefined,
      );
    } catch {
      // Non-fatal
    }

    return {
      ok: true,
      notePath: result.path,
      classification,
      message: `Captured to ${result.path}`,
    };
  }
}
