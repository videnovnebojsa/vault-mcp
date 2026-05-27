import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { logger } from "../utils/logger.js";
import { resolveSkipConnectionPrefixes, resolveVaultFolders, VAULT_FOLDERS } from "./folders.js";

const FOLDER_KEYS = [
  "VAULT_FOLDER_INBOX",
  "VAULT_FOLDER_PROJECTS",
  "VAULT_FOLDER_ZETTELKASTEN",
  "VAULT_FOLDER_ARTEFACTS",
  "VAULT_FOLDER_CANVASES",
  "VAULT_FOLDER_TEMPLATES",
  "VAULT_FOLDER_AI_LOGS",
  "VAULT_FOLDER_PEOPLE",
  "VAULT_FOLDER_ADMIN",
  "VAULT_FOLDER_ARCHIVE",
] as const;

const ORIG_ENV = process.env;

beforeEach(() => {
  process.env = { ...ORIG_ENV };
  // Clear all VAULT_FOLDER_* vars so tests start from defaults
  for (const key of FOLDER_KEYS) delete process.env[key];
});

afterEach(() => {
  process.env = ORIG_ENV;
});

// ── resolveVaultFolders — defaults ────────────────────────────────────────────

describe("resolveVaultFolders — defaults", () => {
  it("returns VAULT_FOLDERS defaults when no env vars are set [QA-02-01]", () => {
    const folders = resolveVaultFolders();
    expect(folders.INBOX).toBe(VAULT_FOLDERS.INBOX);
    expect(folders.PROJECTS).toBe(VAULT_FOLDERS.PROJECTS);
    expect(folders.ZETTELKASTEN).toBe(VAULT_FOLDERS.ZETTELKASTEN);
    expect(folders.ARCHIVE).toBe(VAULT_FOLDERS.ARCHIVE);
  });

  it("uses custom value when env var is set [QA-02-02]", () => {
    process.env["VAULT_FOLDER_INBOX"] = "MyInbox";
    process.env["VAULT_FOLDER_ARCHIVE"] = "OldNotes";
    const folders = resolveVaultFolders();
    expect(folders.INBOX).toBe("MyInbox");
    expect(folders.ARCHIVE).toBe("OldNotes");
    // others still default
    expect(folders.PROJECTS).toBe(VAULT_FOLDERS.PROJECTS);
  });

  it("trims whitespace from env var values [QA-02-03]", () => {
    process.env["VAULT_FOLDER_INBOX"] = "  MyInbox  ";
    const folders = resolveVaultFolders();
    expect(folders.INBOX).toBe("MyInbox");
  });
});

// ── resolveVaultFolders — validation errors ───────────────────────────────────

describe("resolveVaultFolders — validation errors", () => {
  it("throws for blank VAULT_FOLDER_INBOX [QA-02-04]", () => {
    process.env["VAULT_FOLDER_INBOX"] = "";
    expect(() => resolveVaultFolders()).toThrow(/VAULT_FOLDER_INBOX.*blank/i);
  });

  it("throws for whitespace-only VAULT_FOLDER_PROJECTS [QA-02-05]", () => {
    process.env["VAULT_FOLDER_PROJECTS"] = "   ";
    expect(() => resolveVaultFolders()).toThrow(/VAULT_FOLDER_PROJECTS.*blank/i);
  });

  it("throws for value containing forward slash [QA-02-06]", () => {
    process.env["VAULT_FOLDER_INBOX"] = "00_Inbox/sub";
    expect(() => resolveVaultFolders()).toThrow(/VAULT_FOLDER_INBOX.*path separator/i);
  });

  it("throws for value containing backslash [QA-02-07]", () => {
    process.env["VAULT_FOLDER_INBOX"] = "Inbox\\sub";
    expect(() => resolveVaultFolders()).toThrow(/VAULT_FOLDER_INBOX.*path separator/i);
  });

  it("throws for value that is exactly '..' [SEC-01-01]", () => {
    process.env["VAULT_FOLDER_INBOX"] = "..";
    expect(() => resolveVaultFolders()).toThrow(/VAULT_FOLDER_INBOX/);
  });

  it("throws for value that is exactly '.' [SEC-01-02]", () => {
    process.env["VAULT_FOLDER_INBOX"] = ".";
    expect(() => resolveVaultFolders()).toThrow(/VAULT_FOLDER_INBOX/);
  });

  it("throws for value containing null byte [QA-02-08]", () => {
    process.env["VAULT_FOLDER_INBOX"] = "Inbox\0evil";
    expect(() => resolveVaultFolders()).toThrow(/VAULT_FOLDER_INBOX/);
  });
});

// ── QA-08: per-folder env var coverage ───────────────────────────────────────

