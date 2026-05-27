import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { computeChanges, SECTIONS, showDiff, validateSetting } from "../scripts/configure";
import { parseEnvFile, renderEnvTemplate } from "../scripts/lib/env-io";

// ── parseEnvFile ──────────────────────────────────────────────────────────────

describe("parseEnvFile", () => {
  it("parses active key=value lines [CFG-01]", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "vault-mcp-cfg-test-"));
    const f = path.join(dir, ".env");
    try {
      writeFileSync(
        f,
        ["# comment line", "", "OBSIDIAN_VAULT_PATH=/Users/test/Vault", "MCP_PORT=4000", "ENABLE_EMBEDDINGS=true"].join(
          "\n",
        ),
      );
      const map = parseEnvFile(f);
      expect(map.get("OBSIDIAN_VAULT_PATH")).toBe("/Users/test/Vault");
      expect(map.get("MCP_PORT")).toBe("4000");
      expect(map.get("ENABLE_EMBEDDINGS")).toBe("true");
      expect(map.has("# comment line")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores comment lines and blank lines [CFG-02]", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "vault-mcp-cfg-test-"));
    const f = path.join(dir, ".env");
    try {
      writeFileSync(f, ["# MCP_PORT=3782", "# ENABLE_EMBEDDINGS=false", ""].join("\n"));
      const map = parseEnvFile(f);
      expect(map.size).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns an empty Map when the file does not exist [CFG-03]", () => {
    const map = parseEnvFile("/non/existent/path/.env");
    expect(map.size).toBe(0);
  });

  it("handles values containing = signs [CFG-04]", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "vault-mcp-cfg-test-"));
    const f = path.join(dir, ".env");
    try {
      writeFileSync(f, "EMBEDDING_ENDPOINT=https://api.example.com/v1?key=abc");
      const map = parseEnvFile(f);
      expect(map.get("EMBEDDING_ENDPOINT")).toBe("https://api.example.com/v1?key=abc");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores lines with lowercase keys (not env var format) [CFG-05]", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "vault-mcp-cfg-test-"));
    const f = path.join(dir, ".env");
    try {
      writeFileSync(f, ["lowercase_key=value", "VALID_KEY=ok"].join("\n"));
      const map = parseEnvFile(f);
      expect(map.has("lowercase_key")).toBe(false);
      expect(map.get("VALID_KEY")).toBe("ok");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── renderEnvTemplate ─────────────────────────────────────────────────────────

describe("renderEnvTemplate", () => {
  it("emits active lines for keys present in the map [CFG-10]", () => {
    const values = new Map([
      ["OBSIDIAN_VAULT_PATH", "/Users/test/vault"],
      ["MCP_PORT", "4000"],
      ["ENABLE_EMBEDDINGS", "true"],
    ]);
    const output = renderEnvTemplate(values, "systemctl restart vault-mcp");
    expect(output).toContain("OBSIDIAN_VAULT_PATH=/Users/test/vault");
    expect(output).toContain("MCP_PORT=4000");
    expect(output).toContain("ENABLE_EMBEDDINGS=true");
  });

  it("emits commented-out lines for absent keys [CFG-11]", () => {
    const values = new Map([["OBSIDIAN_VAULT_PATH", "/Users/test/vault"]]);
    const output = renderEnvTemplate(values, "restart");
    expect(output).toContain("# MCP_PORT=");
    expect(output).toContain("# ENABLE_EMBEDDINGS=");
    expect(output).toContain("# TOOL_TIMEOUT_MS=");
  });

  it("round-trips: parse(render(map)) recovers the original values [CFG-12]", () => {
    const values = new Map([
      ["OBSIDIAN_VAULT_PATH", "/vault"],
      ["MCP_PORT", "5000"],
      ["ENABLE_EMBEDDINGS", "true"],
      ["EMBEDDING_ENDPOINT", "https://api.openai.com/v1"],
      ["LOG_LEVEL", "debug"],
    ]);
    const rendered = renderEnvTemplate(values, "restart");

    // Write to a temp file and parse back
    const dir = mkdtempSync(path.join(tmpdir(), "vault-mcp-cfg-test-"));
    const f = path.join(dir, ".env");
    try {
      writeFileSync(f, rendered);
      const parsed = parseEnvFile(f);
      for (const [key, val] of values) {
        expect(parsed.get(key)).toBe(val);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("embeds the restart command in the header comment [CFG-13]", () => {
    const cmd = "launchctl kickstart -k gui/$UID/com.vault-mcp";
    const output = renderEnvTemplate(new Map(), cmd);
    expect(output).toContain(`restart: ${cmd}`);
  });

  it("emits active VAULT_FOLDER_* line when value is set [CFG-14]", () => {
    const values = new Map([["VAULT_FOLDER_INBOX", "MyInbox"]]);
    const output = renderEnvTemplate(values, "restart");
    expect(output).toContain("VAULT_FOLDER_INBOX=MyInbox");
  });

  it("emits commented-out VAULT_FOLDER_* lines when values are absent [CFG-15]", () => {
    const output = renderEnvTemplate(new Map(), "restart");
    expect(output).toContain("# VAULT_FOLDER_INBOX=");
    expect(output).toContain("# VAULT_FOLDER_PROJECTS=");
    expect(output).toContain("# VAULT_FOLDER_ARCHIVE=");
  });

  it("round-trips VAULT_FOLDER_* values through render+parse [CFG-16]", () => {
    const values = new Map([
      ["VAULT_FOLDER_INBOX", "Inbox"],
      ["VAULT_FOLDER_PROJECTS", "Projects"],
      ["VAULT_FOLDER_ZETTELKASTEN", "Zettel"],
    ]);
    const rendered = renderEnvTemplate(values, "restart");
    const dir = mkdtempSync(path.join(tmpdir(), "vault-mcp-cfg-test-"));
    const f = path.join(dir, ".env");
    try {
      writeFileSync(f, rendered);
      const parsed = parseEnvFile(f);
      expect(parsed.get("VAULT_FOLDER_INBOX")).toBe("Inbox");
      expect(parsed.get("VAULT_FOLDER_PROJECTS")).toBe("Projects");
      expect(parsed.get("VAULT_FOLDER_ZETTELKASTEN")).toBe("Zettel");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── validateSetting ───────────────────────────────────────────────────────────

describe("validateSetting", () => {
  const findSetting = (key: string) => {
    for (const sec of SECTIONS) {
      const s = sec.settings.find((s) => s.key === key);
      if (s) return s;
    }
    throw new Error(`Setting not found: ${key}`);
  };

  it("accepts valid boolean values [CFG-20]", async () => {
    const s = findSetting("ENABLE_EMBEDDINGS");
    expect(await validateSetting(s, "true")).toBeNull();
    expect(await validateSetting(s, "false")).toBeNull();
    expect(await validateSetting(s, "TRUE")).toBeNull();
  });

  it("rejects invalid boolean values [CFG-21]", async () => {
    const s = findSetting("ENABLE_EMBEDDINGS");
    expect(await validateSetting(s, "yes")).not.toBeNull();
    expect(await validateSetting(s, "1")).not.toBeNull();
    expect(await validateSetting(s, "")).not.toBeNull();
  });

  it("accepts port in valid range [CFG-22]", async () => {
    const s = findSetting("MCP_PORT");
    expect(await validateSetting(s, "3782", "3782")).toBeNull(); // unchanged — skip in-use check
    expect(await validateSetting(s, "8080", "3782")).toBeNull(); // different port, not in use
  });

  it("rejects port out of range [CFG-23]", async () => {
    const s = findSetting("MCP_PORT");
    expect(await validateSetting(s, "80")).not.toBeNull(); // < 1024
    expect(await validateSetting(s, "99999")).not.toBeNull(); // > 65535
    expect(await validateSetting(s, "abc")).not.toBeNull(); // not a number
  });

  it("accepts valid http/https URLs [CFG-24]", async () => {
    const s = findSetting("EMBEDDING_ENDPOINT");
    expect(await validateSetting(s, "https://api.openai.com/v1")).toBeNull();
    expect(await validateSetting(s, "http://localhost:8080")).toBeNull();
  });

  it("rejects non-http URLs and malformed URLs [CFG-25]", async () => {
    const s = findSetting("EMBEDDING_ENDPOINT");
    expect(await validateSetting(s, "ftp://bad.com")).not.toBeNull();
    expect(await validateSetting(s, "not-a-url")).not.toBeNull();
    expect(await validateSetting(s, "ws://websocket.com")).not.toBeNull();
  });

  it("accepts valid float in range [CFG-26]", async () => {
    const s = findSetting("HYBRID_ALPHA");
    expect(await validateSetting(s, "0")).toBeNull();
    expect(await validateSetting(s, "0.5")).toBeNull();
    expect(await validateSetting(s, "1")).toBeNull();
  });

  it("rejects float out of range [CFG-27]", async () => {
    const s = findSetting("HYBRID_ALPHA");
    expect(await validateSetting(s, "-0.1")).not.toBeNull();
    expect(await validateSetting(s, "1.1")).not.toBeNull();
    expect(await validateSetting(s, "abc")).not.toBeNull();
  });

  it("accepts valid integer in range [CFG-28]", async () => {
    const s = findSetting("MCP_MAX_SESSIONS");
    expect(await validateSetting(s, "1")).toBeNull();
    expect(await validateSetting(s, "100")).toBeNull();
    expect(await validateSetting(s, "10000")).toBeNull();
  });

  it("rejects integer out of range [CFG-29]", async () => {
    const s = findSetting("MCP_MAX_SESSIONS");
    expect(await validateSetting(s, "0")).not.toBeNull();
    expect(await validateSetting(s, "99999")).not.toBeNull();
    expect(await validateSetting(s, "3.14")).not.toBeNull();
  });

  it("validates vault_paths format — valid input [CFG-30]", async () => {
    const s = findSetting("VAULT_PATHS");
    // We can't test actual path existence, but we can test format with paths that
    // don't exist — the format check happens before the existsSync
    // Valid format, path may not exist (will fail on path check, but format is ok)
    const err = await validateSetting(s, "work:/tmp;archive:/tmp");
    expect(err).toBeNull();
  });

  it("rejects vault_paths with missing colon separator [CFG-31]", async () => {
    const s = findSetting("VAULT_PATHS");
    expect(await validateSetting(s, "no-colon-here")).not.toBeNull();
  });

  it("rejects vault_paths with invalid name characters [CFG-32]", async () => {
    const s = findSetting("VAULT_PATHS");
    expect(await validateSetting(s, "bad name:/tmp")).not.toBeNull(); // space in name
    expect(await validateSetting(s, "bad@name:/tmp")).not.toBeNull(); // @ in name
  });

  it("accepts a plain folder name for VAULT_FOLDER_INBOX [CFG-33]", async () => {
    const s = findSetting("VAULT_FOLDER_INBOX");
    expect(await validateSetting(s, "MyInbox")).toBeNull();
    expect(await validateSetting(s, "00_Inbox")).toBeNull();
    expect(await validateSetting(s, "Inbox-2024")).toBeNull();
  });

  it("rejects forward slash in folder name [SEC-02-01]", async () => {
    const s = findSetting("VAULT_FOLDER_INBOX");
    expect(await validateSetting(s, "Inbox/sub")).not.toBeNull();
  });

  it("rejects backslash in folder name [SEC-02-02]", async () => {
    const s = findSetting("VAULT_FOLDER_INBOX");
    expect(await validateSetting(s, "Inbox\\sub")).not.toBeNull();
  });

  it("rejects '..' as folder name [SEC-02-03]", async () => {
    const s = findSetting("VAULT_FOLDER_INBOX");
    expect(await validateSetting(s, "..")).not.toBeNull();
  });

  it("rejects '.' as folder name [SEC-02-04]", async () => {
    const s = findSetting("VAULT_FOLDER_INBOX");
    expect(await validateSetting(s, ".")).not.toBeNull();
  });

  it("rejects empty string as folder name [COD-02]", async () => {
    const s = findSetting("VAULT_FOLDER_INBOX");
    expect(await validateSetting(s, "")).not.toBeNull();
    expect(await validateSetting(s, "   ")).not.toBeNull();
  });
});

// ── computeChanges ────────────────────────────────────────────────────────────

describe("computeChanges", () => {
  it("detects modified values [CFG-40]", () => {
    const original = new Map([["MCP_PORT", "3782"]]);
    const pending = new Map([["MCP_PORT", "4000"]]);
    const changes = computeChanges(original, pending);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual({ key: "MCP_PORT", was: "3782", is: "4000" });
  });

  it("detects added values [CFG-41]", () => {
    const original = new Map<string, string>();
    const pending = new Map([["ENABLE_EMBEDDINGS", "true"]]);
    const changes = computeChanges(original, pending);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual({
      key: "ENABLE_EMBEDDINGS",
      was: "(not set)",
      is: "true",
    });
  });

  it("detects cleared values [CFG-42]", () => {
    const original = new Map([["MCP_API_KEY", "secret"]]);
    const pending = new Map<string, string>(); // key deleted
    const changes = computeChanges(original, pending);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.key).toBe("MCP_API_KEY");
    expect(changes[0]!.was).not.toBe("(not set)"); // was masked but present
    expect(changes[0]!.is).toBe("(cleared)");
  });

  it("returns empty array when nothing changed [CFG-43]", () => {
    const original = new Map([["MCP_PORT", "3782"]]);
    const pending = new Map([["MCP_PORT", "3782"]]);
    expect(computeChanges(original, pending)).toHaveLength(0);
  });

  it("sorts changes by key name [CFG-44]", () => {
    const original = new Map([
      ["MCP_PORT", "3782"],
      ["LOG_LEVEL", "info"],
      ["ENABLE_EMBEDDINGS", "false"],
    ]);
    const pending = new Map([
      ["MCP_PORT", "4000"],
      ["LOG_LEVEL", "debug"],
      ["ENABLE_EMBEDDINGS", "true"],
    ]);
    const changes = computeChanges(original, pending);
    const keys = changes.map((c) => c.key);
    expect(keys).toEqual([...keys].sort());
  });

  it("masks sensitive keys in diff output [CFG-45]", () => {
    const original = new Map([["MCP_API_KEY", "sk-supersecret"]]);
    const pending = new Map([["MCP_API_KEY", "sk-newkey12345"]]);
    const changes = computeChanges(original, pending);
    expect(changes[0]!.was).not.toBe("sk-supersecret");
    expect(changes[0]!.was).toContain("•");
    expect(changes[0]!.is).not.toBe("sk-newkey12345");
    expect(changes[0]!.is).toContain("•");
  });
});

// ── showDiff ──────────────────────────────────────────────────────────────────

describe("showDiff", () => {
  it("returns false when there are no changes [CFG-50]", () => {
    const map = new Map([["MCP_PORT", "3782"]]);
    const result = showDiff(map, new Map(map));
    expect(result).toBe(false);
  });

  it("returns true when there are changes [CFG-51]", () => {
    const original = new Map([["MCP_PORT", "3782"]]);
    const pending = new Map([["MCP_PORT", "4000"]]);
    const result = showDiff(original, pending);
    expect(result).toBe(true);
  });
});

// ── SECTIONS registry ─────────────────────────────────────────────────────────

describe("SECTIONS registry", () => {
  it("has 10 sections [CFG-60]", () => {
    expect(SECTIONS).toHaveLength(10);
  });

  it("every section has a unique id [CFG-61]", () => {
    const ids = SECTIONS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every setting has a non-empty key, label, and description [CFG-62]", () => {
    for (const sec of SECTIONS) {
      for (const setting of sec.settings) {
        expect(setting.key.length).toBeGreaterThan(0);
        expect(setting.label.length).toBeGreaterThan(0);
        expect(setting.description.length).toBeGreaterThan(0);
      }
    }
  });

  it("every setting key uses UPPER_SNAKE_CASE [CFG-63]", () => {
    for (const sec of SECTIONS) {
      for (const setting of sec.settings) {
        expect(setting.key).toMatch(/^[A-Z_][A-Z0-9_]*$/);
      }
    }
  });

  it("all setting keys are unique across sections [CFG-64]", () => {
    const keys = SECTIONS.flatMap((s) => s.settings.map((st) => st.key));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("vault-folders section is registered [CFG-65]", () => {
    const sec = SECTIONS.find((s) => s.id === "vault-folders");
    expect(sec).toBeDefined();
  });

  it("vault-folders section has 10 settings [CFG-66]", () => {
    const sec = SECTIONS.find((s) => s.id === "vault-folders");
    expect(sec?.settings).toHaveLength(10);
  });

  it("all vault-folders setting keys start with VAULT_FOLDER_ [CFG-67]", () => {
    const sec = SECTIONS.find((s) => s.id === "vault-folders");
    for (const setting of sec?.settings ?? []) {
      expect(setting.key).toMatch(/^VAULT_FOLDER_/);
    }
  });
});
