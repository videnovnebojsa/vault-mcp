import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { VaultSync } from "../../search/sync.js";
import { MockVaultRepository } from "../../vault/repository-mock.js";
import { makeServices } from "./test-helpers.js";
import { handleVaultTriageInbox } from "./triage-inbox.js";

describe("handleVaultTriageInbox", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "triage-handler-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns empty result when inbox is empty", async () => {
    const services = makeServices();
    const result = await handleVaultTriageInbox(
      { inbox_folder: "00_Inbox", auto_move_threshold: 0.8, suggest_threshold: 0.6, dry_run: false, vault: "default" },
      services,
    );
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]?.text ?? "{}").data;
    expect(data.moved).toHaveLength(0);
    expect(data.suggested).toHaveLength(0);
    expect(data.skipped).toHaveLength(0);
  });

  it("auto-moves a classified inbox note and updates sync", async () => {
    await fs.mkdir(path.join(tmpDir, "10_Projects"), { recursive: true });
    const vault = new MockVaultRepository(tmpDir);
    await vault.writeNote("00_Inbox/project-note", {
      content: "project milestone",
      frontmatter: { type: "project" },
    });
    const vaultSync = { handleRename: mock().mockResolvedValue(undefined) };
    const services = makeServices({ vault, vaultSync: vaultSync as unknown as VaultSync });

    const result = await handleVaultTriageInbox(
      {
        inbox_folder: "00_Inbox",
        auto_move_threshold: 0.6,
        suggest_threshold: 0.4,
        dry_run: false,
        vault: "default",
      },
      services,
    );

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]?.text ?? "{}").data;
    expect(data.moved).toEqual([{ path: "00_Inbox/project-note.md", destination: "10_Projects" }]);
    const moved = await vault.readNote("10_Projects/project-note");
    expect(moved.frontmatter.triaged).toBe(true);
    expect(vaultSync.handleRename).toHaveBeenCalledWith("00_Inbox/project-note.md", "10_Projects/project-note.md");
  });

  it("returns validation error when suggestion threshold overlaps auto-move threshold", async () => {
    const services = makeServices();

    const result = await handleVaultTriageInbox(
      { inbox_folder: "00_Inbox", auto_move_threshold: 0.6, suggest_threshold: 0.6, dry_run: false, vault: "default" },
      services,
    );

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0]?.text ?? "{}");
    expect(data.error.code).toBe("VALIDATION");
  });

  it("dry_run records moves without executing vault operations", async () => {
    await fs.mkdir(path.join(tmpDir, "10_Projects"), { recursive: true });
    const vault = new MockVaultRepository(tmpDir);
    await vault.writeNote("00_Inbox/idea-note", {
      content: "project milestone",
      frontmatter: { type: "project" },
    });
    const moveNoteSpy = spyOn(vault, "moveNote");
    const updatePropertiesSpy = spyOn(vault, "updateProperties");
    const vaultSync = { handleRename: mock() };
    const services = makeServices({ vault, vaultSync: vaultSync as unknown as VaultSync });

    const result = await handleVaultTriageInbox(
      { inbox_folder: "00_Inbox", auto_move_threshold: 0.5, suggest_threshold: 0.3, dry_run: true, vault: "default" },
      services,
    );

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]?.text ?? "{}").data;
    expect(data.moved).toHaveLength(1);
    expect(data.moved[0].destination).toBe("10_Projects");
    expect(moveNoteSpy).not.toHaveBeenCalled();
    expect(updatePropertiesSpy).not.toHaveBeenCalled();
    expect(vaultSync.handleRename).not.toHaveBeenCalled();
  });

  it("places note in suggested when confidence falls between thresholds", async () => {
    await fs.mkdir(path.join(tmpDir, "10_Projects"), { recursive: true });
    const vault = new MockVaultRepository(tmpDir);
    await vault.writeNote("00_Inbox/tagged-note", {
      content: "some content",
      frontmatter: { tags: ["projects"] },
    });
    const services = makeServices({ vault });

    const result = await handleVaultTriageInbox(
      { inbox_folder: "00_Inbox", auto_move_threshold: 0.7, suggest_threshold: 0.4, dry_run: false, vault: "default" },
      services,
    );

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]?.text ?? "{}").data;
    expect(data.moved).toHaveLength(0);
    expect(data.suggested).toHaveLength(1);
    expect(data.suggested[0].destination).toBe("10_Projects");
    expect(data.suggested[0].confidence).toBe(0.5);
    expect(data.skipped).toHaveLength(0);
  });

  it("skips notes that have already been triaged", async () => {
    await fs.mkdir(path.join(tmpDir, "10_Projects"), { recursive: true });
    const vault = new MockVaultRepository(tmpDir);
    await vault.writeNote("00_Inbox/old-note", {
      content: "project milestone",
      frontmatter: { triaged: true },
    });
    const services = makeServices({ vault });

    const result = await handleVaultTriageInbox(
      { inbox_folder: "00_Inbox", auto_move_threshold: 0.5, suggest_threshold: 0.3, dry_run: false, vault: "default" },
      services,
    );

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]?.text ?? "{}").data;
    expect(data.moved).toHaveLength(0);
    expect(data.suggested).toHaveLength(0);
    expect(data.skipped).toEqual(["00_Inbox/old-note.md"]);
  });

  it("continues processing when vaultSync.handleRename fails", async () => {
    await fs.mkdir(path.join(tmpDir, "10_Projects"), { recursive: true });
    const vault = new MockVaultRepository(tmpDir);
    await vault.writeNote("00_Inbox/project-note", {
      content: "project milestone",
      frontmatter: { type: "project" },
    });
    const vaultSync = { handleRename: mock().mockRejectedValue(new Error("sync down")) };
    const services = makeServices({ vault, vaultSync: vaultSync as unknown as VaultSync });

    const result = await handleVaultTriageInbox(
      { inbox_folder: "00_Inbox", auto_move_threshold: 0.5, suggest_threshold: 0.3, dry_run: false, vault: "default" },
      services,
    );

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]?.text ?? "{}").data;
    expect(data.moved).toHaveLength(1);
    expect(vaultSync.handleRename).toHaveBeenCalled();
  });

  it("processes multiple notes independently", async () => {
    await fs.mkdir(path.join(tmpDir, "10_Projects"), { recursive: true });
    const vault = new MockVaultRepository(tmpDir);
    await vault.writeNote("00_Inbox/project-a", {
      content: "project milestone",
      frontmatter: { type: "project" },
    });
    await vault.writeNote("00_Inbox/already-done", {
      content: "done",
      frontmatter: { triaged: true },
    });
    const services = makeServices({ vault });

    const result = await handleVaultTriageInbox(
      { inbox_folder: "00_Inbox", auto_move_threshold: 0.5, suggest_threshold: 0.3, dry_run: false, vault: "default" },
      services,
    );

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]?.text ?? "{}").data;
    expect(data.moved).toHaveLength(1);
    expect(data.skipped).toHaveLength(1);
  });
});
