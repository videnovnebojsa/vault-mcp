import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// otel.ts has module-level state (sdkStarted). Each describe block that calls initOtel
// must isolate the module so the flag resets between tests.

vi.mock("./logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe("otelSpan — before initOtel", () => {
  it("returns a noop span that does not throw when end() is called", async () => {
    const { otelSpan } = await import("./otel.js");
    const span = otelSpan("vault_read_note", "default");
    expect(() => span.end()).not.toThrow();
    expect(() => span.end({ "tool.error": false })).not.toThrow();
  });
});

describe("initOtel — idempotency", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not re-enter init body on second call", async () => {
    // Use a require mock that always throws so we can count entries into the try block.
    // If sdkStarted guards correctly, require is called at most once across two initOtel calls.
    vi.doMock("./logger.js", () => ({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }));

    const { initOtel } = await import("./otel.js");
    const { logger } = await import("./logger.js");
    const warnSpy = logger.warn as ReturnType<typeof vi.fn>;

    // First call — will fail because OTel packages aren't installed, logs a warning
    initOtel("http://otel:4318");
    const warnCallsAfterFirst = warnSpy.mock.calls.length;

    // Second call — sdkStarted is true, must be a no-op (no extra warn calls)
    initOtel("http://otel:4318");
    expect(warnSpy.mock.calls.length).toBe(warnCallsAfterFirst);
  });
});

describe("shutdownOtel", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves without throwing when OTel SDK was never initialised", async () => {
    vi.doMock("./logger.js", () => ({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }));
    const { shutdownOtel } = await import("./otel.js");
    await expect(shutdownOtel()).resolves.toBeUndefined();
  });
});

describe("initOtel — package unavailable", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs the real error message (not hardcoded 'Package not found')", async () => {
    vi.doMock("./logger.js", () => ({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }));

    const { initOtel } = await import("./otel.js");
    const { logger } = await import("./logger.js");
    const warnSpy = logger.warn as ReturnType<typeof vi.fn>;

    // OTel packages aren't installed in this project — require will throw a real MODULE_NOT_FOUND.
    initOtel("");

    expect(warnSpy).toHaveBeenCalledOnce();
    const [, , extra] = warnSpy.mock.calls[0];
    // The err field must contain the real error, not the old hardcoded string
    expect(extra?.err).toBeDefined();
    expect(typeof extra?.err).toBe("string");
    expect(extra?.err).not.toBe("Package not found");
  });
});
