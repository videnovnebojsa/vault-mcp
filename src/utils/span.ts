import { otelSpan } from "./otel.js";
import { endSpan, startSpan } from "./telemetry.js";

export interface ActiveSpan {
  end(error?: unknown): void;
}

/**
 * Start a unified span that covers both internal metrics/logging (telemetry.ts)
 * and OTel distributed tracing (otel.ts) in a single lifecycle object.
 * When OTel is disabled the OTel side is a noop — no branching needed at call sites.
 */
export function beginSpan(toolName: string, vault: string): ActiveSpan {
  const internal = startSpan(toolName, vault);
  const otel = otelSpan(toolName, vault);
  return {
    end(error?: unknown) {
      endSpan(internal, error);
      otel.end(error);
    },
  };
}
