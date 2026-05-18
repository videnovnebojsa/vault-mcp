import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { logger } from "./logger.js";
import { initOtel } from "./otel.js";
import { resetOtelForTest } from "./otel-test-support.js";

// Each file gets isolated module state — sdkStarted flag is fresh here.

let warnSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;
const sdkInstances: FakeNodeSDK[] = [];

class FakeNodeSDK {
  readonly start = mock<() => Promise<void>>(
    () =>
      new Promise((resolve, reject) => {
        this.resolveStart = resolve;
        this.rejectStart = reject;
      }),
  );
  readonly shutdown = mock(async () => {});
  resolveStart: () => void = () => {};
  rejectStart: (reason?: unknown) => void = () => {};

  constructor(_opts: unknown) {
    sdkInstances.push(this);
  }
}

mock.module("@opentelemetry/sdk-node", () => ({ NodeSDK: FakeNodeSDK }));
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
  SpanStatusCode: { ERROR: 2 },
  trace: {
    getTracer: () => ({
      startSpan: () => ({
        end() {},
        recordException() {},
        setAttribute() {},
        setStatus() {},
      }),
    }),
  },
}));

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

describe("initOtel — idempotency", () => {
  beforeEach(() => {
    resetOtelForTest();
    sdkInstances.length = 0;
    warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    errorSpy = spyOn(logger, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    mock.restore();
  });

  it("does not re-enter init body on second call", async () => {
    initOtel("http://otel:4318");
    await flushMicrotasks();
    const warnCallsAfterFirst = warnSpy.mock.calls.length;

    initOtel("http://otel:4318");
    await flushMicrotasks();
    expect(warnSpy.mock.calls.length).toBe(warnCallsAfterFirst);
  });

  it("resetOtelForTest shuts down pending SDK startup and ignores stale completion [ERR-04]", async () => {
    initOtel("http://otel:first");
    await flushMicrotasks();
    const first = sdkInstances[0];
    expect(first).toBeDefined();

    resetOtelForTest();
    expect(first?.shutdown).toHaveBeenCalledTimes(1);

    initOtel("http://otel:second");
    await flushMicrotasks();
    const second = sdkInstances[1];
    expect(second).toBeDefined();

    first?.resolveStart();
    await flushMicrotasks();

    await import("./otel.js").then(({ shutdownOtel }) => shutdownOtel());

    expect(first?.shutdown).toHaveBeenCalledTimes(1);
    expect(second?.shutdown).toHaveBeenCalledTimes(1);
  });

  it("retries init after async start failure and logs the failed endpoint [ERR-07]", async () => {
    initOtel("http://otel:first");
    await flushMicrotasks();
    const first = sdkInstances[0];
    expect(first).toBeDefined();

    first?.rejectStart(new Error("collector down"));
    await flushMicrotasks();

    expect(errorSpy).toHaveBeenCalledWith("otel", "start failed", {
      err: "Error: collector down",
      endpoint: "http://otel:first",
    });

    initOtel("http://otel:retry");
    await flushMicrotasks();
    expect(sdkInstances).toHaveLength(2);
  });
});
