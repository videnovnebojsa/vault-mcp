import { beforeEach, describe, expect, it, mock } from "bun:test";
import {
  classifyForTriageHeuristic,
  discoverVaultFolders,
  formatTriageReport,
  type TriageClassification,
  type TriageResult,
  triageInbox,
} from "./inbox.js";

// Mock fs.readdir for discoverVaultFolders
mock.module("node:fs/promises", () => ({
  readdir: mock(),
}));

import { readdir } from "node:fs/promises";

function mockVault(notes: Array<{ path: string; content: string; frontmatter?: Record<string, unknown> }>) {
  return {
    vaultPath: "/vault",
    listFolder: mock().mockResolvedValue(notes.map((n) => ({ path: n.path }))),
    readNote: mock().mockImplementation(async (path: string) => {
      const note = notes.find((n) => n.path === path);
      if (!note) throw new Error("Not found");
      return { content: note.content, frontmatter: note.frontmatter ?? {} };
    }),
    updateProperties: mock().mockResolvedValue({ ok: true, path: "" }),
    moveNote: mock().mockResolvedValue({ ok: true }),
  } as unknown as import("../vault/repository-interface.js").IVaultRepository;
}

function mockVaultSync() {
  return {
    handleRename: mock().mockResolvedValue(undefined),
    handleUpsert: mock().mockResolvedValue(undefined),
  } as unknown as import("../search/sync.js").VaultSync;
}

describe("discoverVaultFolders", () => {
  it("filters dotfiles and inbox folder", async () => {
    (readdir as unknown as ReturnType<typeof mock>).mockResolvedValue([
      { name: ".obsidian", isDirectory: () => true },
      { name: "00_Inbox", isDirectory: () => true },
      { name: "10_Projects", isDirectory: () => true },
      { name: "30_Zettelkasten", isDirectory: () => true },
      { name: "readme.md", isDirectory: () => false },
    ]);

    const folders = await discoverVaultFolders("/vault", "00_Inbox");
    expect(folders).toEqual(["10_Projects", "30_Zettelkasten"]);
  });

  it("returns sorted folder names", async () => {
    (readdir as unknown as ReturnType<typeof mock>).mockResolvedValue([
      { name: "90_Admin", isDirectory: () => true },
      { name: "10_Projects", isDirectory: () => true },
      { name: "50_Reference", isDirectory: () => true },
    ]);

    const folders = await discoverVaultFolders("/vault", "00_Inbox");
    expect(folders).toEqual(["10_Projects", "50_Reference", "90_Admin"]);
  });

  it("filters folder suggestions through ACL", async () => {
    (readdir as unknown as ReturnType<typeof mock>).mockResolvedValue([
      { name: "10_Projects", isDirectory: () => true },
      { name: "90_Admin", isDirectory: () => true },
      { name: "Secrets", isDirectory: () => true },
    ]);

    const folders = await discoverVaultFolders("/vault", "00_Inbox", {
      allowPaths: [],
      denyPaths: ["Secrets", "90_Admin"],
    });
    expect(folders).toEqual(["10_Projects"]);
  });
});

describe("classifyForTriageHeuristic", () => {
  const folders = ["10_Projects", "20_People", "30_Ideas", "90_Admin"];

  it("matches by type frontmatter", () => {
    const result = classifyForTriageHeuristic(
      "00_Inbox/test.md",
      "Some content",
      { type: "project" },
      folders,
      "00_Inbox",
    );
    expect(result.folder).toBe("10_Projects");
    expect(result.confidence).toBe(0.6);
  });

  it("matches by tag", () => {
    const result = classifyForTriageHeuristic(
      "00_Inbox/test.md",
      "Some content",
      { tags: ["admin"] },
      folders,
      "00_Inbox",
    );
    expect(result.folder).toBe("90_Admin");
    expect(result.confidence).toBe(0.5);
  });

  it("matches by content keywords", () => {
    const result = classifyForTriageHeuristic(
      "00_Inbox/test.md",
      "This is a brainstorm idea for the future",
      undefined,
      folders,
      "00_Inbox",
    );
    expect(result.folder).toBe("30_Ideas");
    expect(result.confidence).toBe(0.4);
  });

  it("returns inbox for unclassifiable content", () => {
    const result = classifyForTriageHeuristic(
      "00_Inbox/test.md",
      "random text with no signals",
      undefined,
      folders,
      "00_Inbox",
    );
    expect(result.folder).toBe("00_Inbox");
    expect(result.confidence).toBe(0);
  });
});

