import { VaultError, VaultErrorCode } from "../utils/errors.js";
import type { VaultNote } from "../vault/types.js";

/** Strip internal-only fields before sending a VaultNote to an MCP client. */
export function toClientNote(note: VaultNote): Omit<VaultNote, "absPath"> {
  const { absPath: _, ...safe } = note;
  return safe;
}

// ── Standard Response Envelope ────────────────────────────────────────────────

export type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

/**
 * Wraps a single item in the standard { ok: true, data } envelope.
 */
export function successResult<T>(data: T): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ ok: true, data }) }] };
}

/**
 * Pagination descriptor for listResult.
 * Use knownTotal when the backend has an exact total; use unknownTotal only when
 * the backend can cheaply determine hasMore without counting the full result set.
 */
export type ListResultPagination =
  | { kind: "knownTotal"; total: number; offset: number; limit: number }
  | { kind: "unknownTotal"; offset: number; limit: number; hasMore: boolean };

/**
 * Wraps a paginated list in the standard { ok: true, items, total, hasMore, nextOffset? } envelope.
 * Exact totals infer hasMore from offset + items.length < total; unknown totals require explicit hasMore.
 */
export function listResult<T>(items: T[], pagination: ListResultPagination): ToolResult {
  if (typeof pagination !== "object" || pagination === null || !("kind" in pagination)) {
    throw new VaultError("listResult requires a pagination descriptor", VaultErrorCode.VALIDATION);
  }
  const total = pagination.kind === "knownTotal" ? pagination.total : null;
  const hasMore =
    pagination.kind === "knownTotal" ? pagination.offset + items.length < pagination.total : pagination.hasMore;
  const payload: {
    ok: true;
    items: T[];
    total: number | null;
    hasMore: boolean;
    nextOffset?: number;
  } = {
    ok: true,
    items,
    total,
    hasMore,
  };
  if (hasMore) payload.nextOffset = pagination.offset + pagination.limit;
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload),
      },
    ],
  };
}

/**
 * Returns a standard { ok: false, error: { code, message } } error envelope.
 * Sets isError: true so wrapHandler correctly records errors in telemetry.
 */
export function errorResult(code: string, message: string): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ ok: false, error: { code, message } }) }],
    isError: true,
  };
}
