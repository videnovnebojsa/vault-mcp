import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./metrics.js", () => ({
  metrics: { record: vi.fn() },
}));

vi.mock("./logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { logger } from "./logger.js";
import { metrics } from "./metrics.js";
import { endSpan, startSpan } from "./telemetry.js";

const mockRecord = metrics.record as ReturnType<typeof vi.fn>;
const mockLogInfo = logger.info as ReturnType<typeof vi.fn>;
const mockLogDebug = logger.debug as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("startSpan", () => {
  it("returns a span with correct toolName and vault", () => {
    const span = startSpan("vault_read_note", "work");
    expect(span.toolName).toBe("vault_read_note");
    expect(span.vault).toBe("work");
  });

  it("assigns a 16-character hex id", () => {
    const span = startSpan("tool", "v");
    expect(span.id).toMatch(/^[0-9a-f]{16}$/);
  });

  it("records startedAt close to Date.now()", () => {
    const before = Date.now();
    const span = startSpan("tool", "v");
    const after = Date.now();
    expect(span.startedAt).toBeGreaterThanOrEqual(before);
    expect(span.startedAt).toBeLessThanOrEqual(after);
  });

  it("generates unique ids across calls", () => {
    const ids = new Set(Array.from({ length: 20 }, () => startSpan("tool", "v").id));
    // With 8-char hex (4 billion values) collisions in 20 draws are astronomically unlikely
    expect(ids.size).toBe(20);
  });

  it("logs a debug entry with the requestId and tool name", () => {
    const span = startSpan("vault_write_note", "main");
    expect(mockLogDebug).toHaveBeenCalledWith(
      "tool",
      "start",
      expect.objectContaining({ requestId: span.id, tool: "vault_write_note", vault: "main" }),
    );
  });
});

describe("endSpan — success path", () => {
  it("calls metrics.record with isError=false", () => {
    const span = startSpan("vault_search", "default");
    endSpan(span);
    expect(mockRecord).toHaveBeenCalledWith("vault_search", expect.any(Number), false);
  });

  it("logs status 'ok'", () => {
    const span = startSpan("vault_search", "default");
    endSpan(span);
    expect(mockLogInfo).toHaveBeenCalledWith(
      "tool",
      "ok",
      expect.objectContaining({ tool: "vault_search", vault: "default" }),
    );
  });

  it("includes durationMs in the log (>= 0)", () => {
    const span = startSpan("vault_search", "default");
    endSpan(span);
    const call = mockLogInfo.mock.calls[0];
    expect(call?.[2]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("does not include err field on success", () => {
    const span = startSpan("vault_search", "default");
    endSpan(span);
    const call = mockLogInfo.mock.calls[0];
    expect(call?.[2]).not.toHaveProperty("err");
  });
});

describe("endSpan — error path", () => {
  it("calls metrics.record with isError=true when error is provided", () => {
    const span = startSpan("vault_write_note", "default");
    endSpan(span, new Error("boom"));
    expect(mockRecord).toHaveBeenCalledWith("vault_write_note", expect.any(Number), true);
  });

  it("logs status 'error'", () => {
    const span = startSpan("vault_write_note", "default");
    endSpan(span, new Error("boom"));
    expect(mockLogInfo).toHaveBeenCalledWith("tool", "error", expect.any(Object));
  });

  it("includes err message in the log for Error instances", () => {
    const span = startSpan("vault_write_note", "default");
    endSpan(span, new Error("disk full"));
    const call = mockLogInfo.mock.calls[0];
    expect(call?.[2]?.err).toBe("disk full");
  });

  it("stringifies non-Error values in the err field", () => {
    const span = startSpan("vault_write_note", "default");
    endSpan(span, "string error");
    const call = mockLogInfo.mock.calls[0];
    expect(call?.[2]?.err).toBe("string error");
  });
});
