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

  it("covers tool error envelopes in the integration test [API-05]", () => {
    const script = fs.readFileSync(path.join(process.cwd(), "scripts/integration-test.ts"), "utf8");

    expect(script).toContain("callToolExpectError");
    expect(script).toContain("vault_read_note (missing note error contract)");
    expect(script).toContain("NOT_FOUND");
  });

  it("probes readiness before sleeping in the integration test [PERF-06]", () => {
    const script = fs.readFileSync(path.join(process.cwd(), "scripts/integration-test.ts"), "utf8");

    expect(script).not.toContain('await Bun.sleep(500);\n  process.stdout.write(".");');
    expect(script).toContain('process.stdout.write(".");\n  await Bun.sleep(500);');
  });

  it("does not use vacuous optional item assertions in the integration test [QA-06]", () => {
    const script = fs.readFileSync(path.join(process.cwd(), "scripts/integration-test.ts"), "utf8");

    expect(script).not.toContain("!items?.some");
  });

  it("asserts semantic vault_classify output in the integration test [QA-07]", () => {
    const script = fs.readFileSync(path.join(process.cwd(), "scripts/integration-test.ts"), "utf8");

    expect(script).toContain('assertEqual(d.suggested_folder, "10_Projects"');
    expect(script).toContain('assertTruthy(d.tags?.includes("project")');
  });

  it("verifies the original path is absent after move in the integration test [QA-11]", () => {
    const script = fs.readFileSync(path.join(process.cwd(), "scripts/integration-test.ts"), "utf8");

    expect(script).toContain("vault_read_note (verify original path absent after move)");
    expect(script).toContain('callToolExpectError("vault_read_note", { path: "test-write" }, "NOT_FOUND")');
  });

  it("keeps raw SSE response text on integration parse failures [ERR-04]", () => {
    const script = fs.readFileSync(path.join(process.cwd(), "scripts/smoke-test-lib.ts"), "utf8");

    expect(script).toContain("Raw response:");
  });

  it("rejects non-numeric INTEGRATION_TEST_PORT before writing .env [SEC-02]", () => {
    const script = fs.readFileSync(path.join(process.cwd(), "scripts/integration-test.ts"), "utf8");

    expect(script).toContain("INTEGRATION_TEST_PORT must be a number");
  });

  it("reuses shared SSE parsing and log draining helpers in the integration test [QA-09]", () => {
    const script = fs.readFileSync(path.join(process.cwd(), "scripts/integration-test.ts"), "utf8");

    expect(script).toContain('from "./smoke-test-lib.js"');
    expect(script).toContain("parseSseResponse");
    expect(script).toContain("drainTextStream");
    expect(script).not.toContain("function parseSse(");
    expect(script).not.toContain("const drainLog =");
  });
});
