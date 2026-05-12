import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Period } from "./periodic.js";
import { buildPeriodicPath, openOrCreatePeriodicNote } from "./periodic.js";
import { VaultRepository } from "./repository.js";

describe("buildPeriodicPath", () => {
  it("builds daily path", () => {
    const d = new Date(2026, 4, 7); // May 7, 2026
    expect(buildPeriodicPath("daily", d, "Journal")).toBe("Journal/2026/2026-05-07.md");
  });

  it("builds monthly path", () => {
    const d = new Date(2026, 4, 7);
    expect(buildPeriodicPath("monthly", d, "Journal")).toBe("Journal/2026/2026-05.md");
  });

  it("builds weekly path with zero-padded week", () => {
    const d = new Date(2026, 0, 5); // Jan 5, 2026 — week 2
    const result = buildPeriodicPath("weekly", d, "Journal");
    expect(result).toMatch(/Journal\/2026\/2026-W\d{2}\.md/);
  });

  it("strips trailing slash from root", () => {
    const d = new Date(2026, 4, 7);
    expect(buildPeriodicPath("daily", d, "Journal/")).toBe("Journal/2026/2026-05-07.md");
  });

  it("handles December correctly", () => {
    const d = new Date(2026, 11, 31);
    expect(buildPeriodicPath("daily", d, "Notes")).toBe("Notes/2026/2026-12-31.md");
    expect(buildPeriodicPath("monthly", d, "Notes")).toBe("Notes/2026/2026-12.md");
  });

  it("handles ISO week spanning year boundary — Dec 28 is in week 53 or last week", () => {
    const d = new Date(2026, 11, 28);
    const result = buildPeriodicPath("weekly", d, "Journal");
    expect(result).toMatch(/Journal\/2026\/2026-W\d{2}\.md/);
  });
});

describe("openOrCreatePeriodicNote", () => {
  let tmpDir: string;
  let repo: VaultRepository;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vault-periodic-test-"));
    repo = new VaultRepository({ vaultPath: tmpDir });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("creates a daily note if it does not exist", async () => {
    const d = new Date(2026, 4, 7);
    const note = await openOrCreatePeriodicNote(repo, "daily", d, "Journal");
    expect(note.path).toBe("Journal/2026/2026-05-07.md");
    expect(note.frontmatter.type).toBe("periodic");
    expect(note.frontmatter.period).toBe("daily");
    expect(note.frontmatter.date).toBe("2026-05-07");
  });

  it("returns existing note without overwriting", async () => {
    const d = new Date(2026, 4, 7);
    await openOrCreatePeriodicNote(repo, "daily", d, "Journal");
    await repo.updateProperties("Journal/2026/2026-05-07", { custom: "value" });
    const note = await openOrCreatePeriodicNote(repo, "daily", d, "Journal");
    expect(note.frontmatter.custom).toBe("value");
  });

  it.each([["daily"], ["weekly"], ["monthly"]] as [Period][][])("creates %s note without error", async (period) => {
    const d = new Date(2026, 4, 7);
    const note = await openOrCreatePeriodicNote(repo, period, d, "Journal");
    expect(note.frontmatter.period).toBe(period);
  });
});
