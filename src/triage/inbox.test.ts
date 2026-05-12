import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyForTriageHeuristic,
  discoverVaultFolders,
  formatTriageReport,
  handleTriageApproval,
  type TriageClassification,
  type TriageResult,
  TriageState,
  triageInbox,
} from "./inbox.js";

// Mock fs.readdir for discoverVaultFolders
vi.mock("node:fs/promises", () => ({
  readdir: vi.fn(),
}));

import { readdir } from "node:fs/promises";

function mockVault(notes: Array<{ path: string; content: string; frontmatter?: Record<string, unknown> }>) {
  return {
    vaultPath: "/vault",
    listFolder: vi.fn().mockResolvedValue(notes.map((n) => ({ path: n.path }))),
    readNote: vi.fn().mockImplementation(async (path: string) => {
      const note = notes.find((n) => n.path === path);
      if (!note) throw new Error("Not found");
      return { content: note.content, frontmatter: note.frontmatter ?? {} };
    }),
    updateProperties: vi.fn().mockResolvedValue({ ok: true, path: "" }),
    moveNote: vi.fn().mockResolvedValue({ ok: true }),
  } as unknown as import("../vault/repository.js").VaultRepository;
}

function mockVaultSync() {
  return {
    handleRename: vi.fn().mockResolvedValue(undefined),
    handleUpsert: vi.fn().mockResolvedValue(undefined),
  } as unknown as import("../search/sync.js").VaultSync;
}

describe("TriageState", () => {
  let state: TriageState;

  beforeEach(() => {
    state = new TriageState();
  });

  it("assigns incrementing IDs", () => {
    const id1 = state.add({ path: "a.md", suggestedFolder: "10_Projects", confidence: 0.7, reason: "test" });
    const id2 = state.add({ path: "b.md", suggestedFolder: "30_Zettelkasten", confidence: 0.8, reason: "test" });
    expect(id2).toBe(id1 + 1);
  });

  it("retrieves entries by ID", () => {
    const id = state.add({ path: "a.md", suggestedFolder: "10_Projects", confidence: 0.7, reason: "test" });
    expect(state.get(id)?.path).toBe("a.md");
    expect(state.get(999)).toBeUndefined();
  });

  it("removes entries", () => {
    const id = state.add({ path: "a.md", suggestedFolder: "10_Projects", confidence: 0.7, reason: "test" });
    expect(state.remove(id)).toBe(true);
    expect(state.get(id)).toBeUndefined();
    expect(state.remove(id)).toBe(false);
  });

  it("clears all entries", () => {
    state.add({ path: "a.md", suggestedFolder: "10_Projects", confidence: 0.7, reason: "test" });
    state.add({ path: "b.md", suggestedFolder: "30_Zettelkasten", confidence: 0.8, reason: "test" });
    expect(state.size).toBe(2);
    state.clear();
    expect(state.size).toBe(0);
  });

  it("clear resets IDs to 1", () => {
    state.add({ path: "a.md", suggestedFolder: "10_Projects", confidence: 0.7, reason: "test" });
    state.add({ path: "b.md", suggestedFolder: "30_Zettelkasten", confidence: 0.8, reason: "test" });
    state.clear();
    const id = state.add({ path: "c.md", suggestedFolder: "10_Projects", confidence: 0.9, reason: "test" });
    expect(id).toBe(1);
  });

  it("getAll returns a copy", () => {
    state.add({ path: "a.md", suggestedFolder: "10_Projects", confidence: 0.7, reason: "test" });
    const all = state.getAll();
    expect(all.size).toBe(1);
    all.clear();
    expect(state.size).toBe(1);
  });
});

describe("discoverVaultFolders", () => {
  it("filters dotfiles and inbox folder", async () => {
    (readdir as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
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
    (readdir as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { name: "90_Admin", isDirectory: () => true },
      { name: "10_Projects", isDirectory: () => true },
      { name: "50_Reference", isDirectory: () => true },
    ]);

    const folders = await discoverVaultFolders("/vault", "00_Inbox");
    expect(folders).toEqual(["10_Projects", "50_Reference", "90_Admin"]);
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
    (readdir as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
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

describe("handleTriageApproval", () => {
  it("approve moves note to suggested folder", async () => {
    const state = new TriageState();
    const id = state.add({ path: "00_Inbox/note.md", suggestedFolder: "10_Projects", confidence: 0.7, reason: "test" });
    const vault = mockVault([]);
    const sync = mockVaultSync();

    const msg = await handleTriageApproval(state, vault, sync, id, "approve");
    expect(msg).toContain("Moved");
    expect(vault.moveNote).toHaveBeenCalledWith("00_Inbox/note.md", "10_Projects/note.md");
    expect(vault.updateProperties).toHaveBeenCalledWith("00_Inbox/note.md", { triaged: true });
    expect(state.get(id)).toBeUndefined();
  });

  it("skip removes from state without moving", async () => {
    const state = new TriageState();
    const id = state.add({ path: "00_Inbox/note.md", suggestedFolder: "10_Projects", confidence: 0.7, reason: "test" });
    const vault = mockVault([]);

    const msg = await handleTriageApproval(state, vault, undefined, id, "skip");
    expect(msg).toContain("Skipped");
    expect(vault.moveNote).not.toHaveBeenCalled();
    expect(state.get(id)).toBeUndefined();
  });

  it("custom folder overrides suggestion", async () => {
    const state = new TriageState();
    const id = state.add({ path: "00_Inbox/note.md", suggestedFolder: "10_Projects", confidence: 0.7, reason: "test" });
    const vault = mockVault([]);
    const sync = mockVaultSync();

    const msg = await handleTriageApproval(state, vault, sync, id, "30_Zettelkasten");
    expect(msg).toContain("30_Zettelkasten");
    expect(vault.moveNote).toHaveBeenCalledWith("00_Inbox/note.md", "30_Zettelkasten/note.md");
  });

  it("returns error for unknown ID", async () => {
    const state = new TriageState();
    const vault = mockVault([]);

    const msg = await handleTriageApproval(state, vault, undefined, 999, "approve");
    expect(msg).toContain("No pending suggestion");
  });
});
