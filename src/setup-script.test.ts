import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import path from "node:path";

import { createVaultFolders, expandHome, readExistingConfig } from "../scripts/setup";
import { resolveVaultFolders, VAULT_FOLDERS } from "./config/folders.js";

describe("createVaultFolders", () => {
  it("creates each folder inside vaultPath and returns created names [ERR-06]", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "vault-mcp-setup-"));
    try {
      const created = createVaultFolders(dir, ["00_Inbox", "10_Projects"]);
      expect(created).toEqual(["00_Inbox", "10_Projects"]);
      expect(existsSync(path.join(dir, "00_Inbox"))).toBe(true);
      expect(existsSync(path.join(dir, "10_Projects"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips folders that already exist without error [ERR-06]", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "vault-mcp-setup-"));
    try {
      createVaultFolders(dir, ["00_Inbox"]);
      // idempotent — second call must not throw
      expect(() => createVaultFolders(dir, ["00_Inbox"])).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("includes folder name in error message when creation fails [ERR-06]", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "vault-mcp-setup-"));
    try {
      // Make a *file* at the path where a folder would go — mkdirSync will throw EEXIST/ENOTDIR
      const blockingFile = path.join(dir, "00_Inbox");
      writeFileSync(blockingFile, "block");
      // recursive:true still fails when target path exists as a file (not dir) on some platforms,
      // but to guarantee failure we pass a path whose parent is a file
      const impossibleParent = path.join(blockingFile, "sub");
      expect(() => createVaultFolders(dir, [path.join("00_Inbox", "sub")])).toThrow(/00_Inbox/);
      void impossibleParent; // referenced for clarity
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

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

// ── ARCH-03: setup respects VAULT_FOLDER_* env overrides ─────────────────────

describe("resolveVaultFolders integration with createVaultFolders [ARCH-03]", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of Object.keys(VAULT_FOLDERS).map((k) => `VAULT_FOLDER_${k}`)) {
      savedEnv[key] = process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("resolveVaultFolders returns custom INBOX when env var is set [ARCH-03]", () => {
    process.env.VAULT_FOLDER_INBOX = "CustomInbox";
    const folders = resolveVaultFolders();
    expect(folders.INBOX).toBe("CustomInbox");
    expect(folders.INBOX).not.toBe(VAULT_FOLDERS.INBOX);
  });

  it("createVaultFolders creates all 10 default folders when called with resolveVaultFolders() [QA-11]", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "vault-mcp-qa11-"));
    try {
      const resolved = resolveVaultFolders();
      const allFolders = Object.values(resolved);
      expect(allFolders).toHaveLength(10);
      const created = createVaultFolders(dir, allFolders);
      expect(created).toHaveLength(10);
      for (const folderName of allFolders) {
        expect(existsSync(path.join(dir, folderName))).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("createVaultFolders creates the resolved custom folder on disk [ARCH-03]", () => {
    process.env.VAULT_FOLDER_INBOX = "MyPrivateInbox";
    const dir = mkdtempSync(path.join(tmpdir(), "vault-mcp-arch03-"));
    try {
      const resolved = Object.values(resolveVaultFolders());
      const created = createVaultFolders(dir, resolved);
      expect(created).toContain("MyPrivateInbox");
      expect(existsSync(path.join(dir, "MyPrivateInbox"))).toBe(true);
      // Compile-time default must NOT have been created
      expect(existsSync(path.join(dir, VAULT_FOLDERS.INBOX))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
