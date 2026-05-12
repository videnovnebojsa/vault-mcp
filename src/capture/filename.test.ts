import { describe, expect, it } from "vitest";
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
    const path = buildCapturePath("person", "John Smith", "00_Inbox");
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
});

describe("buildAuditLogPath", () => {
  it("returns correct path format", () => {
    const path = buildAuditLogPath();
    expect(path).toMatch(/^70_AI_Logs\/classifications\/\d{4}-\d{2}-\d{2}-classifications\.md$/);
  });
});
