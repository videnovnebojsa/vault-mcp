import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, JSONRPCErrorResponseSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildLogger } from "../utils/logger.js";
import {
  type BridgeTransport,
  buildErrorResponse,
  classifyTransportError,
  StdioHttpBridge,
} from "./stdio-http-bridge.js";

class FakeTransport implements BridgeTransport {
  start = vi.fn(async () => {});
  close = vi.fn(async () => {});
  send = vi.fn<(msg: JSONRPCMessage) => Promise<void>>(async () => {});
  onmessage?: (msg: JSONRPCMessage) => void;
  onclose?: () => void;
  onerror?: (err: Error) => void;

  fire(msg: JSONRPCMessage): void {
    this.onmessage?.(msg);
  }
}

function makeLogger(): ChildLogger & {
  calls: Array<{ level: string; message: string; extra?: Record<string, unknown> }>;
} {
  const calls: Array<{ level: string; message: string; extra?: Record<string, unknown> }> = [];
  return {
    calls,
    debug: (message, extra) => calls.push({ level: "debug", message, extra }),
    info: (message, extra) => calls.push({ level: "info", message, extra }),
    warn: (message, extra) => calls.push({ level: "warn", message, extra }),
    error: (message, extra) => calls.push({ level: "error", message, extra }),
  };
}

async function flush(): Promise<void> {
  // Allow microtasks queued by void-promises in the bridge to complete.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

const REQUEST: JSONRPCMessage = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} } as JSONRPCMessage;
const NOTIFICATION: JSONRPCMessage = {
  jsonrpc: "2.0",
  method: "notifications/cancelled",
  params: { requestId: 1 },
} as JSONRPCMessage;
const RESPONSE: JSONRPCMessage = { jsonrpc: "2.0", id: 1, result: { tools: [] } } as JSONRPCMessage;

