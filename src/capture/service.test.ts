import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
      { vaultPath: tmpDir, enableCapturePipeline: true, logRawInput: false },
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
      { vaultPath: tmpDir, enableCapturePipeline: false, logRawInput: false },
      vault,
    );

    const result = await service.processCapture("some idea");

    expect(result).toEqual({ ok: false, message: "Capture pipeline is disabled" });
    await expect(fs.readdir(tmpDir)).resolves.toEqual([]);
  });
});
