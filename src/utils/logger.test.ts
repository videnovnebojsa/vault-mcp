import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("logger", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Force text mode so the module caches text format regardless of caller environment
    process.env.LOG_FORMAT = "text";
    vi.resetModules();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    process.env.LOG_LEVEL = originalEnv.LOG_LEVEL;
    process.env.LOG_FORMAT = originalEnv.LOG_FORMAT;
    vi.restoreAllMocks();
  });

  it("child logger emits with bound tag", async () => {
    const { logger } = await import("./logger.js");
    const log = logger.child("tasks:sync");
    log.info("pushed 3 tasks");
    expect(console.error).toHaveBeenCalledWith("[tasks:sync]", "pushed 3 tasks");
  });

  it("child logger passes extra to emit", async () => {
    const { logger } = await import("./logger.js");
    const log = logger.child("http");
    log.warn("slow request", { ms: 1200 });
    expect(console.error).toHaveBeenCalledWith("[http]", "slow request", { ms: 1200 });
  });

  it("child logger respects all log levels", async () => {
    const { logger } = await import("./logger.js");
    const log = logger.child("test");
    log.info("info msg");
    log.warn("warn msg");
    log.error("error msg");
    expect(console.error).toHaveBeenCalledTimes(3);
  });
});
