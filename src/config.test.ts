import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const ORIG_ENV = process.env;

beforeEach(() => {
  process.env = { ...ORIG_ENV };
  process.env["OBSIDIAN_VAULT_PATH"] = os.tmpdir();
  process.env["MEMORY_DB_PATH"] = ":memory:";
});

afterEach(() => {
  process.env = ORIG_ENV;
});

// ── parseNamedVaults (via loadConfig) ─────────────────────────────────────────

describe("parseNamedVaults", () => {
  it("returns only default when VAULT_PATHS is unset", () => {
    delete process.env["VAULT_PATHS"];
    const { namedVaults } = loadConfig();
    expect(Object.keys(namedVaults)).toEqual(["default"]);
    expect(namedVaults["default"]).toBe(path.resolve(os.tmpdir()));
  });

  it("returns only default when VAULT_PATHS is empty", () => {
    process.env["VAULT_PATHS"] = "";
    const { namedVaults } = loadConfig();
    expect(Object.keys(namedVaults)).toEqual(["default"]);
  });

  it("parses a valid multi-vault string", () => {
    process.env["VAULT_PATHS"] = `work:${os.tmpdir()};personal:${os.tmpdir()}`;
    const { namedVaults } = loadConfig();
    expect(namedVaults["work"]).toBe(path.resolve(os.tmpdir()));
    expect(namedVaults["personal"]).toBe(path.resolve(os.tmpdir()));
    expect(namedVaults["default"]).toBeDefined();
  });

  it("ignores entries that try to overwrite the reserved 'default' name", () => {
    const otherPath = path.join(os.tmpdir(), "other");
    process.env["VAULT_PATHS"] = `default:${otherPath}`;
    const { namedVaults } = loadConfig();
    // 'default' must still point to OBSIDIAN_VAULT_PATH, not otherPath
    expect(namedVaults["default"]).toBe(path.resolve(os.tmpdir()));
    expect(Object.keys(namedVaults)).toEqual(["default"]);
  });

  it("rejects vault names with path-injection characters", () => {
    process.env["VAULT_PATHS"] = `../../evil:${os.tmpdir()}`;
    const { namedVaults } = loadConfig();
    // invalid name must be dropped
    expect(Object.keys(namedVaults)).toEqual(["default"]);
  });

  it("rejects vault names with spaces or special characters", () => {
    process.env["VAULT_PATHS"] = `my vault:${os.tmpdir()}`;
    const { namedVaults } = loadConfig();
    expect(Object.keys(namedVaults)).toEqual(["default"]);
  });

  it("accepts names with letters, digits, hyphens, and underscores", () => {
    process.env["VAULT_PATHS"] = `my-vault_2:${os.tmpdir()}`;
    const { namedVaults } = loadConfig();
    expect(namedVaults["my-vault_2"]).toBeDefined();
  });

  it("expands tilde in vault paths", () => {
    process.env["VAULT_PATHS"] = "work:~/Documents/work-vault";
    const { namedVaults } = loadConfig();
    expect(namedVaults["work"]).toMatch(/^\/Users\/|^\/home\//);
    expect(namedVaults["work"]).not.toContain("~");
  });
});

// ── safeInt / integer env vars ───────────────────────────────────────────────

describe("integer env var parsing (safeInt)", () => {
  it("uses default when env var is absent", () => {
    delete process.env["MCP_PORT"];
    const { mcpPort } = loadConfig();
    expect(mcpPort).toBe(3782);
  });

  it("parses valid integer env var", () => {
    process.env["MCP_PORT"] = "4000";
    const { mcpPort } = loadConfig();
    expect(mcpPort).toBe(4000);
  });

  it("falls back to default for non-numeric value", () => {
    process.env["MCP_PORT"] = "not-a-number";
    const { mcpPort } = loadConfig();
    expect(mcpPort).toBe(3782);
  });

  it("falls back to default for empty string", () => {
    process.env["EMBED_BATCH_SIZE"] = "";
    const config = loadConfig();
    expect(config.embedding.batchSize).toBe(20);
  });

  it("parses TOOL_TIMEOUT_MS", () => {
    process.env["TOOL_TIMEOUT_MS"] = "5000";
    const { toolTimeoutMs } = loadConfig();
    expect(toolTimeoutMs).toBe(5000);
  });

  it("uses default 30000 for TOOL_TIMEOUT_MS when absent", () => {
    delete process.env["TOOL_TIMEOUT_MS"];
    const { toolTimeoutMs } = loadConfig();
    expect(toolTimeoutMs).toBe(30_000);
  });
});

// ── parsePathList / ACL ───────────────────────────────────────────────────────

describe("parsePathList (ACL env vars)", () => {
  it("returns empty array when env var is absent", () => {
    delete process.env["VAULT_ALLOW_PATHS"];
    const { acl } = loadConfig();
    expect(acl.allowPaths).toEqual([]);
  });

  it("returns empty array when env var is empty string", () => {
    process.env["VAULT_ALLOW_PATHS"] = "";
    const { acl } = loadConfig();
    expect(acl.allowPaths).toEqual([]);
  });

  it("parses a single path", () => {
    process.env["VAULT_ALLOW_PATHS"] = "10_Projects";
    const { acl } = loadConfig();
    expect(acl.allowPaths).toEqual(["10_Projects"]);
  });

  it("parses multiple comma-separated paths", () => {
    process.env["VAULT_DENY_PATHS"] = "00_Inbox,90_Admin , .obsidian";
    const { acl } = loadConfig();
    expect(acl.denyPaths).toEqual(["00_Inbox", "90_Admin", ".obsidian"]);
  });
});

// ── boolean feature flags ─────────────────────────────────────────────────────

describe("boolean feature flags", () => {
  it("embeddings disabled by default", () => {
    delete process.env["ENABLE_EMBEDDINGS"];
    expect(loadConfig().embedding.enabled).toBe(false);
  });

  it("embeddings enabled when ENABLE_EMBEDDINGS=true", () => {
    process.env["ENABLE_EMBEDDINGS"] = "true";
    expect(loadConfig().embedding.enabled).toBe(true);
  });

  it("watcher enabled by default", () => {
    delete process.env["ENABLE_FILE_WATCHER"];
    expect(loadConfig().watcher.enabled).toBe(true);
  });

  it("watcher disabled when ENABLE_FILE_WATCHER=false", () => {
    process.env["ENABLE_FILE_WATCHER"] = "false";
    expect(loadConfig().watcher.enabled).toBe(false);
  });

  it("backup enabled by default", () => {
    delete process.env["ENABLE_DB_BACKUP"];
    expect(loadConfig().backup.enabled).toBe(true);
  });

  it("capture disabled by default", () => {
    delete process.env["ENABLE_CAPTURE_PIPELINE"];
    expect(loadConfig().capture.enableCapturePipeline).toBe(false);
  });
});

// ── hybridAlpha clamping ──────────────────────────────────────────────────────

describe("HYBRID_ALPHA clamping", () => {
  it("defaults to 0.5 when unset", () => {
    delete process.env["HYBRID_ALPHA"];
    expect(loadConfig().embedding.hybridAlpha).toBe(0.5);
  });

  it("defaults to 0.5 for non-numeric value", () => {
    process.env["HYBRID_ALPHA"] = "bad";
    expect(loadConfig().embedding.hybridAlpha).toBe(0.5);
  });

  it("clamps value above 1.0 to 1.0", () => {
    process.env["HYBRID_ALPHA"] = "1.5";
    expect(loadConfig().embedding.hybridAlpha).toBe(1.0);
  });

  it("clamps value below 0 to 0", () => {
    process.env["HYBRID_ALPHA"] = "-0.5";
    expect(loadConfig().embedding.hybridAlpha).toBe(0);
  });

  it("accepts valid value in range", () => {
    process.env["HYBRID_ALPHA"] = "0.7";
    expect(loadConfig().embedding.hybridAlpha).toBeCloseTo(0.7);
  });
});

// ── CLASSIFY_RULES_PATH ───────────────────────────────────────────────────────

describe("CLASSIFY_RULES_PATH", () => {
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `classify-rules-${Date.now()}.json`);
  });

  afterEach(() => {
    delete process.env["CLASSIFY_RULES_PATH"];
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      /* already removed */
    }
  });

  it("populates classifyRules from a valid file", () => {
    const rules = { meeting: { keywords: ["agenda", "standup"], folder: "Meetings" } };
    fs.writeFileSync(tmpFile, JSON.stringify(rules));
    process.env["CLASSIFY_RULES_PATH"] = tmpFile;

    const { classifyRules } = loadConfig();
    expect(classifyRules?.["meeting"]?.folder).toBe("Meetings");
    expect(classifyRules?.["meeting"]?.keywords).toContain("agenda");
  });

  it("throws on invalid JSON", () => {
    fs.writeFileSync(tmpFile, "not-json{{");
    process.env["CLASSIFY_RULES_PATH"] = tmpFile;

    expect(() => loadConfig()).toThrow(/CLASSIFY_RULES_PATH/);
  });

  it("throws when shape is invalid (keywords is not an array)", () => {
    const badRules = { meeting: { keywords: 42, folder: "Meetings" } };
    fs.writeFileSync(tmpFile, JSON.stringify(badRules));
    process.env["CLASSIFY_RULES_PATH"] = tmpFile;

    expect(() => loadConfig()).toThrow(/CLASSIFY_RULES_PATH/);
  });

  it("throws ENOENT when the file does not exist", () => {
    process.env["CLASSIFY_RULES_PATH"] = "/nonexistent/path/rules.json";
    expect(() => loadConfig()).toThrow(/CLASSIFY_RULES_PATH/);
  });
});
