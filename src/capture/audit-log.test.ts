import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appendClassificationLog } from "./audit-log.js";
import type { CaptureClassification } from "./types.js";

const mockClassification: CaptureClassification = {
  category: "idea",
  confidence: 0.85,
  suggested_title: "Great Idea",
  tags: ["brainstorm"],
  properties: {},
  sensitivity: "low",
};

describe("appendClassificationLog", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "audit-log-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("creates new log file with header when none exists", async () => {
    await appendClassificationLog(tmpDir, mockClassification, "30_Zettelkasten/great-idea.md");

    const files = await fs.readdir(path.join(tmpDir, "70_AI_Logs", "classifications"));
    expect(files).toHaveLength(1);

    const content = await fs.readFile(path.join(tmpDir, "70_AI_Logs", "classifications", files[0]), "utf-8");
    expect(content).toContain("# Classification Log");
    expect(content).toContain("**Category**: idea");
    expect(content).toContain("**Confidence**: 0.85");
    expect(content).toContain("[[30_Zettelkasten/great-idea.md]]");
  });

  it("appends to existing log without duplicating header", async () => {
    await appendClassificationLog(tmpDir, mockClassification, "path1.md");
    await appendClassificationLog(tmpDir, { ...mockClassification, category: "admin" }, "path2.md");

    const files = await fs.readdir(path.join(tmpDir, "70_AI_Logs", "classifications"));
    const content = await fs.readFile(path.join(tmpDir, "70_AI_Logs", "classifications", files[0]), "utf-8");

    // Header appears only once
    const headerCount = (content.match(/# Classification Log/g) || []).length;
    expect(headerCount).toBe(1);

    // Both entries present
    expect(content).toContain("**Category**: idea");
    expect(content).toContain("**Category**: admin");
  });

  it("includes raw input when provided", async () => {
    await appendClassificationLog(tmpDir, mockClassification, "path.md", undefined, "Some raw input text");

    const files = await fs.readdir(path.join(tmpDir, "70_AI_Logs", "classifications"));
    const content = await fs.readFile(path.join(tmpDir, "70_AI_Logs", "classifications", files[0]), "utf-8");
    expect(content).toContain("**Raw input**: Some raw input text");
  });

  it("truncates long raw input", async () => {
    const longInput = "x".repeat(300);
    await appendClassificationLog(tmpDir, mockClassification, "path.md", undefined, longInput);

    const files = await fs.readdir(path.join(tmpDir, "70_AI_Logs", "classifications"));
    const content = await fs.readFile(path.join(tmpDir, "70_AI_Logs", "classifications", files[0]), "utf-8");
    expect(content).toContain("...");
  });

  // SEC-01: rawInput must not contain unescaped newlines that could inject markdown structure
  it("[SEC-01] rawInput newlines are stripped before embedding in the log", async () => {
    const malicious = "normal text\n---\ntype: injected\n---\n# Injected heading";
    await appendClassificationLog(tmpDir, mockClassification, "path.md", undefined, malicious);

    const files = await fs.readdir(path.join(tmpDir, "70_AI_Logs", "classifications"));
    const content = await fs.readFile(path.join(tmpDir, "70_AI_Logs", "classifications", files[0]), "utf-8");
    const lines = content.split("\n");
    // The Raw input value must be on a single line (no embedded newlines)
    const rawInputIdx = lines.findIndex((l) => l.includes("**Raw input**"));
    expect(rawInputIdx).toBeGreaterThan(-1);
    const rawInputLine = lines[rawInputIdx];
    // The entire rawInput value should be on this one line (collapsed newlines)
    expect(rawInputLine).toContain("normal text");
    expect(rawInputLine).toContain("---");
    // No injected "---" should appear in the body (after the closing frontmatter delimiter).
    // The file has exactly 2 legitimate "---" lines (YAML frontmatter open + close);
    // any additional standalone "---" line beyond those two would be an injection.
    const closingFrontmatterIdx = lines.indexOf("---", 1); // skip the opening "---" at index 0
    const bodyLines = lines.slice(closingFrontmatterIdx + 1);
    expect(bodyLines).not.toContain("---");
  });

  it("[QA-10] writes to a custom AI_LOGS folder when provided", async () => {
    const customFolders = {
      INBOX: "00_Inbox",
      PROJECTS: "10_Projects",
      ZETTELKASTEN: "30_Zettelkasten",
      ARTEFACTS: "35_Artefacts",
      CANVASES: "36_Canvases",
      TEMPLATES: "50_Templates",
      AI_LOGS: "CustomAuditLogs",
      PEOPLE: "80_People",
      ADMIN: "90_Admin",
      ARCHIVE: "99_Archive",
    };
    await appendClassificationLog(tmpDir, mockClassification, "path.md", customFolders);

    const auditDir = path.join(tmpDir, "CustomAuditLogs", "classifications");
    const files = await fs.readdir(auditDir);
    expect(files).toHaveLength(1);
    const content = await fs.readFile(path.join(auditDir, files[0]), "utf-8");
    expect(content).toContain("**Category**: idea");

    // Default folder must NOT have been created
    const defaultExists = await fs
      .access(path.join(tmpDir, "70_AI_Logs"))
      .then(() => true)
      .catch(() => false);
    expect(defaultExists).toBe(false);
  });

  it("[SEC-03] suggested_title with wikilinks is sanitized in the log", async () => {
    const maliciousClassification: CaptureClassification = {
      ...mockClassification,
      suggested_title: "[[SecretNote]] leaked via title",
    };
    await appendClassificationLog(tmpDir, maliciousClassification, "path.md");

    const files = await fs.readdir(path.join(tmpDir, "70_AI_Logs", "classifications"));
    const content = await fs.readFile(path.join(tmpDir, "70_AI_Logs", "classifications", files[0]), "utf-8");

    // The title line must NOT contain raw [[ ]] wikilink syntax
    const titleLine = content.split("\n").find((l) => l.includes("**Title**"));
    expect(titleLine).toBeDefined();
    expect(titleLine).not.toContain("[[SecretNote]]");
    // The sanitized text should still be present
    expect(titleLine).toContain("SecretNote");
  });

  it("[SEC-04] concurrent first-writes produce exactly one header", async () => {
    // Fire 10 concurrent appendClassificationLog calls against a non-existent log file.
    // With the TOCTOU access+writeFile pattern each racer that wins the access() check
    // overwrites the header and any entries written before it. The fix (O_EXCL open)
    // must guarantee exactly one header and all 10 entries survive.
    const calls = Array.from({ length: 10 }, (_, i) =>
      appendClassificationLog(tmpDir, { ...mockClassification, suggested_title: `Entry ${i}` }, `path${i}.md`),
    );
    await Promise.all(calls);

    const files = await fs.readdir(path.join(tmpDir, "70_AI_Logs", "classifications"));
    expect(files).toHaveLength(1);

    const content = await fs.readFile(path.join(tmpDir, "70_AI_Logs", "classifications", files[0]!), "utf-8");

    // Header must appear exactly once regardless of how many writers raced
    const headerCount = (content.match(/# Classification Log/g) ?? []).length;
    expect(headerCount).toBe(1);

    // Every entry must be present
    for (let i = 0; i < 10; i++) {
      expect(content).toContain(`path${i}.md`);
    }
  });

  it("rejects audit log paths that escape through a symlink", async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "audit-log-outside-"));
    await fs.symlink(outsideDir, path.join(tmpDir, "70_AI_Logs"));

    try {
      await expect(appendClassificationLog(tmpDir, mockClassification, "path.md", undefined)).rejects.toThrow(
        "Path resolves outside vault root",
      );
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });
});
