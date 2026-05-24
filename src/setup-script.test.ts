import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import path from "node:path";

import { expandHome, readExistingConfig } from "../scripts/setup";

describe("setup script helpers", () => {
  it("expands the current user's home directory for ~ and ~user paths [SETUP-01]", () => {
    expect(expandHome("~")).toBe(homedir());
    expect(expandHome("~/vault")).toBe(path.join(homedir(), "vault"));
    expect(expandHome(`~${userInfo().username}/vault`)).toBe(path.join(homedir(), "vault"));
  });

  it("parses existing config defaults from the installed env file format [SETUP-01]", () => {
    const fixtureDir = mkdtempSync(path.join(tmpdir(), "vault-mcp-setup-test-"));
    const envPath = path.join(fixtureDir, ".env");

    try {
      writeFileSync(
        envPath,
        ["# comment", "OBSIDIAN_VAULT_PATH=/Users/test/Vault", "MCP_PORT=4891", "MCP_API_KEY=secret"].join("\n"),
      );

      expect(readExistingConfig(envPath)).toEqual({
        vaultPath: "/Users/test/Vault",
        port: 4891,
      });
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});
