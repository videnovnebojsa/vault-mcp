import { describe, expect, it, mock } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
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

  it("does not discard the shutdown promise in the unhandledRejection handler [ERR-05]", () => {
    const source = readFileSync(path.join(process.cwd(), "src/index.ts"), "utf8");

    expect(source).toContain("shutdown().catch((err) =>");
    expect(source).not.toContain("void shutdown();");
  });
});
