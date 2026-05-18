import { otelSpan } from "./otel.js";
import { endSpan, startSpan } from "./telemetry.js";

export interface ActiveSpan {
  /** Internal requestId — correlates log entries to OTel spans via the `request.id` attribute. */
  id: string;
  end(error?: unknown): void;
}

/**
 * Start a unified span that covers both internal metrics/logging (telemetry.ts)
 * and OTel distributed tracing (otel.ts) in a single lifecycle object.
 * When OTel is disabled the OTel side is a noop — no branching needed at call sites.
 *
 * The `id` field exposes the internal requestId so callers (e.g. wrapHandler) can
 * attach it to log entries for log/trace correlation.
 */
export function beginSpan(
  toolName: string,
  vault: string,
  extraAttributes?: Record<string, string | number | boolean>,
): ActiveSpan {
  const internal = startSpan(toolName, vault);
  const otel = otelSpan(toolName, vault, {
    "request.id": internal.id, // correlation key: log requestId === span request.id
    ...extraAttributes,
  });
  return {
    id: internal.id,
    end(error?: unknown) {
      endSpan(internal, error);
      otel.end(error, { "request.id": internal.id });
    },
  };
}
