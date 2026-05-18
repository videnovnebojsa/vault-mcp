import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

import { type ChildLogger, logger } from "../utils/logger.js";

export interface BridgeTransport {
  start(): Promise<void>;
  close(): Promise<void>;
  send(message: JSONRPCMessage): Promise<void>;
  onmessage?: (msg: JSONRPCMessage) => void;
  onclose?: () => void;
  onerror?: (err: Error) => void;
}

export type FailureKind =
  | "session-lost"
  | "auth-failed"
  | "protocol"
  | "http-client-error"
  | "http-server-error"
  | "network-unreachable"
  | "unknown";

export interface ErrorClassification {
  kind: FailureKind;
  jsonRpcCode: number;
  shouldClose: boolean;
  logLevel: "warn" | "error";
  httpStatus?: number;
  reason: string;
}

const NETWORK_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
]);

function getErrorCode(err: unknown): string | undefined {
  if (err && typeof err === "object") {
    const direct = (err as { code?: unknown }).code;
    if (typeof direct === "string") return direct;
    const cause = (err as { cause?: unknown }).cause;
    if (cause && typeof cause === "object") {
      const causeCode = (cause as { code?: unknown }).code;
      if (typeof causeCode === "string") return causeCode;
    }
  }
  return undefined;
}

export function classifyTransportError(err: unknown): ErrorClassification {
  if (err instanceof StreamableHTTPError) {
    const status = err.code;
    if (status === 404) {
      return {
        kind: "session-lost",
        jsonRpcCode: ErrorCode.ConnectionClosed,
        shouldClose: true,
        logLevel: "warn",
        httpStatus: 404,
        reason: "Upstream session lost; bridge will exit so client can re-handshake",
      };
    }
    if (status === 401 || status === 403) {
      return {
        kind: "auth-failed",
        jsonRpcCode: ErrorCode.ConnectionClosed,
        shouldClose: true,
        logLevel: "error",
        httpStatus: status,
        reason: `Upstream rejected auth (HTTP ${status})`,
      };
    }
    if (status === -1) {
      return {
        kind: "protocol",
        jsonRpcCode: ErrorCode.InternalError,
        shouldClose: false,
        logLevel: "error",
        reason: `Upstream protocol error: ${err.message}`,
      };
    }
    if (typeof status === "number" && status >= 400 && status < 500) {
      return {
        kind: "http-client-error",
        jsonRpcCode: ErrorCode.InternalError,
        shouldClose: false,
        logLevel: "error",
        httpStatus: status,
        reason: `Upstream HTTP ${status}`,
      };
    }
    if (typeof status === "number" && status >= 500 && status < 600) {
      return {
        kind: "http-server-error",
        jsonRpcCode: ErrorCode.InternalError,
        shouldClose: false,
        logLevel: "warn",
        httpStatus: status,
        reason: `Upstream HTTP ${status}`,
      };
    }
    return {
      kind: "unknown",
      jsonRpcCode: ErrorCode.InternalError,
      shouldClose: false,
      logLevel: "error",
      ...(typeof status === "number" ? { httpStatus: status } : {}),
      reason: `Unhandled StreamableHTTPError: ${err.message}`,
    };
  }

  const code = getErrorCode(err);
  if (code && NETWORK_ERROR_CODES.has(code)) {
    return {
      kind: "network-unreachable",
      jsonRpcCode: ErrorCode.InternalError,
      shouldClose: true,
      logLevel: "warn",
      reason: `Upstream unreachable (${code}); bridge will exit so client can respawn`,
    };
  }
  if (err instanceof TypeError && /fetch failed/i.test(err.message)) {
    return {
      kind: "network-unreachable",
      jsonRpcCode: ErrorCode.InternalError,
      shouldClose: true,
      logLevel: "warn",
      reason: "Upstream unreachable (fetch failed); bridge will exit so client can respawn",
    };
  }

  const message =
    err instanceof Error ? err.message : err === undefined ? "undefined" : err === null ? "null" : String(err);
  return {
    kind: "unknown",
    jsonRpcCode: ErrorCode.InternalError,
    shouldClose: false,
    logLevel: "error",
    reason: `Unclassified upstream error: ${message}`,
  };
}

function isJsonRpcRequest(msg: JSONRPCMessage): msg is JSONRPCMessage & { id: string | number } {
  return "id" in msg && (msg as { id?: unknown }).id !== undefined && (msg as { id?: unknown }).id !== null;
}