describe("resolveVaultFolders — individual overrides [QA-08]", () => {
  it("respects VAULT_FOLDER_ARTEFACTS [QA-08-01]", () => {
    process.env["VAULT_FOLDER_ARTEFACTS"] = "MyArtefacts";
    expect(resolveVaultFolders().ARTEFACTS).toBe("MyArtefacts");
  });

  it("respects VAULT_FOLDER_CANVASES [QA-08-02]", () => {
    process.env["VAULT_FOLDER_CANVASES"] = "MyCanvases";
    expect(resolveVaultFolders().CANVASES).toBe("MyCanvases");
  });

  it("respects VAULT_FOLDER_TEMPLATES [QA-08-03]", () => {
    process.env["VAULT_FOLDER_TEMPLATES"] = "MyTemplates";
    expect(resolveVaultFolders().TEMPLATES).toBe("MyTemplates");
  });

  it("respects VAULT_FOLDER_PEOPLE [QA-08-04]", () => {
    process.env["VAULT_FOLDER_PEOPLE"] = "Contacts";
    expect(resolveVaultFolders().PEOPLE).toBe("Contacts");
  });

  it("respects VAULT_FOLDER_ADMIN [QA-08-05]", () => {
    process.env["VAULT_FOLDER_ADMIN"] = "Finance";
    expect(resolveVaultFolders().ADMIN).toBe("Finance");
  });

  it("respects VAULT_FOLDER_ARCHIVE [QA-08-06]", () => {
    process.env["VAULT_FOLDER_ARCHIVE"] = "Archive2024";
    expect(resolveVaultFolders().ARCHIVE).toBe("Archive2024");
  });

  it("respects VAULT_FOLDER_AI_LOGS [QA-08-07]", () => {
    process.env["VAULT_FOLDER_AI_LOGS"] = "AuditTrail";
    expect(resolveVaultFolders().AI_LOGS).toBe("AuditTrail");
  });

  it("respects VAULT_FOLDER_ZETTELKASTEN [QA-08-08]", () => {
    process.env["VAULT_FOLDER_ZETTELKASTEN"] = "BrainDump";
    expect(resolveVaultFolders().ZETTELKASTEN).toBe("BrainDump");
  });
});

// ── ERR-09: startup log of resolved folder map ───────────────────────────────

describe("resolveVaultFolders — startup log [ERR-09]", () => {
  it("logs the resolved folder map at info level when any folder is overridden [ERR-09]", () => {
    process.env["VAULT_FOLDER_INBOX"] = "MyInbox";
    const infoSpy = jest.spyOn(logger, "info").mockImplementation(() => {});
    try {
      resolveVaultFolders();
      expect(infoSpy).toHaveBeenCalled();
      const [tag, , extra] = infoSpy.mock.calls[0] ?? [];
      expect(tag).toBe("config");
      expect(extra).toMatchObject({ INBOX: "MyInbox" });
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("does not log when all folders match defaults [ERR-09]", () => {
    const infoSpy = jest.spyOn(logger, "info").mockImplementation(() => {});
    try {
      resolveVaultFolders();
      // logger.info should not have been called for the folder-map message
      const folderCalls = infoSpy.mock.calls.filter(([, msg]) => msg && String(msg).includes("folder"));
      expect(folderCalls).toHaveLength(0);
    } finally {
      infoSpy.mockRestore();
    }
  });
});

// ── resolveSkipConnectionPrefixes ─────────────────────────────────────────────

describe("resolveSkipConnectionPrefixes [QA-05]", () => {
  it("returns prefixes for all skipped folders", () => {
    const prefixes = resolveSkipConnectionPrefixes(VAULT_FOLDERS);
    expect(prefixes).toContain(`${VAULT_FOLDERS.AI_LOGS}/`);
    expect(prefixes).toContain(`${VAULT_FOLDERS.TEMPLATES}/`);
    expect(prefixes).toContain(`${VAULT_FOLDERS.ARCHIVE}/`);
    expect(prefixes).toContain(`${VAULT_FOLDERS.ARTEFACTS}/`);
    expect(prefixes).toContain(`${VAULT_FOLDERS.CANVASES}/`);
    expect(prefixes).toHaveLength(5);
  });

  it("uses custom folder names when provided [QA-05-02]", () => {
    const customFolders = {
      ...VAULT_FOLDERS,
      AI_LOGS: "AI_Journal",
      ARCHIVE: "OldStuff",
    };
    const prefixes = resolveSkipConnectionPrefixes(customFolders);
    expect(prefixes).toContain("AI_Journal/");
    expect(prefixes).toContain("OldStuff/");
    expect(prefixes).not.toContain(`${VAULT_FOLDERS.AI_LOGS}/`);
    expect(prefixes).not.toContain(`${VAULT_FOLDERS.ARCHIVE}/`);
  });
});
