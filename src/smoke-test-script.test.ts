import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { assertOkResponse, buildSmokeEnv, drainTextStream, parseToolsListResponse } from "../scripts/smoke-test-lib.js";

describe("smoke test helpers", () => {
  it("declares the Bun runtime in the smoke test script itself [ARCH-05]", () => {
    const script = fs.readFileSync(path.join(process.cwd(), "scripts/smoke-test.ts"), "utf8");

    expect(script.split("\n")[0]).toBe("#!/usr/bin/env bun");
  });

  it("fails tools/list when HTTP status is not ok [QA-03]", async () => {
    const res = new Response("upstream failure", { status: 503, statusText: "Service Unavailable" });

    await expect(assertOkResponse(res, "tools/list")).rejects.toThrow(
      "FAIL: tools/list returned HTTP 503 Service Unavailable: upstream failure",
    );
  });

  it("reports malformed tools/list SSE without exposing a JSON.parse stack [ERR-03]", () => {
    expect(() => parseToolsListResponse("event: message\ndata: {not-json}\n\n")).toThrow(
      "FAIL: tools/list returned malformed SSE JSON",
    );
  });

  it("drains binary stderr so startup panics are visible in CI [ERR-04]", async () => {
    const chunks: string[] = [];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("panic: missing sqlite\n"));
        controller.close();
      },
    });

    await drainTextStream(stream, (chunk) => chunks.push(chunk));

    expect(chunks.join("")).toBe("panic: missing sqlite\n");
  });

  it("does not forward unrelated process.env secrets to the smoke binary [SEC-04]", () => {
    const env = buildSmokeEnv(
      { PATH: "/usr/bin", HOME: "/tmp/home", GITHUB_TOKEN: "secret", AWS_SECRET_ACCESS_KEY: "secret" },
      "/tmp/vault",
    );

    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/tmp/home", OBSIDIAN_VAULT_PATH: "/tmp/vault", MCP_PORT: "3783" });
  });
});
