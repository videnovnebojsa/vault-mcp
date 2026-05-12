/**
 * Optional OpenTelemetry bootstrap. Enabled via ENABLE_OTEL=true.
 * When disabled (default) this module is a no-op so no OTel packages are required.
 *
 * When ENABLE_OTEL=true the SDK must be available at runtime:
 *   pnpm add @opentelemetry/sdk-node @opentelemetry/exporter-trace-otlp-http
 */

import { createRequire } from "node:module";
import { logger } from "./logger.js";

const req = createRequire(import.meta.url);

export interface OtelSpan {
  end(error?: unknown, attributes?: Record<string, string | number | boolean>): void;
}

const noop: OtelSpan = { end() {} };

let sdkStarted = false;
let startSpanFn: ((name: string, attributes: Record<string, string>) => OtelSpan) | undefined;
let sdkRef: { shutdown(): Promise<void> } | null = null;

export function initOtel(endpoint: string): void {
  if (sdkStarted) return;
  sdkStarted = true;

  try {
    // Dynamic require so the packages are truly optional — if not installed this block throws
    // and we fall back to no-op without crashing.
    const { NodeSDK } = req("@opentelemetry/sdk-node");
    const { getNodeAutoInstrumentations } = req("@opentelemetry/auto-instrumentations-node");
    const { OTLPTraceExporter } = req("@opentelemetry/exporter-trace-otlp-http");
    const { BatchSpanProcessor, ConsoleSpanExporter } = req("@opentelemetry/sdk-trace-node");
    const { trace, SpanStatusCode } = req("@opentelemetry/api");

    const exporter = endpoint ? new OTLPTraceExporter({ url: endpoint }) : new ConsoleSpanExporter();

    const sdk = new NodeSDK({
      // BatchSpanProcessor exports asynchronously, avoiding event-loop blocking per span.
      spanProcessors: [new BatchSpanProcessor(exporter)],
      instrumentations: [getNodeAutoInstrumentations()],
      serviceName: "vault-mcp",
    });

    sdk
      .start()
      .then(() => {
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
      })
      .catch((err: unknown) => logger.error("otel", "start failed", { err: String(err) }));
  } catch (err) {
    logger.warn("otel", "Failed to start — install @opentelemetry/sdk-node to enable tracing", { err: String(err) });
  }
}

/** Flush and shut down the OTel SDK. Called during graceful shutdown to avoid losing in-flight spans. */
export function shutdownOtel(): Promise<void> {
  return sdkRef?.shutdown() ?? Promise.resolve();
}

export function otelSpan(toolName: string, vault: string): OtelSpan {
  if (!startSpanFn) return noop;
  return startSpanFn(`vault.tool.${toolName}`, { "tool.name": toolName, "vault.name": vault });
}