describe("StdioHttpBridge", () => {
  let upstream: FakeTransport;
  let downstream: FakeTransport;
  let onTerminate: ReturnType<typeof vi.fn>;
  let log: ReturnType<typeof makeLogger>;

  function makeBridge(opts?: {
    classifyError?: (err: unknown) => ReturnType<typeof classifyTransportError>;
  }): StdioHttpBridge {
    return new StdioHttpBridge(upstream, downstream, {
      logger: log,
      onTerminate,
      classifyError: opts?.classifyError,
    });
  }

  beforeEach(() => {
    upstream = new FakeTransport();
    downstream = new FakeTransport();
    onTerminate = vi.fn(async () => {});
    log = makeLogger();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("forwards a request successfully and the upstream response is forwarded back", async () => {
    const bridge = makeBridge();
    await bridge.start();
    downstream.fire(REQUEST);
    await flush();
    expect(upstream.send).toHaveBeenCalledWith(REQUEST);
    expect(downstream.send).not.toHaveBeenCalled();
    upstream.onmessage?.(RESPONSE);
    await flush();
    expect(downstream.send).toHaveBeenCalledWith(RESPONSE);
    expect(onTerminate).not.toHaveBeenCalled();
  });

  it("forwards a notification successfully and does not send a response on success", async () => {
    const bridge = makeBridge();
    await bridge.start();
    downstream.fire(NOTIFICATION);
    await flush();
    expect(upstream.send).toHaveBeenCalledWith(NOTIFICATION);
    expect(downstream.send).not.toHaveBeenCalled();
  });

  it("session-lost on a request: emits JSON-RPC error response and closes once", async () => {
    upstream.send.mockRejectedValueOnce(new StreamableHTTPError(404, 'Error POSTing... {"error":"Session not found"}'));
    const bridge = makeBridge();
    await bridge.start();
    downstream.fire(REQUEST);
    await flush();

    expect(downstream.send).toHaveBeenCalledTimes(1);
    const sent = downstream.send.mock.calls[0][0] as {
      id: unknown;
      error: { code: number; data: { kind: string; httpStatus: number } };
    };
    expect(sent.id).toBe(1);
    expect(sent.error.code).toBe(ErrorCode.ConnectionClosed);
    expect(sent.error.data.kind).toBe("session-lost");
    expect(sent.error.data.httpStatus).toBe(404);
    expect(JSONRPCErrorResponseSchema.safeParse(sent).success).toBe(true);
    expect(upstream.close).toHaveBeenCalledTimes(1);
    expect(downstream.close).toHaveBeenCalledTimes(1);
    expect(onTerminate).toHaveBeenCalledTimes(1);
  });

  it("session-lost on a notification: no response sent, but bridge still closes", async () => {
    upstream.send.mockRejectedValueOnce(new StreamableHTTPError(404, "Session not found"));
    const bridge = makeBridge();
    await bridge.start();
    downstream.fire(NOTIFICATION);
    await flush();

    expect(downstream.send).not.toHaveBeenCalled();
    expect(onTerminate).toHaveBeenCalledTimes(1);
    expect(log.calls.some((c) => c.level === "warn" && c.extra?.kind === "session-lost")).toBe(true);
  });

  it("network-unreachable: error response delivered, bridge closes", async () => {
    const err = new TypeError("fetch failed");
    (err as { cause?: unknown }).cause = { code: "ECONNREFUSED" };
    upstream.send.mockRejectedValueOnce(err);
    const bridge = makeBridge();
    await bridge.start();
    downstream.fire(REQUEST);
    await flush();

    const sent = downstream.send.mock.calls[0][0] as { error: { code: number; data: { kind: string } } };
    expect(sent.error.code).toBe(ErrorCode.InternalError);
    expect(sent.error.data.kind).toBe("network-unreachable");
    expect(onTerminate).toHaveBeenCalledTimes(1);
  });

  it("HTTP 503: error response delivered, bridge does NOT close", async () => {
    upstream.send.mockRejectedValueOnce(new StreamableHTTPError(503, "service unavailable"));
    const bridge = makeBridge();
    await bridge.start();
    downstream.fire(REQUEST);
    await flush();

    expect(downstream.send).toHaveBeenCalledTimes(1);
    const sent = downstream.send.mock.calls[0][0] as {
      error: { code: number; data: { kind: string; httpStatus: number } };
    };
    expect(sent.error.data.kind).toBe("http-server-error");
    expect(sent.error.data.httpStatus).toBe(503);
    expect(upstream.close).not.toHaveBeenCalled();
    expect(onTerminate).not.toHaveBeenCalled();
  });

  it("HTTP 401: error response delivered, bridge closes", async () => {
    upstream.send.mockRejectedValueOnce(new StreamableHTTPError(401, "unauthorized"));
    const bridge = makeBridge();
    await bridge.start();
    downstream.fire(REQUEST);
    await flush();

    const sent = downstream.send.mock.calls[0][0] as { error: { code: number; data: { kind: string } } };
    expect(sent.error.code).toBe(ErrorCode.ConnectionClosed);
    expect(sent.error.data.kind).toBe("auth-failed");
    expect(onTerminate).toHaveBeenCalledTimes(1);
  });

  it("protocol error (code=-1): error response delivered, bridge does NOT close", async () => {
    upstream.send.mockRejectedValueOnce(new StreamableHTTPError(-1, "Unexpected content type: text/html"));
    const bridge = makeBridge();
    await bridge.start();
    downstream.fire(REQUEST);
    await flush();

    const sent = downstream.send.mock.calls[0][0] as { error: { data: { kind: string } } };
    expect(sent.error.data.kind).toBe("protocol");
    expect(onTerminate).not.toHaveBeenCalled();
  });

  it("unknown thrown value (string): error response with kind=unknown, no close", async () => {
    upstream.send.mockRejectedValueOnce("oops");
    const bridge = makeBridge();
    await bridge.start();
    downstream.fire(REQUEST);
    await flush();

    const sent = downstream.send.mock.calls[0][0] as { error: { code: number; data: { kind: string } } };
    expect(sent.error.code).toBe(ErrorCode.InternalError);
    expect(sent.error.data.kind).toBe("unknown");
    expect(onTerminate).not.toHaveBeenCalled();
  });

  it("concurrent failures: close runs exactly once", async () => {
    upstream.send.mockRejectedValue(new StreamableHTTPError(404, "Session not found"));
    const bridge = makeBridge();
    await bridge.start();
    for (let i = 1; i <= 5; i++) {
      downstream.fire({ jsonrpc: "2.0", id: i, method: "ping", params: {} } as JSONRPCMessage);
    }
    await flush();
    await flush();

    expect(upstream.close).toHaveBeenCalledTimes(1);
    expect(downstream.close).toHaveBeenCalledTimes(1);
    expect(onTerminate).toHaveBeenCalledTimes(1);
    expect(downstream.send).toHaveBeenCalledTimes(5);
  });

  it("close() is idempotent across concurrent callers", async () => {
    const bridge = makeBridge();
    await bridge.start();
    const a = bridge.close();
    const b = bridge.close();
    const c = bridge.close();
    await Promise.all([a, b, c]);
    expect(upstream.close).toHaveBeenCalledTimes(1);
    expect(downstream.close).toHaveBeenCalledTimes(1);
    expect(onTerminate).toHaveBeenCalledTimes(1);
  });

  it("upstream.onclose triggers bridge close", async () => {
    const bridge = makeBridge();
    await bridge.start();
    upstream.onclose?.();
    await flush();
    expect(onTerminate).toHaveBeenCalledTimes(1);
  });

  it("downstream.onclose triggers bridge close", async () => {
    const bridge = makeBridge();
    await bridge.start();
    downstream.onclose?.();
    await flush();
    expect(onTerminate).toHaveBeenCalledTimes(1);
  });

  it("error response delivery failure does not loop or block close", async () => {
    upstream.send.mockRejectedValueOnce(new StreamableHTTPError(404, "x"));
    downstream.send.mockRejectedValueOnce(new Error("stdio broken"));
    const bridge = makeBridge();
    await bridge.start();
    downstream.fire(REQUEST);
    await flush();

    expect(onTerminate).toHaveBeenCalledTimes(1);
    expect(log.calls.some((c) => c.level === "error" && /failed to deliver error response/.test(c.message))).toBe(true);
  });

  it("upstream→downstream pass-through failure closes the bridge", async () => {
    downstream.send.mockRejectedValueOnce(new Error("stdio broken"));
    const bridge = makeBridge();
    await bridge.start();
    upstream.onmessage?.(RESPONSE);
    await flush();

    expect(onTerminate).toHaveBeenCalledTimes(1);
    expect(log.calls.some((c) => c.level === "error" && /forward to downstream failed/.test(c.message))).toBe(true);
  });

  it("upstream.onerror only logs at debug (does not double-classify)", async () => {
    const bridge = makeBridge();
    await bridge.start();
    upstream.onerror?.(new StreamableHTTPError(404, "Session not found"));
    await flush();

    expect(downstream.send).not.toHaveBeenCalled();
    expect(onTerminate).not.toHaveBeenCalled();
    expect(log.calls.some((c) => c.level === "debug" && /upstream onerror/.test(c.message))).toBe(true);
  });

  it("preserves string id verbatim in error response", async () => {
    upstream.send.mockRejectedValueOnce(new StreamableHTTPError(503, "x"));
    const bridge = makeBridge();
    await bridge.start();
    const req: JSONRPCMessage = { jsonrpc: "2.0", id: "abc-123", method: "tools/list", params: {} } as JSONRPCMessage;
    downstream.fire(req);
    await flush();

    const sent = downstream.send.mock.calls[0][0] as { id: unknown };
    expect(sent.id).toBe("abc-123");
    expect(typeof sent.id).toBe("string");
  });

  it("start() awaits upstream.start before downstream.start", async () => {
    const order: string[] = [];
    upstream.start = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5));
      order.push("upstream");
    });
    downstream.start = vi.fn(async () => {
      order.push("downstream");
    });
    const bridge = makeBridge();
    await bridge.start();
    expect(order).toEqual(["upstream", "downstream"]);
  });

  it("logger receives structured extras on a forward failure", async () => {
    upstream.send.mockRejectedValueOnce(new StreamableHTTPError(404, "x"));
    const bridge = makeBridge();
    await bridge.start();
    downstream.fire(REQUEST);
    await flush();

    const entry = log.calls.find((c) => c.message === "forward to upstream failed");
    expect(entry).toBeDefined();
    expect(entry?.extra).toMatchObject({
      kind: "session-lost",
      httpStatus: 404,
      method: "tools/list",
      id: 1,
    });
  });

  it("calling start() twice is a no-op", async () => {
    const bridge = makeBridge();
    await bridge.start();
    await bridge.start();
    expect(upstream.start).toHaveBeenCalledTimes(1);
    expect(downstream.start).toHaveBeenCalledTimes(1);
  });

  it("does not trigger close from upstream.onerror even if error looks fatal", async () => {
    const bridge = makeBridge();
    await bridge.start();
    upstream.onerror?.(new StreamableHTTPError(500, "boom"));
    await flush();
    expect(upstream.close).not.toHaveBeenCalled();
  });
});

