import { describe, expect, it } from "bun:test";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";

import { classifyTransportError, type ErrorClassification, type FailureKind } from "./stdio-http-bridge.js";

interface Row {
  name: string;
  build: () => unknown;
  expect: Partial<ErrorClassification> & { kind: FailureKind };
}

const rows: Row[] = [
  {
    name: "404 Session not found → session-lost",
    build: () => new StreamableHTTPError(404, 'Error POSTing to endpoint: {"error":"Session not found"}'),
    expect: {
      kind: "session-lost",
      jsonRpcCode: ErrorCode.ConnectionClosed,
      shouldClose: true,
      logLevel: "warn",
      httpStatus: 404,
    },
  },
  {
    name: "404 with arbitrary body → still session-lost (status code drives classification)",
    build: () => new StreamableHTTPError(404, "anything else"),
    expect: { kind: "session-lost", shouldClose: true, httpStatus: 404 },
  },
  {
    name: "401 → auth-failed",
    build: () => new StreamableHTTPError(401, "unauthorized"),
    expect: {
      kind: "auth-failed",
      jsonRpcCode: ErrorCode.ConnectionClosed,
      shouldClose: true,
      logLevel: "error",
      httpStatus: 401,
    },
  },
  {
    name: "403 → auth-failed",
    build: () => new StreamableHTTPError(403, "forbidden"),
    expect: { kind: "auth-failed", shouldClose: true, httpStatus: 403 },
  },
  {
    name: "429 → http-client-error (does not close)",
    build: () => new StreamableHTTPError(429, "too many"),
    expect: {
      kind: "http-client-error",
      jsonRpcCode: ErrorCode.InternalError,
      shouldClose: false,
      logLevel: "error",
      httpStatus: 429,
    },
  },
  {
    name: "500 → http-server-error (does not close)",
    build: () => new StreamableHTTPError(500, "boom"),
    expect: {
      kind: "http-server-error",
      jsonRpcCode: ErrorCode.InternalError,
      shouldClose: false,
      logLevel: "warn",
      httpStatus: 500,
    },
  },
  {
    name: "502 → http-server-error",
    build: () => new StreamableHTTPError(502, "bad gateway"),
    expect: { kind: "http-server-error", shouldClose: false, httpStatus: 502 },
  },
  {
    name: "-1 (unexpected content-type) → protocol",
    build: () => new StreamableHTTPError(-1, "Unexpected content type: text/html"),
    expect: {
      kind: "protocol",
      jsonRpcCode: ErrorCode.InternalError,
      shouldClose: false,
      logLevel: "error",
    },
  },
  {
    name: "TypeError(fetch failed) with cause.code=ECONNREFUSED → network-unreachable",
    build: () => {
      const err = new TypeError("fetch failed");
      (err as { cause?: unknown }).cause = { code: "ECONNREFUSED" };
      return err;
    },
    expect: {
      kind: "network-unreachable",
      jsonRpcCode: ErrorCode.InternalError,
      shouldClose: true,
      logLevel: "warn",
    },
  },
  {
    name: "TypeError(fetch failed) without cause → still network-unreachable (message match)",
    build: () => new TypeError("fetch failed"),
    expect: { kind: "network-unreachable", shouldClose: true },
  },
  {
    name: "Error with code=ETIMEDOUT directly → network-unreachable",
    build: () => Object.assign(new Error("connect ETIMEDOUT 127.0.0.1:3782"), { code: "ETIMEDOUT" }),
    expect: { kind: "network-unreachable", shouldClose: true },
  },
  {
    name: "Error with code=ECONNRESET → network-unreachable",
    build: () => Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
    expect: { kind: "network-unreachable", shouldClose: true },
  },
  {
    name: "Error with code=ENOTFOUND → network-unreachable",
    build: () => Object.assign(new Error("getaddrinfo ENOTFOUND nope"), { code: "ENOTFOUND" }),
    expect: { kind: "network-unreachable", shouldClose: true },
  },
  {
    name: "plain Error('boom') → unknown",
    build: () => new Error("boom"),
    expect: { kind: "unknown", jsonRpcCode: ErrorCode.InternalError, shouldClose: false, logLevel: "error" },
  },
  {
    name: "string throw → unknown",
    build: () => "oops",
    expect: { kind: "unknown", shouldClose: false },
  },
  {
    name: "null → unknown",
    build: () => null,
    expect: { kind: "unknown", shouldClose: false },
  },
  {
    name: "undefined → unknown",
    build: () => undefined,
    expect: { kind: "unknown", shouldClose: false },
  },
];

describe("classifyTransportError", () => {
  for (const row of rows) {
    it(row.name, () => {
      const got = classifyTransportError(row.build());
      for (const [k, v] of Object.entries(row.expect)) {
        expect(got[k as keyof ErrorClassification]).toBe(v);
      }
      expect(got.reason).toBeTypeOf("string");
      expect(got.reason.length).toBeGreaterThan(0);
    });
  }

  it("classification is deterministic (same input → same output)", () => {
    const err = new StreamableHTTPError(404, "x");
    const a = classifyTransportError(err);
    const b = classifyTransportError(err);
    expect(a).toEqual(b);
  });

  it("session-lost reason mentions re-handshake", () => {
    const cls = classifyTransportError(new StreamableHTTPError(404, "x"));
    expect(cls.reason).toMatch(/re-handshake|respawn/i);
  });
});
