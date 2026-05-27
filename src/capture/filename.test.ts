import { describe, expect, it } from "bun:test";
import type { VaultFolders } from "../config/folders.js";
import { buildAuditLogPath, buildCapturePath, sanitizeFilename } from "./filename.js";

describe("sanitizeFilename", () => {
  it("removes special characters", () => {
    expect(sanitizeFilename("Hello! @World #2024")).toBe("hello-world-2024");
  });

  it("converts spaces to hyphens", () => {
    expect(sanitizeFilename("my great note")).toBe("my-great-note");
  });

  it("collapses multiple hyphens", () => {
    expect(sanitizeFilename("a---b")).toBe("a-b");
  });

  it("strips leading/trailing hyphens", () => {
    expect(sanitizeFilename("-hello-")).toBe("hello");
  });

  it("truncates to 80 chars", () => {
    const long = "a".repeat(100);
    expect(sanitizeFilename(long).length).toBeLessThanOrEqual(80);
  });

  it("returns lowercase", () => {
    expect(sanitizeFilename("UPPER Case")).toBe("upper-case");
  });

  it("handles empty string", () => {
    expect(sanitizeFilename("")).toBe("");
  });
});

describe("buildCapturePath", () => {
  it("uses category folder by default", () => {
    const path = buildCapturePath("person", "John Smith");
    expect(path).toMatch(/^80_People\/john-smith-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.md$/);
  });

  it("uses provided folder override", () => {
    const path = buildCapturePath("person", "John Smith", undefined, "00_Inbox");
    expect(path).toMatch(/^00_Inbox\/john-smith-/);
  });

  it("uses unknown folder for unknown category", () => {
    const path = buildCapturePath("unknown", "Something");
    expect(path).toMatch(/^00_Inbox\//);
  });

  it("uses 'untitled' for empty title", () => {
    const path = buildCapturePath("idea", "");
    expect(path).toMatch(/^30_Zettelkasten\/untitled-/);
  });

  it("uses custom PEOPLE folder when folders param is provided", () => {
    const customFolders: VaultFolders = {
      INBOX: "00_Inbox",
      PROJECTS: "10_Projects",
      ZETTELKASTEN: "30_Zettelkasten",
      ARTEFACTS: "35_Artefacts",
      CANVASES: "36_Canvases",
      TEMPLATES: "50_Templates",
      AI_LOGS: "70_AI_Logs",
      PEOPLE: "Contacts",
      ADMIN: "90_Admin",
      ARCHIVE: "99_Archive",
    };
    const path = buildCapturePath("person", "Jane Doe", customFolders);
    expect(path).toMatch(/^Contacts\/jane-doe-/);
  });

  it("uses custom INBOX folder when category is unknown", () => {
    const customFolders: VaultFolders = {
      INBOX: "MyInbox",
      PROJECTS: "10_Projects",
      ZETTELKASTEN: "30_Zettelkasten",
      ARTEFACTS: "35_Artefacts",
      CANVASES: "36_Canvases",
      TEMPLATES: "50_Templates",
      AI_LOGS: "70_AI_Logs",
      PEOPLE: "80_People",
      ADMIN: "90_Admin",
      ARCHIVE: "99_Archive",
    };
    const path = buildCapturePath("unknown", "Something", customFolders);
    expect(path).toMatch(/^MyInbox\//);
  });

  it("returns correct folder when called multiple times with the same folders object [PERF-01]", () => {
    const folders: VaultFolders = {
      INBOX: "Inbox",
      PROJECTS: "Projects",
      ZETTELKASTEN: "Ideas",
      ARTEFACTS: "35_Artefacts",
      CANVASES: "36_Canvases",
      TEMPLATES: "50_Templates",
      AI_LOGS: "70_AI_Logs",
      PEOPLE: "Contacts",
      ADMIN: "Admin",
      ARCHIVE: "99_Archive",
    };
    // Both calls must route to the correct (custom) folder
    const p1 = buildCapturePath("person", "Alice", folders);
    const p2 = buildCapturePath("person", "Bob", folders);
    expect(p1).toMatch(/^Contacts\//);
    expect(p2).toMatch(/^Contacts\//);
  });

  it("re-routes correctly when a different folders object is passed [PERF-01]", () => {
    const f1: VaultFolders = {
      INBOX: "Inbox",
      PROJECTS: "Projects",
      ZETTELKASTEN: "Ideas",
      ARTEFACTS: "35_Artefacts",
      CANVASES: "36_Canvases",
      TEMPLATES: "50_Templates",
      AI_LOGS: "70_AI_Logs",
      PEOPLE: "PeopleA",
      ADMIN: "Admin",
      ARCHIVE: "99_Archive",
    };
    const f2: VaultFolders = { ...f1, PEOPLE: "PeopleB" };
    expect(buildCapturePath("person", "X", f1)).toMatch(/^PeopleA\//);
    expect(buildCapturePath("person", "Y", f2)).toMatch(/^PeopleB\//);
  });
});

describe("buildAuditLogPath", () => {
  it("returns correct path format", () => {
    const path = buildAuditLogPath();
    expect(path).toMatch(/^70_AI_Logs\/classifications\/\d{4}-\d{2}-\d{2}-classifications\.md$/);
  });

  it("uses custom AI_LOGS folder when folders param is provided", () => {
    const customFolders: VaultFolders = {
      INBOX: "00_Inbox",
      PROJECTS: "10_Projects",
      ZETTELKASTEN: "30_Zettelkasten",
      ARTEFACTS: "35_Artefacts",
      CANVASES: "36_Canvases",
      TEMPLATES: "50_Templates",
      AI_LOGS: "AI_Audit",
      PEOPLE: "80_People",
      ADMIN: "90_Admin",
      ARCHIVE: "99_Archive",
    };
    const path = buildAuditLogPath(customFolders);
    expect(path).toMatch(/^AI_Audit\/classifications\/\d{4}-\d{2}-\d{2}-classifications\.md$/);
  });
});
