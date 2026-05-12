import { describe, expect, it } from "vitest";
import { parseFrontmatter, serializeNote, validateFrontmatter } from "./frontmatter.js";

describe("parseFrontmatter", () => {
  it("parses frontmatter and content", () => {
    const raw = `---
type: capture
tags:
  - test
---
# Hello

World`;
    const result = parseFrontmatter(raw);
    expect(result.frontmatter.type).toBe("capture");
    expect(result.frontmatter.tags).toEqual(["test"]);
    expect(result.content).toContain("# Hello");
    expect(result.content).toContain("World");
    expect(result.raw).toBe(raw);
  });

  it("handles notes without frontmatter", () => {
    const raw = "# Just content\n\nNo frontmatter here.";
    const result = parseFrontmatter(raw);
    expect(result.frontmatter).toEqual({});
    expect(result.content).toContain("# Just content");
    expect(result.content).toContain("No frontmatter here.");
  });

  it("handles empty frontmatter", () => {
    const raw = "---\n---\nContent";
    const result = parseFrontmatter(raw);
    expect(result.frontmatter).toEqual({});
    expect(result.content).toContain("Content");
  });

  it("does not trim content whitespace", () => {
    const raw = "---\ntype: capture\n---\n\nContent with trailing newline\n";
    const result = parseFrontmatter(raw);
    expect(result.content).toContain("trailing newline\n");
  });
});

describe("serializeNote", () => {
  it("roundtrips frontmatter correctly", () => {
    const raw = `---
type: capture
tags:
  - test
---
# Hello

World`;
    const parsed = parseFrontmatter(raw);
    const serialized = serializeNote(parsed.content, parsed.frontmatter);
    const reparsed = parseFrontmatter(serialized);

    expect(reparsed.frontmatter.type).toBe("capture");
    expect(reparsed.frontmatter.tags).toEqual(["test"]);
    expect(reparsed.content).toContain("# Hello");
  });

  it("returns plain content when frontmatter is empty", () => {
    const result = serializeNote("Hello", {});
    expect(result).toBe("Hello");
  });
});

describe("validateFrontmatter", () => {
  it("validates correct frontmatter", () => {
    const result = validateFrontmatter({
      type: "capture",
      confidence: 0.85,
      tags: ["test"],
    });
    expect(result.ok).toBe(true);
  });

  it("rejects invalid confidence", () => {
    const result = validateFrontmatter({ confidence: 1.5 });
    expect(result.ok).toBe(false);
    expect(result.errors).toBeDefined();
  });

  it("requires type when requireType is set", () => {
    const result = validateFrontmatter({}, { requireType: true });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("type: Required");
  });

  it("passes with type when requireType is set", () => {
    const result = validateFrontmatter({ type: "capture" }, { requireType: true });
    expect(result.ok).toBe(true);
  });

  it("allows extra fields via passthrough", () => {
    const result = validateFrontmatter({
      type: "capture",
      custom_field: "hello",
      nested: { a: 1 },
    });
    expect(result.ok).toBe(true);
  });
});
