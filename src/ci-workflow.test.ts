import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";

describe("CI workflow", () => {
  it("does not filter PR integration runs using the changed_files count [ARCH-01]", () => {
    const workflow = fs.readFileSync(path.join(process.cwd(), ".github/workflows/ci.yml"), "utf8");

    expect(workflow).not.toContain("github.event.pull_request.changed_files");
    expect(workflow).toContain("github.event_name == 'pull_request'");
  });

  it("shares the Linux binary artifact between build and integration jobs [ARCH-02]", () => {
    const workflow = fs.readFileSync(path.join(process.cwd(), ".github/workflows/ci.yml"), "utf8");

    expect(workflow).toContain("name: Upload Linux binary");
    expect(workflow).toContain("actions/upload-artifact");
    expect(workflow).toContain("name: Download Linux binary");
    expect(workflow).toContain("actions/download-artifact");
    expect(workflow).toContain("needs: [build]");
    expect(workflow).not.toContain("name: Build Linux binary");
  });
});
