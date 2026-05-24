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
});