describe("buildErrorResponse", () => {
  it("returns null for notifications (no id)", () => {
    const cls = classifyTransportError(new StreamableHTTPError(500, "x"));
    const out = buildErrorResponse(NOTIFICATION, cls, new Error("x"));
    expect(out).toBeNull();
  });

  it("includes originalMethod when present", () => {
    const cls = classifyTransportError(new StreamableHTTPError(500, "x"));
    const out = buildErrorResponse(REQUEST, cls, new Error("boom"));
    expect((out as { error: { data: { originalMethod: string } } }).error.data.originalMethod).toBe("tools/list");
  });

  it("omits httpStatus when classification has none", () => {
    const cls = classifyTransportError(new Error("boom"));
    const out = buildErrorResponse(REQUEST, cls, new Error("boom"));
    expect((out as { error: { data: Record<string, unknown> } }).error.data.httpStatus).toBeUndefined();
  });

  it("produced shape passes JSONRPCErrorResponseSchema", () => {
    const cases = [
      new StreamableHTTPError(404, "x"),
      new StreamableHTTPError(401, "x"),
      new StreamableHTTPError(500, "x"),
      new StreamableHTTPError(-1, "x"),
      new Error("plain"),
      "string-throw",
    ];
    for (const err of cases) {
      const cls = classifyTransportError(err);
      const out = buildErrorResponse(REQUEST, cls, err);
      expect(out).not.toBeNull();
      expect(JSONRPCErrorResponseSchema.safeParse(out).success).toBe(true);
    }
  });

  it("cause includes name and message but no stack", () => {
    const cls = classifyTransportError(new Error("boom"));
    const err = new Error("boom");
    const out = buildErrorResponse(REQUEST, cls, err) as {
      error: { data: { cause: { name: string; message: string; stack?: unknown } } };
    };
    expect(out.error.data.cause.name).toBe("Error");
    expect(out.error.data.cause.message).toBe("boom");
    expect(out.error.data.cause.stack).toBeUndefined();
  });
});
