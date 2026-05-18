import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { type Migration, runMigrations } from "./migrations.js";

function freshDb(): Database {
  return new Database(":memory:");
}

const V1: Migration = {
  version: 1,
  description: "Initial schema",
  up: "CREATE TABLE IF NOT EXISTS test_items (id INTEGER PRIMARY KEY, name TEXT NOT NULL);",
};

const V2: Migration = {
  version: 2,
  description: "Add index",
  up: "CREATE INDEX IF NOT EXISTS idx_name ON test_items(name);",
};

describe("runMigrations", () => {
  it("fresh database ends at current version", () => {
    const db = freshDb();
    runMigrations(db, [V1, V2], "schema_version");

    const row = db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as { version: number };
    expect(row.version).toBe(2);

    // Table should exist
    expect(() => db.prepare("SELECT COUNT(*) FROM test_items").get()).not.toThrow();
    // Index should exist
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_name'").get();
    expect(idx).toBeTruthy();
  });

  it("v0 database gets migrated to current version", () => {
    const db = freshDb();
    // Simulate a v0 database: create version table but leave version at 0
    db.exec(`
      CREATE TABLE schema_version (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO schema_version (id, version) VALUES (1, 0);
    `);

    runMigrations(db, [V1, V2], "schema_version");

    const row = db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as { version: number };
    expect(row.version).toBe(2);
  });

  it("already-at-current-version database is not re-migrated", () => {
    const db = freshDb();
    runMigrations(db, [V1, V2], "schema_version");

    // Manually verify we're at v2
    const before = db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as { version: number };
    expect(before.version).toBe(2);

    // Second call should be a no-op
    runMigrations(db, [V1, V2], "schema_version");

    const after = db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as { version: number };
    expect(after.version).toBe(2);
  });

  it("partially migrated database continues from where it left off", () => {
    const db = freshDb();
    // Apply only v1
    runMigrations(db, [V1], "schema_version");

    const v1Row = db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as { version: number };
    expect(v1Row.version).toBe(1);

    // Now apply v2
    runMigrations(db, [V1, V2], "schema_version");

    const v2Row = db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as { version: number };
    expect(v2Row.version).toBe(2);
  });

  it("bad SQL migration rolls back and throws", () => {
    const db = freshDb();

    const badMigration: Migration = {
      version: 1,
      description: "Bad SQL",
      up: "THIS IS NOT VALID SQL !!!;",
    };

    expect(() => runMigrations(db, [badMigration], "schema_version")).toThrow();

    // Version should remain at 0 (transaction rolled back)
    const row = db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as { version: number };
    expect(row.version).toBe(0);
  });

  it("uses a separate version table namespace (no collision)", () => {
    const db = freshDb();
    const migrationsA: Migration[] = [
      { version: 1, description: "A1", up: "CREATE TABLE IF NOT EXISTS tbl_a (id INTEGER PRIMARY KEY);" },
    ];
    const migrationsB: Migration[] = [
      { version: 1, description: "B1", up: "CREATE TABLE IF NOT EXISTS tbl_b (id INTEGER PRIMARY KEY);" },
    ];

    runMigrations(db, migrationsA, "version_a");
    runMigrations(db, migrationsB, "version_b");

    const rowA = db.prepare("SELECT version FROM version_a WHERE id = 1").get() as { version: number };
    const rowB = db.prepare("SELECT version FROM version_b WHERE id = 1").get() as { version: number };
    expect(rowA.version).toBe(1);
    expect(rowB.version).toBe(1);
  });

  it("rejects unsafe version table names", () => {
    const db = freshDb();
    expect(() => runMigrations(db, [V1], "schema_version; DROP TABLE test_items")).toThrow(/Invalid migration table/);
    expect(() => runMigrations(db, [V1], "schemaVersion")).toThrow(/Invalid migration table/);
  });
});
