import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { VAULT_FOLDERS } from "../config/folders.js";
import { VaultRepository } from "../vault/repository.js";
import { SecondBrainService } from "./service.js";

describe("SecondBrainService.processCapture", () => {
  let tmpDir: string;
  let vault: VaultRepository;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "capture-service-"));
    vault = new VaultRepository({ vaultPath: tmpDir });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("writes a classified capture note and appends an audit log", async () => {
    const service = new SecondBrainService(
      { vaultPath: tmpDir, enableCapturePipeline: true, logRawInput: false, folders: VAULT_FOLDERS },
      vault,
    );

    const result = await service.processCapture("/capture idea for semantic search improvements");

    expect(result.ok).toBe(true);
    expect(result.notePath).toBeDefined();
    const note = await vault.readNote(result.notePath ?? "");
    expect(note.content.trim()).toBe("idea for semantic search improvements");
    expect(note.frontmatter.type).toBe("capture");
    expect(note.frontmatter.category).toBe(result.classification?.category);

    const logDir = path.join(tmpDir, "70_AI_Logs", "classifications");
    const [logFile] = await fs.readdir(logDir);
    const log = await fs.readFile(path.join(logDir, logFile ?? ""), "utf-8");
    expect(log).toContain("# Classification Log");
    expect(log).toContain(`[[${result.notePath}]]`);
    expect(log).not.toContain("**Raw input**");
  });

  it("returns a disabled result without writing a note when capture is off", async () => {
    const service = new SecondBrainService(
      { vaultPath: tmpDir, enableCapturePipeline: false, logRawInput: false, folders: VAULT_FOLDERS },
      vault,
    );

    const result = await service.processCapture("some idea");

    expect(result).toEqual({ ok: false, message: "Capture pipeline is disabled" });
    await expect(fs.readdir(tmpDir)).resolves.toEqual([]);
  });

  it("routes capture to custom inbox folder when confidence is low [QA-06]", async () => {
    const customFolders = { ...VAULT_FOLDERS, INBOX: "MyInbox" };
    const service = new SecondBrainService(
      { vaultPath: tmpDir, enableCapturePipeline: true, logRawInput: false, folders: customFolders },
      vault,
    );

    // Unclassifiable content → low confidence → routed to inbox
    const result = await service.processCapture("xyzzy quux bloop");

    expect(result.ok).toBe(true);
    expect(result.notePath).toMatch(/^MyInbox\//);
  });

  it("routes capture to custom category folder when confidence is high [QA-06]", async () => {
    const customFolders = { ...VAULT_FOLDERS, PEOPLE: "MyPeople" };
    const service = new SecondBrainService(
      { vaultPath: tmpDir, enableCapturePipeline: true, logRawInput: false, folders: customFolders },
      vault,
    );

    // "met with" triggers person category (confidence 0.7) → routes to PEOPLE
    const result = await service.processCapture("met with Alice about the quarterly review");

    expect(result.ok).toBe(true);
    expect(result.notePath).toMatch(/^MyPeople\//);
  });

  it("writes audit log to custom AI_LOGS folder [QA-06]", async () => {
    const customFolders = { ...VAULT_FOLDERS, AI_LOGS: "MyAILogs" };
    const service = new SecondBrainService(
      { vaultPath: tmpDir, enableCapturePipeline: true, logRawInput: false, folders: customFolders },
      vault,
    );

    const result = await service.processCapture("/capture idea for something");

    expect(result.ok).toBe(true);
    const logDir = path.join(tmpDir, "MyAILogs", "classifications");
    const entries = await fs.readdir(logDir);
    expect(entries.length).toBeGreaterThan(0);
  });
});
