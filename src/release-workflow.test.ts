import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";

describe("release workflow", () => {
  it("does not interpolate workflow_dispatch inputs inside shell scripts [SEC-02]", () => {
    const workflow = fs.readFileSync(path.join(process.cwd(), ".github/workflows/release.yml"), "utf8");
    const runBlocks = workflow.match(/run: \|\n(?: {10}.+\n?)+/g) ?? [];

    expect(runBlocks.join("\n")).not.toContain("github.event.inputs.");
  });

  it("pins release builds to the packageManager Bun version [SEC-02]", () => {
    const workflow = fs.readFileSync(path.join(process.cwd(), ".github/workflows/release.yml"), "utf8");
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
      packageManager: string;
    };
    const bunVersion = pkg.packageManager.replace(/^bun@/, "");

    expect(workflow).toContain(`bun-version: "${bunVersion}"`);
  });

  it("documents why release jobs fail normally instead of using continue-on-error [ARCH-06]", () => {
    const workflow = fs.readFileSync(path.join(process.cwd(), ".github/workflows/release.yml"), "utf8");

    expect(workflow).toContain("continue-on-error");
    expect(workflow).toContain("fail-fast: false");
    expect(workflow).toContain("missing platform asset");
  });
});

describe("review documentation regressions", () => {
  it("documents why the Bun SQLite shim keeps PRAGMA execution constrained [ARCH-04]", () => {
    const architecture = fs.readFileSync(path.join(process.cwd(), "docs/contributing/architecture.md"), "utf8");

    expect(architecture).toContain("PRAGMA policy");
    expect(architecture).toContain("documented SQLite settings");
    expect(architecture).toContain("does not expose arbitrary PRAGMA passthrough");
  });

  it("documents the current Bun runtime and bun:sqlite storage boundary [ARCH-01]", () => {
    const architecture = fs.readFileSync(path.join(process.cwd(), "docs/contributing/architecture.md"), "utf8");

    expect(architecture).toContain("single-process Bun service");
    expect(architecture).toContain("SQLite via `bun:sqlite`");
    expect(architecture).not.toContain("better-sqlite3");
  });

  it("documents that binary build and smoke scripts require Bun [ARCH-05]", () => {
    const readme = fs.readFileSync(path.join(process.cwd(), "README.md"), "utf8");

    expect(readme).toContain("Binary build scripts");
    expect(readme).toContain("bun run build:bun");
    expect(readme).toContain("bun run scripts/smoke-test.ts");
  });

  it("documents VACUUM INTO backup behavior [API-02]", () => {
    const architecture = fs.readFileSync(path.join(process.cwd(), "docs/contributing/architecture.md"), "utf8");

    expect(architecture).toContain("Backup behavior");
    expect(architecture).toContain("VACUUM INTO");
  });

  it("does not describe PRAGMA policy in terms of a deleted compatibility shim [ARCH-07]", () => {
    const architecture = fs.readFileSync(path.join(process.cwd(), "docs/contributing/architecture.md"), "utf8");

    expect(architecture).not.toContain("shim to support");
    expect(architecture).not.toContain("shim to support the known Node/Bun compatibility settings");
  });

  it("keeps Claude guidance aligned with --alias removal [ARCH-07]", () => {
    const claude = fs.readFileSync(path.join(process.cwd(), "CLAUDE.md"), "utf8");

    expect(claude).toContain("--alias");
    expect(claude).toContain("not supported");
  });
});
