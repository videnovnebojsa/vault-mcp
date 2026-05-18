import type { Database } from "bun:sqlite";
import { logger } from "../utils/logger.js";

export interface Migration {
  version: number;
  description: string;
  up: string;
}

/**
 * Initial vault_entries schema plus FTS5 table.
 * Split out from the old SCHEMA constant in store.ts so it can live in a migration.
 */
const VAULT_ENTRIES_V1_SCHEMA = `
  CREATE TABLE IF NOT EXISTS vault_entries (
    canonical_path TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    file_name TEXT NOT NULL,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS vault_fts USING fts5(
    content,
    file_name,
    canonical_path UNINDEXED,
    tokenize='porter unicode61'
  );
`;

const VAULT_ENTRIES_V2_INDEXES = `
  CREATE INDEX IF NOT EXISTS idx_vault_entries_updated_at ON vault_entries(updated_at);
  CREATE INDEX IF NOT EXISTS idx_vault_entries_created_at ON vault_entries(created_at);
`;

export const VAULT_ENTRIES_MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: "Initial schema",
    up: VAULT_ENTRIES_V1_SCHEMA,
  },
  {
    version: 2,
    description: "Add indexes for date filtering",
    up: VAULT_ENTRIES_V2_INDEXES,
  },
];

/**
 * Initial embeddings schema.
 */
const EMBEDDINGS_V1_SCHEMA = `
  CREATE TABLE IF NOT EXISTS vault_embeddings (
    path TEXT PRIMARY KEY,
    embedding BLOB NOT NULL,
    content_hash TEXT NOT NULL,
    model TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
`;

const EMBEDDINGS_V2_INDEXES = `
  CREATE INDEX IF NOT EXISTS idx_vault_embeddings_path_hash_model ON vault_embeddings(path, content_hash, model);
`;

export const EMBEDDINGS_MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: "Initial embeddings schema",
    up: EMBEDDINGS_V1_SCHEMA,
  },
  {
    version: 2,
    description: "Add covering index for stale embedding checks",
    up: EMBEDDINGS_V2_INDEXES,
  },
];

const migrationCache = new WeakMap<Database, Map<string, number>>();

/**
 * Run all pending migrations on the given database.
 * Creates a version table if it doesn't exist. Only runs migrations with
 * version > currentVersion. Each migration runs in its own transaction.
 */
export function runMigrations(db: Database, migrations: Migration[], tableName: string): void {
  if (!/^[a-z_]+$/.test(tableName)) {
    throw new Error(`Invalid migration table name: ${tableName}`);
  }
  const latestVersion = Math.max(0, ...migrations.map((m) => m.version));
  const dbCache = migrationCache.get(db);
  if ((dbCache?.get(tableName) ?? -1) >= latestVersion) return;

  // Ensure version tracking table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${tableName} (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL DEFAULT 0
    );
    INSERT OR IGNORE INTO ${tableName} (id, version) VALUES (1, 0);
  `);

  const currentVersion = (db.prepare(`SELECT version FROM ${tableName} WHERE id = 1`).get() as { version: number })
    .version;

  const pending = migrations.filter((m) => m.version > currentVersion);
  if (pending.length === 0) {
    setMigrationCache(db, tableName, currentVersion);
    return;
  }

  for (const migration of pending) {
    logger.info("migrations", `applying migration v${migration.version}: ${migration.description}`);
    db.transaction(() => {
      db.exec(migration.up);
      db.prepare(`UPDATE ${tableName} SET version = ? WHERE id = 1`).run(migration.version);
    })();
  }
  setMigrationCache(db, tableName, latestVersion);
}

function setMigrationCache(db: Database, tableName: string, version: number): void {
  let dbCache = migrationCache.get(db);
  if (!dbCache) {
    dbCache = new Map();
    migrationCache.set(db, dbCache);
  }
  dbCache.set(tableName, version);
}
