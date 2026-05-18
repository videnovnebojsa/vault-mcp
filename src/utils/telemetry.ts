import { randomBytes } from "node:crypto";
import { logger } from "./logger.js";
import { metrics } from "./metrics.js";

export interface Span {
  id: string;
  toolName: string;
  vault: string;
  startedAt: number;
}

/** 16-character hex correlation ID using cryptographic randomness. */
function newId(): string {
  return randomBytes(8).toString("hex");
}

export function startSpan(toolName: string, vault: string): Span {
  const span: Span = { id: newId(), toolName, vault, startedAt: Date.now() };
  logger.debug("tool", "start", { requestId: span.id, tool: toolName, vault });
  return span;
}

export function endSpan(span: Span, error?: unknown): void {
  const durationMs = Date.now() - span.startedAt;
  const isError = error !== undefined;
  metrics.record(span.toolName, durationMs, isError);
  const extra = {
    requestId: span.id,
    tool: span.toolName,
    vault: span.vault,
    durationMs,
    ...(isError
      ? {
          err: error instanceof Error ? error.message : String(error),
          ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
        }
      : {}),
  };
  if (isError) {
    logger.warn("tool", "error", extra);
  } else {
    logger.info("tool", "ok", extra);
  }
}
