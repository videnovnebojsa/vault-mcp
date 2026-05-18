import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { logger } from "./logger.js";

describe("logger", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Force text mode so the module caches text format regardless of caller environment
    process.env.LOG_FORMAT = "text";
    spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    process.env.LOG_LEVEL = originalEnv.LOG_LEVEL;
    process.env.LOG_FORMAT = originalEnv.LOG_FORMAT;
    mock.restore();
  });

  it("child logger emits with bound tag", () => {
    const log = logger.child("tasks:sync");
    log.info("pushed 3 tasks");
    expect(console.error).toHaveBeenCalledWith("[tasks:sync]", "pushed 3 tasks");
  });

  it("child logger passes extra to emit", () => {
    const log = logger.child("http");
    log.warn("slow request", { ms: 1200 });
    expect(console.error).toHaveBeenCalledWith("[http]", "slow request", { ms: 1200 });
  });

  it("child logger respects all log levels", () => {
    const log = logger.child("test");
    log.info("info msg");
    log.warn("warn msg");
    log.error("error msg");
    expect(console.error).toHaveBeenCalledTimes(3);
  });

  it("emits structured JSON when imported with LOG_FORMAT=json in a fresh process [ARCH-05]", () => {
    const proc = Bun.spawnSync({
      cmd: [
        "/Users/nebo/.bun/bin/bun",
        "--eval",
        [
          'const { logger } = await import("./src/utils/logger.ts");',
          'logger.info("json-test", "hello", { requestId: "r1" });',
        ].join(" "),
      ],
      cwd: process.cwd(),
      env: { ...process.env, LOG_FORMAT: "json", LOG_LEVEL: "info" },
      stderr: "pipe",
      stdout: "pipe",
    });

    expect(proc.exitCode).toBe(0);
    const stderr = proc.stderr.toString().trim();
    expect(stderr).toBeTruthy();
    const entry = JSON.parse(stderr) as Record<string, unknown>;
    expect(entry).toMatchObject({
      level: "info",
      tag: "json-test",
      message: "hello",
      requestId: "r1",
    });
    expect(typeof entry.ts).toBe("string");
  });
});
