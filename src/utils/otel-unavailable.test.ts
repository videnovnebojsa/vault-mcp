import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { logger } from "./logger.js";
import { initOtel } from "./otel.js";
import { resetOtelForTest } from "./otel-test-support.js";

// Each file gets isolated module state — sdkStarted flag is fresh here.

let warnSpy: ReturnType<typeof spyOn>;

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

describe("initOtel — package unavailable", () => {
  beforeEach(() => {
    mock.module("@opentelemetry/sdk-node", () => ({
      NodeSDK: class {
        constructor() {
          throw new Error("sdk-node unavailable in test");
        }
      },
    }));
    mock.module("@opentelemetry/auto-instrumentations-node", () => ({
      getNodeAutoInstrumentations: () => [],
    }));
    mock.module("@opentelemetry/exporter-trace-otlp-http", () => ({
      OTLPTraceExporter: class {},
    }));
    mock.module("@opentelemetry/sdk-trace-node", () => ({
      BatchSpanProcessor: class {},
      ConsoleSpanExporter: class {},
    }));
    mock.module("@opentelemetry/api", () => ({
      trace: { getTracer: () => ({}) },
      SpanStatusCode: { ERROR: 2 },
    }));
    resetOtelForTest();
    warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    mock.restore();
  });

  it("logs the real error message (not hardcoded 'Package not found')", async () => {
    initOtel("");
    await flushMicrotasks();

    expect(warnSpy).toHaveBeenCalledOnce();
    const [, , extra] = warnSpy.mock.calls[0] as [unknown, unknown, Record<string, unknown>?];
    // The err field must contain the real error, not the old hardcoded string
    expect(extra?.err).toBeDefined();
    expect(typeof extra?.err).toBe("string");
    expect(extra?.err).not.toBe("Package not found");
    expect(extra?.err).toContain("sdk-node unavailable in test");
  });
});
