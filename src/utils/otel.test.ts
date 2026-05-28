import { afterEach, beforeEach, describe, expect, it, jest, spyOn } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { logger } from "./logger.js";
import { otelSpan, shutdownOtel } from "./otel.js";
import { injectSdkForTest, resetOtelForTest } from "./otel-test-support.js";

// Tests that do not call initOtel — no module isolation needed.
describe("otelSpan — before initOtel", () => {
  it("returns a noop span that does not throw when end() is called", () => {
    const span = otelSpan("vault_read_note", "default");
    expect(() => span.end()).not.toThrow();
    expect(() => span.end({ "tool.error": false })).not.toThrow();
  });

  it("returns a callable noop (not null/undefined) before initOtel — no startup drop window", () => {
    const span = otelSpan("vault_read_note", "default");
    expect(span).toBeDefined();
    expect(typeof span.end).toBe("function");
    expect(() => span.end()).not.toThrow();
  });

  it("keeps the OTel test reset hook out of the production module export surface [ARCH-03]", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src/utils/otel.ts"), "utf8");
    const testSupport = fs.readFileSync(path.join(process.cwd(), "src/utils/otel-test-support.ts"), "utf8");

    expect(source).not.toContain("export function __resetForTest");
    expect(testSupport).toContain("resetOtelForTest");
  });

  it("warn message for missing deps does not imply install is the only fix [ERR-12]", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src/utils/otel.ts"), "utf8");
    expect(source).not.toContain("install @opentelemetry");
    expect(source).toContain("@opentelemetry/sdk-node");
  });

  it("loads optional OTel modules via import() instead of createRequire [SEC-04] [PERF-07]", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src/utils/otel.ts"), "utf8");

    expect(source).not.toContain("createRequire");
    expect(source).toContain('import("@opentelemetry/sdk-node")');
  });

  it("resetOtelForTest is guarded from production use [SEC-01]", () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(() => resetOtelForTest()).toThrow("resetOtelForTest is only available outside production");
    } finally {
      if (original === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = original;
    }
  });
});

describe("resetOtelForTest — correctness [QA-09]", () => {
  afterEach(() => {
    resetOtelForTest();
  });

  it("restores noop span behavior after reset", () => {
    resetOtelForTest();
    const span = otelSpan("test_tool", "default");
    expect(typeof span.end).toBe("function");
    expect(() => span.end()).not.toThrow();
  });

  it("is idempotent — repeated resets do not throw", () => {
    expect(() => {
      resetOtelForTest();
      resetOtelForTest();
      resetOtelForTest();
    }).not.toThrow();
  });

  it("allows injectSdkForTest to activate sdkRef after reset", () => {
    resetOtelForTest();
    const mockShutdown = jest.fn().mockResolvedValue(undefined);
    injectSdkForTest({ shutdown: mockShutdown });
    // shutdownOtel should call the injected sdk's shutdown
    void shutdownOtel().then(() => {
      expect(mockShutdown).toHaveBeenCalled();
    });
  });
});

describe("shutdownOtel — timeout branch [QA-05]", () => {
  beforeEach(() => {
    resetOtelForTest();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    resetOtelForTest();
  });

  it("resolves via timeout when SDK shutdown hangs and logs a warning", async () => {
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    // Inject a never-resolving SDK shutdown
    injectSdkForTest({ shutdown: () => new Promise(() => {}) });

    const shutdownPromise = shutdownOtel();

    // Drain microtasks so the Promise.race starts
    for (let i = 0; i < 10; i++) await Promise.resolve();
    jest.advanceTimersByTime(5001);
    for (let i = 0; i < 10; i++) await Promise.resolve();

    await shutdownPromise;

    expect(warnSpy).toHaveBeenCalledWith("otel", "shutdown timed out", { timeoutMs: 5000 });
    warnSpy.mockRestore();
  });
});
