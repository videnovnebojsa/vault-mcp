import { describe, expect, it } from "bun:test";
import { VAULT_FOLDERS } from "../config/folders.js";
import { buildDefaultClassifyRules, classify } from "./classify.js";

// ── buildDefaultClassifyRules ─────────────────────────────────────────────────

describe("buildDefaultClassifyRules [QA-13]", () => {
  it("returns rules keyed by all four categories", () => {
    const rules = buildDefaultClassifyRules(VAULT_FOLDERS);
    expect(Object.keys(rules)).toEqual(expect.arrayContaining(["person", "project", "idea", "admin"]));
  });

  it("maps categories to default VaultFolders values", () => {
    const rules = buildDefaultClassifyRules(VAULT_FOLDERS);
    expect(rules["person"]?.folder).toBe(VAULT_FOLDERS.PEOPLE);
    expect(rules["project"]?.folder).toBe(VAULT_FOLDERS.PROJECTS);
    expect(rules["idea"]?.folder).toBe(VAULT_FOLDERS.ZETTELKASTEN);
    expect(rules["admin"]?.folder).toBe(VAULT_FOLDERS.ADMIN);
  });

  it("maps categories to custom folder names [PERF-02]", () => {
    const custom = {
      ...VAULT_FOLDERS,
      PEOPLE: "Contacts",
      PROJECTS: "ClientWork",
      ZETTELKASTEN: "BrainDump",
      ADMIN: "Finance",
    };
    const rules = buildDefaultClassifyRules(custom);
    expect(rules["person"]?.folder).toBe("Contacts");
    expect(rules["project"]?.folder).toBe("ClientWork");
    expect(rules["idea"]?.folder).toBe("BrainDump");
    expect(rules["admin"]?.folder).toBe("Finance");
  });

  it("returns same object reference for the same folders instance [PERF-02]", () => {
    const folders = { ...VAULT_FOLDERS };
    const r1 = buildDefaultClassifyRules(folders);
    const r2 = buildDefaultClassifyRules(folders);
    // Memoised by reference: identical folders object → same result object
    expect(r1).toBe(r2);
  });

  it("returns new object when folders reference changes [PERF-02]", () => {
    const f1 = { ...VAULT_FOLDERS };
    const f2 = { ...VAULT_FOLDERS }; // different object, same values
    const r1 = buildDefaultClassifyRules(f1);
    const r2 = buildDefaultClassifyRules(f2);
    // Different reference → must rebuild (even if values are identical)
    expect(r1).not.toBe(r2);
  });
});

// ── classify ──────────────────────────────────────────────────────────────────

describe("classify [QA-13]", () => {
  it("returns 'person' for text containing person keywords", () => {
    const result = classify("I met with Alice today");
    expect(result.category).toBe("person");
    expect(result.confidence).toBe(0.7);
    expect(result.suggested_folder).toBe(VAULT_FOLDERS.PEOPLE);
  });

  it("returns 'project' for text containing project keywords", () => {
    const result = classify("Project milestone and deadline coming up");
    expect(result.category).toBe("project");
    expect(result.suggested_folder).toBe(VAULT_FOLDERS.PROJECTS);
  });

  it("returns 'idea' for text containing idea keywords", () => {
    const result = classify("What if we added semantic search — a hypothesis");
    expect(result.category).toBe("idea");
    expect(result.suggested_folder).toBe(VAULT_FOLDERS.ZETTELKASTEN);
  });

  it("returns 'admin' for text containing admin keywords", () => {
    const result = classify("Invoice received — need to pay the tax bill");
    expect(result.category).toBe("admin");
    expect(result.suggested_folder).toBe(VAULT_FOLDERS.ADMIN);
  });

  it("returns 'unknown' for unrecognised text and routes to INBOX", () => {
    const result = classify("xyzzy quux bloop nothing recognisable");
    expect(result.category).toBe("unknown");
    expect(result.confidence).toBe(0.3);
    expect(result.suggested_folder).toBe(VAULT_FOLDERS.INBOX);
  });

  it("truncates a long first line to suggested_title [QA-12]", () => {
    const longLine = "A".repeat(80);
    const result = classify(longLine);
    expect(result.suggested_title.length).toBeLessThanOrEqual(60);
    expect(result.suggested_title.endsWith("...")).toBe(true);
  });

  it("uses 'Untitled' when first line is empty [QA-12]", () => {
    const result = classify("\nsome content on second line");
    expect(result.suggested_title).toBe("Untitled");
  });

  it("routes to custom folders when folders param is provided [QA-14]", () => {
    const customFolders = {
      ...VAULT_FOLDERS,
      PEOPLE: "Contacts",
      PROJECTS: "ClientWork",
      ZETTELKASTEN: "BrainDump",
      ADMIN: "Finance",
      INBOX: "Unsorted",
    };

    expect(classify("Met with Bob", undefined, customFolders).suggested_folder).toBe("Contacts");
    expect(classify("Project milestone", undefined, customFolders).suggested_folder).toBe("ClientWork");
    expect(classify("Great idea for the future", undefined, customFolders).suggested_folder).toBe("BrainDump");
    expect(classify("Invoice payment due", undefined, customFolders).suggested_folder).toBe("Finance");
    expect(classify("nothing here", undefined, customFolders).suggested_folder).toBe("Unsorted");
  });

  it("honours caller-supplied rules over built-in defaults [QA-14]", () => {
    const customRules = {
      widget: {
        keywords: ["widget"],
        folder: "WidgetFactory",
      },
    };
    const result = classify("I need to build a widget today", customRules);
    expect(result.category).toBe("widget");
    expect(result.suggested_folder).toBe("WidgetFactory");
  });
});
