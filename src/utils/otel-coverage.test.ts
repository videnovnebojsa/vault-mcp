import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";

describe("OTel coverage config", () => {
  it("does not exclude otel.ts from coverage [SEC-05]", () => {
    const bunfig = fs.readFileSync(path.join(process.cwd(), "bunfig.toml"), "utf8");

    expect(bunfig).toContain("coveragePathIgnorePatterns");
    expect(bunfig).not.toContain('"src/utils/otel.ts"');
  });
});
