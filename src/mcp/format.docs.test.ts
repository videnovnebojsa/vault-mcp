import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";

describe("response envelope design standard", () => {
  it("documents both listResult pagination descriptor shapes", () => {
    const docs = fs.readFileSync(path.join(process.cwd(), "docs/DESIGN_STANDARDS.md"), "utf8");

    expect(docs).toContain('listResult(items, { kind: "knownTotal"');
    expect(docs).toContain('listResult(items, { kind: "unknownTotal"');
    expect(docs).not.toContain("listResult(items, total, offset, limit)");
  });
});
