import { describe, expect, it } from "bun:test";
import { buildDefaultClassifyRules } from "../../capture/classify.js";
import { VAULT_FOLDERS } from "../../config/folders.js";
import { handleVaultClassify } from "./classify.js";
import { makeServices } from "./test-helpers.js";

describe("handleVaultClassify", () => {
  it("classifies text and returns category and folder", async () => {
    const services = makeServices();
    const result = await handleVaultClassify(
      { text: "Met with Alice to discuss the project milestone", vault: "default" },
      services,
      undefined,
      VAULT_FOLDERS,
    );
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]?.text ?? "{}").data;
    expect(data.category).toBeTruthy();
    expect(data.suggested_folder).toBeTruthy();
    expect(data.confidence).toBeGreaterThan(0);
  });

  it("uses default rules when no custom rules provided", async () => {
    const services = makeServices();
    const result = await handleVaultClassify(
      { text: "idea: what if we added semantic search", vault: "default" },
      services,
      undefined,
      VAULT_FOLDERS,
    );
    const data = JSON.parse(result.content[0]?.text ?? "{}").data;
    expect(data.category).toBe("idea");
    expect(data.suggested_folder).toBe("30_Zettelkasten");
  });

  it("uses custom folders when supplied [QA-01]", async () => {
    const customFolders = { ...VAULT_FOLDERS, ZETTELKASTEN: "MyIdeas", INBOX: "MyInbox" };
    const services = makeServices();

    const result = await handleVaultClassify(
      { text: "idea: what if we used vector search everywhere", vault: "default" },
      services,
      undefined,
      customFolders,
    );

    const data = JSON.parse(result.content[0]?.text ?? "{}").data;
    expect(data.category).toBe("idea");
    expect(data.suggested_folder).toBe("MyIdeas");
  });

  it("routes unknown content to custom inbox folder [QA-01]", async () => {
    const customFolders = { ...VAULT_FOLDERS, INBOX: "MyInbox" };
    const services = makeServices();

    const result = await handleVaultClassify(
      { text: "xyzzy quux bloop no keywords here", vault: "default" },
      services,
      undefined,
      customFolders,
    );

    const data = JSON.parse(result.content[0]?.text ?? "{}").data;
    expect(data.category).toBe("unknown");
    expect(data.suggested_folder).toBe("MyInbox");
  });
});

// ── buildDefaultClassifyRules with custom VaultFolders ────────────────────────

describe("buildDefaultClassifyRules [QA-07]", () => {
  it("uses default VAULT_FOLDERS when no custom folders provided", () => {
    const rules = buildDefaultClassifyRules(VAULT_FOLDERS);
    expect(rules["person"]?.folder).toBe(VAULT_FOLDERS.PEOPLE);
    expect(rules["project"]?.folder).toBe(VAULT_FOLDERS.PROJECTS);
    expect(rules["idea"]?.folder).toBe(VAULT_FOLDERS.ZETTELKASTEN);
    expect(rules["admin"]?.folder).toBe(VAULT_FOLDERS.ADMIN);
  });

  it("uses custom folder names when supplied [QA-07]", () => {
    const customFolders = {
      ...VAULT_FOLDERS,
      PEOPLE: "MyPeople",
      PROJECTS: "MyProjects",
      ZETTELKASTEN: "MyIdeas",
      ADMIN: "MyAdmin",
    };
    const rules = buildDefaultClassifyRules(customFolders);
    expect(rules["person"]?.folder).toBe("MyPeople");
    expect(rules["project"]?.folder).toBe("MyProjects");
    expect(rules["idea"]?.folder).toBe("MyIdeas");
    expect(rules["admin"]?.folder).toBe("MyAdmin");
  });

  it("produces rules that classify correctly with custom folders [QA-07]", () => {
    const customFolders = { ...VAULT_FOLDERS, ZETTELKASTEN: "BrainDump" };
    const rules = buildDefaultClassifyRules(customFolders);
    // Verify keywords are still intact
    expect(rules["idea"]?.keywords).toContain("idea");
    expect(rules["idea"]?.folder).toBe("BrainDump");
  });
});
