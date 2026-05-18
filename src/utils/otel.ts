/**
 * Optional OpenTelemetry bootstrap. Enabled via ENABLE_OTEL=true.
 * When disabled (default) this module is a no-op so no OTel packages are required.
 *
 * When ENABLE_OTEL=true the SDK must be available at runtime:
 *   pnpm add @opentelemetry/sdk-node @opentelemetry/exporter-trace-otlp-http
 */

import { logger } from "./logger.js";

const RESET_OTEL_FOR_TEST = Symbol.for("vault-mcp.otel.resetForTest");

export interface OtelSpan {
  end(error?: unknown, attributes?: Record<string, string | number | boolean>): void;
}

const noop: OtelSpan = { end() {} };

let sdkStarted = false;
// Starts as noop — no window where spans are silently dropped during SDK startup
let startSpanFn: (name: string, attributes: Record<string, string | number | boolean>) => OtelSpan = (_name, _attrs) =>
  noop;
let sdkRef: { shutdown(): Promise<void> } | null = null;
let initGeneration = 0;

interface StartedSpan {
  end(): void;
  recordException(error: Error): void;
  setAttribute(key: string, value: string | number | boolean): void;
  setStatus(status: { code: number; message?: string }): void;
}

interface TracerLike {
  startSpan(name: string, options: { attributes: Record<string, string | number | boolean> }): StartedSpan;
}

interface LoadedOtelModules {
  NodeSDK: new (opts: {
    spanProcessors: unknown[];
    instrumentations: unknown[];
    serviceName: string;
  }) => {
    start(): Promise<void>;
    shutdown(): Promise<void>;
  };
  getNodeAutoInstrumentations(): unknown[];
  OTLPTraceExporter: new (opts: { url: string }) => unknown;
  BatchSpanProcessor: new (exporter: unknown) => unknown;
  ConsoleSpanExporter: new () => unknown;
  trace: { getTracer(name: string): TracerLike };
  SpanStatusCode: { ERROR: number };
}

async function loadOtelModules(): Promise<LoadedOtelModules> {
  // @ts-expect-error — optional runtime deps, not installed by default
  const [sdkNode, autoInstrumentations, otlpExporter, traceNode, api] = await Promise.all([
    // @ts-expect-error
    import("@opentelemetry/sdk-node"),
    // @ts-expect-error
    import("@opentelemetry/auto-instrumentations-node"),
    // @ts-expect-error
    import("@opentelemetry/exporter-trace-otlp-http"),
    // @ts-expect-error
    import("@opentelemetry/sdk-trace-node"),
    // @ts-expect-error
    import("@opentelemetry/api"),
  ]);

  return {
    NodeSDK: sdkNode.NodeSDK as LoadedOtelModules["NodeSDK"],
    getNodeAutoInstrumentations:
      autoInstrumentations.getNodeAutoInstrumentations as LoadedOtelModules["getNodeAutoInstrumentations"],
    OTLPTraceExporter: otlpExporter.OTLPTraceExporter as LoadedOtelModules["OTLPTraceExporter"],
    BatchSpanProcessor: traceNode.BatchSpanProcessor as LoadedOtelModules["BatchSpanProcessor"],
    ConsoleSpanExporter: traceNode.ConsoleSpanExporter as LoadedOtelModules["ConsoleSpanExporter"],
    trace: api.trace as LoadedOtelModules["trace"],
    SpanStatusCode: api.SpanStatusCode as LoadedOtelModules["SpanStatusCode"],
  };
}

export function initOtel(endpoint: string): void {
  if (sdkStarted) return;
  sdkStarted = true;
  const generation = ++initGeneration;

  void (async () => {
    let depsLoaded = false;
    let sdk: { start(): Promise<void>; shutdown(): Promise<void> } | null = null;
    try {
      const {
        NodeSDK,
        getNodeAutoInstrumentations,
        OTLPTraceExporter,
        BatchSpanProcessor,
        ConsoleSpanExporter,
        trace,
        SpanStatusCode,
      } = await loadOtelModules();
      depsLoaded = true;

      const exporter = endpoint ? new OTLPTraceExporter({ url: endpoint }) : new ConsoleSpanExporter();

      sdk = new NodeSDK({
        // BatchSpanProcessor exports asynchronously, avoiding event-loop blocking per span.
        spanProcessors: [new BatchSpanProcessor(exporter)],
        instrumentations: [getNodeAutoInstrumentations()],
        serviceName: "vault-mcp",
      });
      sdkRef = sdk;

      await sdk.start();
      if (generation !== initGeneration || sdkRef !== sdk) {
        return;
      }
      sdkRef = sdk;
      const tracer = trace.getTracer("vault-mcp");
      startSpanFn = (name, attributes) => {
        const span = tracer.startSpan(name, { attributes });
        return {
          end(error?: unknown, extra?: Record<string, string | number | boolean>) {
            if (error !== undefined) {
              span.recordException(error instanceof Error ? error : new Error(String(error)));
              span.setStatus({
                code: SpanStatusCode.ERROR,
                message: error instanceof Error ? error.message : String(error),
              });
            }
            if (extra) {
              for (const [k, v] of Object.entries(extra)) span.setAttribute(k, v);
            }
            span.end();
          },
        };
      };
      logger.info("otel", "SDK started", { endpoint: endpoint || "console" });
    } catch (err) {
      if (generation === initGeneration && sdkRef === sdk) {
        sdkRef = null;
        sdkStarted = false;
      } else if (generation === initGeneration && sdk === null) {
        sdkRef = null;
        sdkStarted = false;
      }
      if (depsLoaded && sdk !== null) {
        logger.error("otel", "start failed", { err: String(err), endpoint: endpoint || "console" });
        return;
      }
      logger.warn("otel", "Failed to start — @opentelemetry/sdk-node not available or incompatible", {
        err: String(err),
        endpoint: endpoint || "console",
      });
    }
  })();
}

/** Flush and shut down the OTel SDK. Called during graceful shutdown to avoid losing in-flight spans. */
export function shutdownOtel(): Promise<void> {
  if (!sdkRef) return Promise.resolve();
  return Promise.race([
    sdkRef.shutdown(),
    new Promise<void>((resolve) =>
      setTimeout(() => {
        logger.warn("otel", "shutdown timed out", { timeoutMs: 5000 });
        resolve();
      }, 5000).unref(),
    ),
  ]);
}

/** Resets module-level SDK state so multiple test files can share the same bun worker. */
function resetOtelStateForTest(): void {
  initGeneration++;
  const sdk = sdkRef;
  sdkStarted = false;
  startSpanFn = (_name, _attrs) => noop;
  sdkRef = null;
  if (sdk) {
    sdk.shutdown().catch((err: unknown) => logger.warn("otel", "test reset shutdown failed", { err: String(err) }));
  }
}

const INJECT_SDK_FOR_TEST = Symbol.for("vault-mcp.otel.injectSdkForTest");

if (process.env.NODE_ENV !== "production") {
  (globalThis as Record<PropertyKey, unknown>)[RESET_OTEL_FOR_TEST] = resetOtelStateForTest;
  (globalThis as Record<PropertyKey, unknown>)[INJECT_SDK_FOR_TEST] = (sdk: { shutdown(): Promise<void> }): void => {
    sdkRef = sdk;
    sdkStarted = true;
  };
}

export function otelSpan(
  toolName: string,
  vault: string,
  extraAttributes?: Record<string, string | number | boolean>,
): OtelSpan {
  return startSpanFn(`vault.tool.${toolName}`, {
    "tool.name": toolName,
    "vault.name": vault,
    ...extraAttributes,
  });
}