export function buildErrorResponse(
  originalMsg: JSONRPCMessage,
  classification: ErrorClassification,
  rawErr: unknown,
): JSONRPCMessage | null {
  if (!isJsonRpcRequest(originalMsg)) return null;

  const data: Record<string, unknown> = { kind: classification.kind };
  if (classification.httpStatus !== undefined) data["httpStatus"] = classification.httpStatus;
  const method = (originalMsg as { method?: unknown }).method;
  if (typeof method === "string") data["originalMethod"] = method;
  data["cause"] = {
    name: rawErr instanceof Error ? rawErr.name : typeof rawErr,
    message: rawErr instanceof Error ? rawErr.message : String(rawErr),
  };

  return {
    jsonrpc: "2.0",
    id: originalMsg.id,
    error: {
      code: classification.jsonRpcCode,
      message: classification.reason,
      data,
    },
  } as JSONRPCMessage;
}

export interface StdioHttpBridgeOptions {
  logger?: ChildLogger;
  onTerminate?: () => Promise<void> | void;
  classifyError?: (err: unknown) => ErrorClassification;
}

export class StdioHttpBridge {
  private readonly log: ChildLogger;
  private readonly classify: (err: unknown) => ErrorClassification;
  private readonly onTerminate: () => Promise<void> | void;
  private _started = false;
  private _closing?: Promise<void>;

  constructor(
    private readonly upstream: BridgeTransport,
    private readonly downstream: BridgeTransport,
    opts: StdioHttpBridgeOptions = {},
  ) {
    this.log = opts.logger ?? logger.child("stdio-bridge");
    this.classify = opts.classifyError ?? classifyTransportError;
    this.onTerminate = opts.onTerminate ?? (() => process.exit(0));
  }

  async start(): Promise<void> {
    if (this._started) return;
    this._started = true;

    this.downstream.onmessage = (msg) => {
      void this.handleDownstreamMessage(msg);
    };

    this.upstream.onmessage = (msg) => {
      void this.handleUpstreamMessage(msg);
    };

    this.upstream.onclose = () => {
      this.log.warn("upstream closed");
      void this.close();
    };

    this.downstream.onclose = () => {
      this.log.warn("downstream closed");
      void this.close();
    };

    this.upstream.onerror = (err) => {
      const cls = this.classify(err);
      this.log[cls.logLevel]("upstream transport error", {
        kind: cls.kind,
        httpStatus: cls.httpStatus,
        reason: cls.reason,
      });
    };

    this.downstream.onerror = (err) => {
      this.log.error("downstream onerror", { err: err.message });
    };

    await this.upstream.start();
    await this.downstream.start();
  }

  async close(): Promise<void> {
    if (this._closing) return this._closing;
    this._closing = this.doClose();
    return this._closing;
  }

  private async doClose(): Promise<void> {
    await safeCall(() => this.upstream.close(), this.log, "upstream.close failed");
    await safeCall(() => this.downstream.close(), this.log, "downstream.close failed");
    await safeCall(() => this.onTerminate(), this.log, "onTerminate failed");
  }

  private async handleDownstreamMessage(msg: JSONRPCMessage): Promise<void> {
    try {
      await this.upstream.send(msg);
    } catch (err) {
      const cls = this.classify(err);
      const id = isJsonRpcRequest(msg) ? msg.id : undefined;
      const method = (msg as { method?: unknown }).method;
      this.log[cls.logLevel]("forward to upstream failed", {
        kind: cls.kind,
        httpStatus: cls.httpStatus,
        method: typeof method === "string" ? method : undefined,
        id,
        reason: cls.reason,
      });

      const resp = buildErrorResponse(msg, cls, err);
      if (resp) {
        try {
          await this.downstream.send(resp);
        } catch (sendErr) {
          this.log.error("failed to deliver error response to downstream", {
            err: sendErr instanceof Error ? sendErr.message : String(sendErr),
          });
        }
      }

      if (cls.shouldClose) {
        void this.close();
      }
    }
  }

  private async handleUpstreamMessage(msg: JSONRPCMessage): Promise<void> {
    try {
      await this.downstream.send(msg);
    } catch (err) {
      this.log.error("forward to downstream failed", {
        err: err instanceof Error ? err.message : String(err),
      });
      void this.close();
    }
  }
}

async function safeCall(fn: () => Promise<void> | void, log: ChildLogger, context: string): Promise<void> {
  try {
    await fn();
  } catch (err) {
    log.error(context, { err: err instanceof Error ? err.message : String(err) });
  }
}
