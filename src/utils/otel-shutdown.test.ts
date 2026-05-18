import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { logger } from "./logger.js";
import { shutdownOtel } from "./otel.js";
import { resetOtelForTest } from "./otel-test-support.js";

// Each file gets isolated module state — sdkStarted flag is fresh here.

describe("shutdownOtel", () => {
  afterEach(() => {
    mock.restore();
  });

  it("resolves without throwing when OTel SDK was never initialised", async () => {
    resetOtelForTest();
    spyOn(logger, "warn").mockImplementation(() => {});
    await expect(shutdownOtel()).resolves.toBeUndefined();
  });
});
