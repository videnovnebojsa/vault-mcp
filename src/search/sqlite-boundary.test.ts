import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";

describe("SQLite shim boundary", () => {
  it("keeps search consumers from importing better-sqlite3 types directly [ARCH-01]", () => {
    const searchDir = path.join(process.cwd(), "src/search");
    const offenders = fs
      .readdirSync(searchDir)
      .filter((file) => file.endsWith(".ts"))
      .filter((file) =>
        /import\s+(?:type\s+)?[\s\S]*?\s+from\s+["']better-sqlite3["']/.test(
          fs.readFileSync(path.join(searchDir, file), "utf8"),
        ),
      );

    expect(offenders).toEqual([]);
  });

  it("keeps the backup method signature aligned with the store interface [ARCH-02]", () => {
    const store = fs.readFileSync(path.join(process.cwd(), "src/search/store.ts"), "utf8");

    expect(store).toContain("backup(destPath: string): void | Promise<void>");
    expect(store).not.toContain("async backup(destPath: string): Promise<void>");
  });

  it("keeps raw database handles out of the search store interface [ARCH-03]", () => {
    const store = fs.readFileSync(path.join(process.cwd(), "src/search/store.ts"), "utf8");
    const tasks = fs.readFileSync(path.join(process.cwd(), "src/search/tasks.ts"), "utf8");

    expect(store).not.toContain("getDatabase()");
    expect(store).toContain("backup(destPath: string): void | Promise<void>");
    expect(tasks).not.toContain("getDatabase()");
    expect(tasks).toContain("searchStore.backup(backupPath)");
  });

  it("documents and observes the Bun blocking backup path [PERF-01]", () => {
    const store = fs.readFileSync(path.join(process.cwd(), "src/search/store.ts"), "utf8");

    expect(store).toContain("// Bun blocking backup path");
    expect(store).toContain('logger.info("sqlite-shim", "backup started"');
    expect(store).toContain('logger.info("sqlite-shim", "backup finished"');
  });

  it("keeps PRAGMA SQL builder accessible via sqlite-shim-sql.ts [API-01]", () => {
    const shimSql = fs.readFileSync(path.join(process.cwd(), "src/search/sqlite-shim-sql.ts"), "utf8");

    expect(shimSql).toContain("pragmaSql");
    expect(shimSql).toContain("vacuumIntoSql");
    expect(shimSql).toContain("sqliteStringLiteral");
  });

  it("keeps reviewed PRAGMA policy coverage explicit [QA-04]", () => {
    const tests = fs.readFileSync(path.join(process.cwd(), "src/search/sqlite-shim-sql.test.ts"), "utf8");

    expect(tests).toContain("[QA-04]");
  });
});
