import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";

describe("documented test commands", () => {
  it("routes the documented full test command through the package script that pins --isolate [QA-01]", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const readme = fs.readFileSync(path.join(process.cwd(), "README.md"), "utf8");

    expect(pkg.scripts["test"]).toContain("--isolate");
    expect(readme).toContain("bun run test");
  });

  it("keeps install docs aligned on the managed config path [SETUP-01]", () => {
    const readme = fs.readFileSync(path.join(process.cwd(), "README.md"), "utf8");
    const installation = fs.readFileSync(path.join(process.cwd(), "docs/installation.md"), "utf8");

    expect(readme).toContain("~/.config/vault-mcp/.env");
    expect(installation).toContain("~/.config/vault-mcp/.env");
    expect(installation).toContain("~/Library/Logs/vault-mcp/vault-mcp.err");
  });

  it("covers confirmed hard delete in the integration script [QA-02]", () => {
    const integration = fs.readFileSync(path.join(process.cwd(), "scripts/integration-test.ts"), "utf8");

    expect(integration).toContain("trash: false");
    expect(integration).toContain("confirm: true");
    expect(integration).toContain("hard-deleted note absent");
  });

  it("verifies soft-delete trashName and .trash location in the integration script [QA-03]", () => {
    const integration = fs.readFileSync(path.join(process.cwd(), "scripts/integration-test.ts"), "utf8");

    expect(integration).toContain("trashName");
    expect(integration).toContain('join(vaultPath, ".trash"');
  });

  it("reports binary crashes distinctly during integration tool calls [QA-04]", () => {
    const integration = fs.readFileSync(path.join(process.cwd(), "scripts/integration-test.ts"), "utf8");

    expect(integration).toContain("binary exited during");
    expect(integration).toContain("getBinaryExitCode");
  });

  it("sends MCP notifications/initialized in the integration script [ARCH-03]", () => {
    const integration = fs.readFileSync(path.join(process.cwd(), "scripts/integration-test.ts"), "utf8");

    expect(integration).toContain('"notifications/initialized"');
    expect(integration).toContain("OK  notifications/initialized");
  });

  it("cleans up the spawned binary on integration script signals [ARCH-04]", () => {
    const integration = fs.readFileSync(path.join(process.cwd(), "scripts/integration-test.ts"), "utf8");

    expect(integration).toContain('process.on("SIGINT"');
    expect(integration).toContain('process.on("SIGTERM"');
    expect(integration).toContain("cleanupAndExit");
  });

  it("keeps the /health source comment aligned with stateless mode [API-01]", () => {
    const httpSource = fs.readFileSync(path.join(process.cwd(), "src/http.ts"), "utf8");

    expect(httpSource).not.toContain("session count");
    expect(httpSource).not.toContain("session counts");
  });

  it("removes stale mcp-session-id handling from smoke and integration scripts [ARCH-02]", () => {
    const smoke = fs.readFileSync(path.join(process.cwd(), "scripts/smoke-test.ts"), "utf8");
    const integration = fs.readFileSync(path.join(process.cwd(), "scripts/integration-test.ts"), "utf8");

    expect(smoke).not.toContain("mcp-session-id");
    expect(smoke).not.toContain("sessionId");
    expect(integration).not.toContain("mcp-session-id");
    expect(integration).not.toContain("sessionId = initRes.headers.get");
  });
});