describe("triageInbox", () => {
  beforeEach(() => {
    (readdir as unknown as ReturnType<typeof mock>).mockResolvedValue([
      { name: "10_Projects", isDirectory: () => true },
      { name: "30_Zettelkasten", isDirectory: () => true },
    ]);
  });

  it("auto-moves notes with external high-confidence classifications", async () => {
    const vault = mockVault([{ path: "00_Inbox/note1.md", content: "project stuff" }]);
    const sync = mockVaultSync();
    const classifications = new Map<string, TriageClassification>([
      ["00_Inbox/note1.md", { folder: "10_Projects", confidence: 0.95, reason: "project" }],
    ]);

    const result = await triageInbox({
      vault,
      vaultSync: sync,
      autoMoveThreshold: 0.85,
      suggestThreshold: 0.5,
      inboxFolder: "00_Inbox",
      classifications,
    });

    expect(result.moved).toHaveLength(1);
    expect(result.moved[0].destination).toBe("10_Projects");
    expect(vault.updateProperties).toHaveBeenCalledWith("00_Inbox/note1.md", { triaged: true });
    expect(vault.moveNote).toHaveBeenCalledWith("00_Inbox/note1.md", "10_Projects/note1.md");
    expect(sync.handleRename).toHaveBeenCalled();
  });

  it("uses heuristic when no external classifications provided", async () => {
    const vault = mockVault([{ path: "00_Inbox/note1.md", content: "random content xyz" }]);

    const result = await triageInbox({
      vault,
      autoMoveThreshold: 0.85,
      suggestThreshold: 0.5,
      inboxFolder: "00_Inbox",
    });

    // Heuristic returns low confidence for unclassifiable content → skipped
    expect(result.skipped).toHaveLength(1);
  });

  it("skips notes with triaged: true frontmatter", async () => {
    const vault = mockVault([{ path: "00_Inbox/note1.md", content: "already done", frontmatter: { triaged: true } }]);

    const result = await triageInbox({
      vault,
      autoMoveThreshold: 0.85,
      suggestThreshold: 0.5,
      inboxFolder: "00_Inbox",
    });

    expect(result.skipped).toHaveLength(1);
    expect(result.moved).toHaveLength(0);
  });

  it("dry-run mode does not move files", async () => {
    const vault = mockVault([{ path: "00_Inbox/note1.md", content: "project stuff" }]);
    const classifications = new Map<string, TriageClassification>([
      ["00_Inbox/note1.md", { folder: "10_Projects", confidence: 0.95, reason: "project" }],
    ]);

    const result = await triageInbox({
      vault,
      autoMoveThreshold: 0.85,
      suggestThreshold: 0.5,
      inboxFolder: "00_Inbox",
      dryRun: true,
      classifications,
    });

    expect(result.moved).toHaveLength(1);
    expect(vault.moveNote).not.toHaveBeenCalled();
    expect(vault.updateProperties).not.toHaveBeenCalled();
  });

  it("handles empty inbox gracefully", async () => {
    const vault = mockVault([]);

    const result = await triageInbox({
      vault,
      autoMoveThreshold: 0.85,
      suggestThreshold: 0.5,
      inboxFolder: "00_Inbox",
    });

    expect(result.moved).toHaveLength(0);
    expect(result.suggested).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
  });
});

describe("formatTriageReport", () => {
  it("formats moved and suggested notes", () => {
    const result: TriageResult = {
      moved: [{ path: "00_Inbox/a.md", destination: "10_Projects" }],
      suggested: [{ path: "00_Inbox/b.md", destination: "30_Zettelkasten", confidence: 0.7, reason: "zettel" }],
      skipped: ["00_Inbox/c.md"],
    };
    const report = formatTriageReport(result);
    expect(report).toContain("Moved (1):");
    expect(report).toContain("10_Projects");
    expect(report).toContain("Suggestions (1):");
    expect(report).toContain("[1]");
    expect(report).toContain("70%");
    expect(report).toContain("Skipped: 1 note(s)");
    expect(report).toContain("/triage <N> approve|skip|<folder>");
  });

  it("returns empty message for empty result", () => {
    const result: TriageResult = { moved: [], suggested: [], skipped: [] };
    expect(formatTriageReport(result)).toContain("empty");
  });
});
