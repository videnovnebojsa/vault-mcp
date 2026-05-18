import { describe, expect, it, mock } from "bun:test";
import { createShutdown } from "./shutdown.js";

describe("createShutdown", () => {
  it("runs cleanup exactly once when shutdown is called twice", async () => {
    const cleanup = mock().mockResolvedValue(undefined);
    const exit = mock();
    const shutdown = createShutdown({ cleanup, exit, timeoutMs: 10_000 });

    await Promise.all([shutdown(), shutdown()]);

    expect(cleanup).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
  });
});
