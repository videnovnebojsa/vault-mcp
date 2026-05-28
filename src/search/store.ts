import { Database, type Statement } from "bun:sqlite";
import { logger } from "../utils/logger.js";
import { isAclAllowed } from "../vault/path-safety.js";
import { EmbeddingStore } from "./embeddings.js";
import { runMigrations, VAULT_ENTRIES_MIGRATIONS } from "./migrations.js";
import { pragmaSql, sqliteStringLiteral, vacuumIntoSql } from "./sqlite-shim-sql.js";
import type { SearchResult, VaultEntry } from "./types.js";

const STMT_CACHE_MAX = 256;
const MEMORY_DB_PATH = ":memory:";

type BackupWorkerResponse =
  | { ok: true }
  | { ok: false; error: { name: string; message: string; stack?: string | undefined } };

const BACKUP_WORKER_SOURCE = `
import { Database } from "bun:sqlite";

function sqliteStringLiteral(source) {
  if (!/^'(?:[^']|'')*'$/.test(source)) {
    throw new Error("Expected SQLite quote() string literal");
  }
  return source;
}

self.onmessage = (event) => {
  const { dbPath, destPath } = event.data;
  const db = new Database(dbPath);
  try {
    const row = db.prepare("SELECT quote(?) AS literal").get(destPath);
    db.exec(\`VACUUM INTO \${sqliteStringLiteral(row.literal)}\`);
    self.postMessage({ ok: true });
  } catch (err) {
    self.postMessage({
      ok: false,
      error: {
        name: err instanceof Error ? err.name : typeof err,
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      },
    });
  } finally {
    db.close();
  }
};
`;

export interface ISearchStore {
  getStatementCacheSize(): number;
  backup(destPath: string): void | Promise<void>;
  getSchemaVersion(): number;
  upsert(
    canonicalPath: string,
    content: string,
    contentHash: string,
    fileName: string,
    metadata: Record<string, unknown>,
    fileTimes?: { createdAt?: number; updatedAt?: number },
  ): { changed: boolean };
  searchFTS(
    query: string,
    limit?: number,
    folder?: string,
    filters?: { tags?: string[]; type?: string; modifiedAfter?: number; createdAfter?: number },
    acl?: { allowPaths: string[]; denyPaths: string[] },
  ): SearchResult[];
  listTags(acl?: { allowPaths: string[]; denyPaths: string[] }): Array<{ tag: string; count: number }>;
  listTagsPage(
    limit: number,
    offset: number,
    acl?: { allowPaths: string[]; denyPaths: string[] },
  ): { items: Array<{ tag: string; count: number }>; total: number };
  countUniqueTags(acl?: { allowPaths: string[]; denyPaths: string[] }): number;
  getByPath(canonicalPath: string): VaultEntry | undefined;
  getBatchByPaths(paths: string[]): Map<string, VaultEntry>;
  deleteByPath(canonicalPath: string): boolean;
  listCanonicalPaths(acl?: { allowPaths: string[]; denyPaths: string[] }): string[];
  count(acl?: { allowPaths: string[]; denyPaths: string[] }): number;
  getContentHashMap(): Map<string, string>;
  getContentByPath(path: string): string | undefined;
  getContentBatchByPaths(paths: string[]): Map<string, string>;
  getPathIndex(): Map<string, string>;
  searchHybrid(
    ftsQuery: string,
    queryEmbedding: Float32Array,
    embeddingStore: EmbeddingStore,
    alpha: number,
    limit: number,
    folder?: string,
    acl?: { allowPaths: string[]; denyPaths: string[] },
    candidateMultiplier?: number,
  ): SearchResult[];
  countFTS(): number;
  close(): void;
}

export class VaultSearchStore implements ISearchStore {
  private db: Database;
  private readonly dbPath: string;
  private readonly stmtGetByPath: Statement;
  private readonly stmtUpsertEntry: Statement;
  private readonly stmtDeleteEntry: Statement;
  private readonly stmtDeleteFts: Statement;
  private readonly stmtInsertFts: Statement;
  private readonly stmtCountFTS: Statement;
  private readonly stmtGetSchemaVersion: Statement;
  private readonly stmtGetContentHashMap: Statement;
  private readonly stmtGetContentByPath: Statement;
  private readonly stmtQuotePath: Statement;
  /** Cached transaction functions — allocated once at construction, not per-call. */
  private readonly txUpsert: (
    path: string,
    content: string,
    hash: string,
    name: string,
    meta: string,
    createdAt: number,
    updatedAt: number,
  ) => void;
  private readonly txDelete: (path: string) => boolean;
  /** Lazy cache for dynamic-SQL statements (key = SQL string). */
  private readonly stmtCache = new Map<string, Statement>();
  private pathIndexCache: Map<string, string> | undefined;

  constructor(dbPath: string = MEMORY_DB_PATH) {
    this.dbPath = dbPath;
    this.db = new Database(dbPath);
    this.enableWalMode();
    runMigrations(this.db, VAULT_ENTRIES_MIGRATIONS, "schema_version");

    this.stmtGetByPath = this.db.prepare("SELECT * FROM vault_entries WHERE canonical_path = ?");
    this.stmtUpsertEntry = this.db.prepare(
      `INSERT OR REPLACE INTO vault_entries (canonical_path, content, content_hash, file_name, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.stmtDeleteEntry = this.db.prepare("DELETE FROM vault_entries WHERE canonical_path = ?");
    this.stmtDeleteFts = this.db.prepare("DELETE FROM vault_fts WHERE canonical_path = ?");
    this.stmtInsertFts = this.db.prepare("INSERT INTO vault_fts (content, file_name, canonical_path) VALUES (?, ?, ?)");
    this.stmtCountFTS = this.db.prepare("SELECT COUNT(*) as n FROM vault_fts");
    this.stmtGetSchemaVersion = this.db.prepare("SELECT version FROM schema_version WHERE id = 1");
    this.stmtGetContentHashMap = this.db.prepare("SELECT canonical_path, content_hash FROM vault_entries");
    this.stmtGetContentByPath = this.db.prepare("SELECT content FROM vault_entries WHERE canonical_path = ?");
    this.stmtQuotePath = this.db.prepare("SELECT quote(?) AS literal");

    const stmtUpsertEntry = this.stmtUpsertEntry;
    const stmtDeleteFts = this.stmtDeleteFts;
    const stmtInsertFts = this.stmtInsertFts;
    const stmtDeleteEntry = this.stmtDeleteEntry;
    this.txUpsert = this.db.transaction(
      (
        path: string,
        content: string,
        hash: string,
        name: string,
        meta: string,
        createdAt: number,
        updatedAt: number,
      ) => {
        stmtUpsertEntry.run(path, content, hash, name, meta, createdAt, updatedAt);
        stmtDeleteFts.run(path);
        stmtInsertFts.run(content, name, path);
      },
    );
    this.txDelete = this.db.transaction((path: string): boolean => {
      const result = stmtDeleteEntry.run(path);
      stmtDeleteFts.run(path);
      return result.changes > 0;
    });
  }

  private cachedPrepare(sql: string): Statement {
    let stmt = this.stmtCache.get(sql);
    if (stmt) {
      this.stmtCache.delete(sql);
      this.stmtCache.set(sql, stmt);
      return stmt;
    }
    stmt = this.db.prepare(sql);
    this.stmtCache.set(sql, stmt);
    if (this.stmtCache.size > STMT_CACHE_MAX) {
      const oldestKey = this.stmtCache.keys().next().value;
      if (oldestKey !== undefined) this.stmtCache.delete(oldestKey);
    }
    return stmt;
  }

  getStatementCacheSize(): number {
    return this.stmtCache.size;
  }

  private enableWalMode(): void {
    try {
      const row = this.db.prepare(pragmaSql("journal_mode = WAL")).get() as { journal_mode?: string } | undefined;
      const journalMode = row?.journal_mode?.toLowerCase() ?? "unknown";
      if (this.dbPath !== MEMORY_DB_PATH && journalMode !== "wal") {
        logger.warn("sqlite-shim", "WAL journal mode was not enabled", { dbPath: this.dbPath, journalMode });
      }
    } catch (err) {
      logger.warn("sqlite-shim", "WAL journal mode pragma failed", {
        dbPath: this.dbPath,
        err: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  backup(destPath: string): void | Promise<void> {
    // Bun blocking backup path — VACUUM INTO (no online backup API in bun:sqlite)
    logger.info("sqlite-shim", "backup started", { destPath });
    try {
      if (this.dbPath === MEMORY_DB_PATH) {
        this.backupWithConnection(destPath);
        logger.info("sqlite-shim", "backup finished", { destPath });
        return;
      }
      return backupFileDatabaseInWorker(this.dbPath, destPath)
        .then(() => {
          logger.info("sqlite-shim", "backup finished", { destPath });
        })
        .catch((err) => {
          logger.error("sqlite-shim", "backup failed", {
            destPath,
            err: err instanceof Error ? err.message : String(err),
          });
          throw err;
        });
    } catch (err) {
      logger.error("sqlite-shim", "backup failed", {
        destPath,
        err: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  private backupWithConnection(destPath: string): void {
    const row = this.stmtQuotePath.get(destPath) as { literal: string };
    this.db.exec(vacuumIntoSql(sqliteStringLiteral(row.literal)));
  }

  createEmbeddingStore(): EmbeddingStore {
    return new EmbeddingStore(this.db);
  }

  getSchemaVersion(): number {
    try {
      const row = this.stmtGetSchemaVersion.get() as { version: number } | undefined;
      return row?.version ?? 0;
    } catch (err) {
      if (isMissingSchemaVersionTableError(err)) {
        return 0;
      }
      throw err;
    }
  }
  upsert(
    canonicalPath: string,
    content: string,
    contentHash: string,
    fileName: string,
    metadata: Record<string, unknown>,
    fileTimes?: { createdAt?: number; updatedAt?: number },
  ): { changed: boolean } {
    const existing = this.stmtGetByPath.get(canonicalPath) as { content_hash: string; created_at: number } | undefined;

    if (existing && existing.content_hash === contentHash) {
      return { changed: false };
    }

    const now = Date.now();
    const createdAt = existing?.created_at ?? fileTimes?.createdAt ?? now;
    const updatedAt = fileTimes?.updatedAt ?? now;

    try {
      this.txUpsert(canonicalPath, content, contentHash, fileName, JSON.stringify(metadata), createdAt, updatedAt);
    } catch (err) {
      logger.error("store", "upsert transaction failed", {
        path: canonicalPath,
        code: sqliteErrorCode(err),
        err: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    if (!existing && this.pathIndexCache) {
      const stem = canonicalPath.replace(/\.md$/, "").split("/").pop() ?? "";
      if (stem && !this.pathIndexCache.has(stem)) this.pathIndexCache.set(stem, canonicalPath);
      this.pathIndexCache.set(canonicalPath.replace(/\.md$/, ""), canonicalPath);
      this.pathIndexCache.set(canonicalPath, canonicalPath);
    }
    return { changed: true };
  }

  searchFTS(
    query: string,
    limit: number = 20,
    folder?: string,
    filters?: { tags?: string[]; type?: string; modifiedAfter?: number; createdAfter?: number },
    acl?: { allowPaths: string[]; denyPaths: string[] },
  ): SearchResult[] {
    const sanitized = sanitizeFTS5Query(query);
    if (!sanitized) return [];

    const hasTagFilter = filters?.tags && filters.tags.length > 0;
    const hasTypeFilter = !!filters?.type;
    const needsPostFilter = hasTagFilter;

    let sql = `SELECT
           f.canonical_path,
           e.file_name,
           f.rank,
           snippet(vault_fts, 0, '**', '**', '…', 64) AS snippet,
           e.metadata
         FROM vault_fts f
         JOIN vault_entries e ON e.canonical_path = f.canonical_path
         WHERE vault_fts MATCH ?`;
    const params: (string | number)[] = [sanitized];

    if (folder) {
      const prefix = folder.endsWith("/") ? folder : `${folder}/`;
      sql += ` AND f.canonical_path LIKE ? ESCAPE '\\'`;
      params.push(`${escapeLike(prefix)}%`);
    }

    if (hasTypeFilter) {
      sql += ` AND json_extract(e.metadata, '$.type') = ?`;
      params.push(filters?.type ?? "");
    }

    if (filters?.modifiedAfter !== undefined) {
      sql += ` AND e.updated_at >= ?`;
      params.push(filters.modifiedAfter);
    }

    if (filters?.createdAfter !== undefined) {
      sql += ` AND e.created_at >= ?`;
      params.push(filters.createdAfter);
    }

    // ACL: deny-list (exact match or prefix) and allow-list pushed into SQL predicates.
    const { clauses: aclClauses, params: aclParams } = buildAclClauses(acl, "f.canonical_path");
    if (aclClauses) {
      sql += ` AND ${aclClauses}`;
      params.push(...aclParams);
    }

    sql += ` ORDER BY f.rank LIMIT ?`;
    params.push(needsPostFilter ? limit * 4 : limit);

    const rows = this.cachedPrepare(sql).all(...params) as Array<{
      canonical_path: string;
      file_name: string;
      rank: number;
      snippet: string;
      metadata: string;
    }>;

    let results = rows.map((r) => ({
      path: r.canonical_path,
      name: r.file_name,
      score: -r.rank,
      snippet: r.snippet,
      frontmatter: safeParseMetadata(r.metadata, r.canonical_path),
    }));

    if (hasTagFilter) {
      results = results.filter((r) => {
        const noteTags = r.frontmatter["tags"];
        if (!Array.isArray(noteTags)) return false;
        return filters?.tags?.some((t) => noteTags.includes(t));
      });
    }

    return results.slice(0, limit);
  }

  listTags(acl?: { allowPaths: string[]; denyPaths: string[] }): Array<{ tag: string; count: number }> {
    return this.listTagsPage(this.countUniqueTags(acl), 0, acl).items;
  }

  listTagsPage(
    limit: number,
    offset: number,
    acl?: { allowPaths: string[]; denyPaths: string[] },
  ): { items: Array<{ tag: string; count: number }>; total: number } {
    const { clauses, params } = buildAclClauses(acl, "canonical_path");
    const where = clauses ? `AND ${clauses}` : "";
    const sql = `SELECT json_each.value AS tag, COUNT(*) AS count
         FROM vault_entries, json_each(json_extract(metadata, '$.tags'))
         WHERE json_extract(metadata, '$.tags') IS NOT NULL ${where}
         GROUP BY tag
         ORDER BY count DESC
         LIMIT ? OFFSET ?`;
    const countSql = `SELECT COUNT(*) AS count FROM (
         SELECT json_each.value AS tag
         FROM vault_entries, json_each(json_extract(metadata, '$.tags'))
         WHERE json_extract(metadata, '$.tags') IS NOT NULL ${where}
         GROUP BY tag
       )`;
    return {
      items: this.cachedPrepare(sql).all(...params, limit, offset) as Array<{ tag: string; count: number }>,
      total: (this.cachedPrepare(countSql).get(...params) as { count: number }).count,
    };
  }

  countUniqueTags(acl?: { allowPaths: string[]; denyPaths: string[] }): number {
    const { clauses, params } = buildAclClauses(acl, "canonical_path");
    const where = clauses ? `AND ${clauses}` : "";
    const sql = `SELECT COUNT(DISTINCT json_each.value) AS count
         FROM vault_entries, json_each(json_extract(metadata, '$.tags'))
         WHERE json_extract(metadata, '$.tags') IS NOT NULL ${where}`;
    return (this.cachedPrepare(sql).get(...params) as { count: number }).count;
  }

  getByPath(canonicalPath: string): VaultEntry | undefined {
    const row = this.stmtGetByPath.get(canonicalPath) as DatabaseRow | undefined;
    return row ? rowToEntry(row) : undefined;
  }

  getBatchByPaths(paths: string[]): Map<string, VaultEntry> {
    if (paths.length === 0) return new Map();
    const sql = "SELECT * FROM vault_entries WHERE canonical_path IN (SELECT value FROM json_each(?))";
    const rows = this.cachedPrepare(sql).all(JSON.stringify(paths)) as DatabaseRow[];
    return new Map(rows.map((r) => [r.canonical_path, rowToEntry(r)]));
  }

  deleteByPath(canonicalPath: string): boolean {
    const deleted = this.txDelete(canonicalPath);
    if (deleted) this.pathIndexCache = undefined;
    return deleted;
  }

  listCanonicalPaths(acl?: { allowPaths: string[]; denyPaths: string[] }): string[] {
    const { clauses, params } = buildAclClauses(acl, "canonical_path");
    const where = clauses ? `WHERE ${clauses}` : "";
    const sql = `SELECT canonical_path FROM vault_entries ${where}`;
    return (this.cachedPrepare(sql).all(...params) as Array<{ canonical_path: string }>).map((r) => r.canonical_path);
  }

  count(acl?: { allowPaths: string[]; denyPaths: string[] }): number {
    const { clauses, params } = buildAclClauses(acl, "canonical_path");
    const where = clauses ? `WHERE ${clauses}` : "";
    const sql = `SELECT COUNT(*) as count FROM vault_entries ${where}`;
    return (this.cachedPrepare(sql).get(...params) as { count: number }).count;
  }

  getContentHashMap(): Map<string, string> {
    const rows = this.stmtGetContentHashMap.all() as Array<{
      canonical_path: string;
      content_hash: string;
    }>;
    const map = new Map<string, string>();
    for (const row of rows) {
      map.set(row.canonical_path, row.content_hash);
    }
    return map;
  }

  getContentByPath(path: string): string | undefined {
    return (this.stmtGetContentByPath.get(path) as { content: string } | undefined)?.content;
  }

  getContentBatchByPaths(paths: string[]): Map<string, string> {
    if (paths.length === 0) return new Map();
    const sql =
      "SELECT canonical_path, content FROM vault_entries WHERE canonical_path IN (SELECT value FROM json_each(?))";
    const rows = this.cachedPrepare(sql).all(JSON.stringify(paths)) as Array<{
      canonical_path: string;
      content: string;
    }>;
    return new Map(rows.map((r) => [r.canonical_path, r.content]));
  }

  getPathIndex(): Map<string, string> {
    if (this.pathIndexCache) return this.pathIndexCache;
    const pathIndex = new Map<string, string>();
    for (const path of this.listCanonicalPaths()) {
      const stem = path.replace(/\.md$/, "").split("/").pop() ?? "";
      if (stem && !pathIndex.has(stem)) {
        pathIndex.set(stem, path);
      }
      pathIndex.set(path.replace(/\.md$/, ""), path);
      pathIndex.set(path, path);
    }
    this.pathIndexCache = pathIndex;
    return pathIndex;
  }

  searchHybrid(
    ftsQuery: string,
    queryEmbedding: Float32Array,
    embeddingStore: EmbeddingStore,
    alpha: number,
    limit: number,
    folder?: string,
    acl?: { allowPaths: string[]; denyPaths: string[] },
    candidateMultiplier = 2,
  ): SearchResult[] {
    const candidateLimit = limit * candidateMultiplier;
    // Get FTS results — ACL conditions applied in SQL so LIMIT is taken from allowed rows only
    const ftsResults = this.searchFTS(ftsQuery, candidateLimit, folder, undefined, acl);

    let pathFilter: ((path: string) => boolean) | undefined;
    if (folder) {
      const prefix = folder.endsWith("/") ? folder : `${folder}/`;
      pathFilter = (path) => path.startsWith(prefix);
    }
    if (acl && (acl.allowPaths.length > 0 || acl.denyPaths.length > 0)) {
      const previousFilter = pathFilter;
      pathFilter = (path) => (!previousFilter || previousFilter(path)) && isAclAllowed(path, acl);
    }

    const vectorResults = embeddingStore.search(queryEmbedding, candidateLimit, pathFilter);

    // If no vector results, fall back to FTS-only
    if (vectorResults.length === 0) {
      return ftsResults.slice(0, limit);
    }

    // If no FTS results, build results from vector search
    if (ftsResults.length === 0) {
      const topVec = vectorResults.slice(0, limit);
      const byPath = this.getBatchByPaths(topVec.map((vr) => vr.path));
      return topVec.map((vr) => {
        const entry = byPath.get(vr.path);
        return {
          path: vr.path,
          name: entry?.fileName ?? vr.path.split("/").pop()?.replace(/\.md$/, "") ?? vr.path,
          score: (1 - alpha) * vr.similarity,
          snippet: entry?.content.slice(0, 200) ?? "",
          frontmatter: entry?.metadata ?? {},
        };
      });
    }

    // Normalize BM25 scores to [0,1]
    const ftsScores = ftsResults.map((r) => r.score);
    const ftsMin = Math.min(...ftsScores);
    const ftsMax = Math.max(...ftsScores);
    const ftsRange = ftsMax - ftsMin;

    // Build score maps
    const ftsMap = new Map<string, { normalized: number; result: SearchResult }>();
    for (const r of ftsResults) {
      // When all FTS scores are equal (including single result), assign 1.0
      const normalized = ftsRange === 0 ? 1.0 : (r.score - ftsMin) / ftsRange;
      ftsMap.set(r.path, { normalized, result: r });
    }

    const vectorMap = new Map<string, number>();
    for (const vr of vectorResults) {
      vectorMap.set(vr.path, vr.similarity);
    }

    // Collect all unique paths
    const allPaths = new Set([...ftsMap.keys(), ...vectorMap.keys()]);

    // Fuse scores
    const fused: Array<{ path: string; score: number; ftsResult?: SearchResult }> = [];
    for (const p of allPaths) {
      const bm25Norm = ftsMap.get(p)?.normalized ?? 0;
      const cosineSim = vectorMap.get(p) ?? 0;
      const fusedScore = alpha * bm25Norm + (1 - alpha) * cosineSim;
      const ftsResultForPath = ftsMap.get(p)?.result;
      fused.push({
        path: p,
        score: fusedScore,
        ...(ftsResultForPath !== undefined ? { ftsResult: ftsResultForPath } : {}),
      });
    }

    fused.sort((a, b) => b.score - a.score);

    const topFused = fused.slice(0, limit);
    const vectorOnlyPaths = topFused.filter((f) => !f.ftsResult).map((f) => f.path);
    const vectorOnlyEntries = this.getBatchByPaths(vectorOnlyPaths);

    return topFused.map((f) => {
      if (f.ftsResult) {
        return { ...f.ftsResult, score: f.score };
      }
      const entry = vectorOnlyEntries.get(f.path);
      return {
        path: f.path,
        name: entry?.fileName ?? f.path.split("/").pop()?.replace(/\.md$/, "") ?? f.path,
        score: f.score,
        snippet: entry?.content.slice(0, 200) ?? "",
        frontmatter: entry?.metadata ?? {},
      };
    });
  }

  countFTS(): number {
    return (this.stmtCountFTS.get() as { n: number }).n;
  }

  close(): void {
    this.db.close();
  }
}

interface DatabaseRow {
  canonical_path: string;
  content: string;
  content_hash: string;
  file_name: string;
  metadata: string;
  created_at: number;
  updated_at: number;
}

function rowToEntry(row: DatabaseRow): VaultEntry {
  return {
    canonicalPath: row.canonical_path,
    content: row.content,
    contentHash: row.content_hash,
    fileName: row.file_name,
    metadata: safeParseMetadata(row.metadata, row.canonical_path),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function safeParseMetadata(raw: string, path: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    logger.warn("store", "malformed metadata JSON, returning empty object", { path });
    return {};
  }
}

function buildAclClauses(
  acl: { allowPaths: string[]; denyPaths: string[] } | undefined,
  col: string,
): { clauses: string; params: (string | number)[] } {
  const parts: string[] = [];
  const params: (string | number)[] = [];

  if (acl?.denyPaths) {
    for (const raw of acl.denyPaths) {
      const p = raw.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
      if (p === "") continue;
      parts.push(`${col} != ? AND substr(${col}, 1, ?) != ?`);
      params.push(p, p.length + 1, `${p}/`);
    }
  }

  if (acl?.allowPaths && acl.allowPaths.length > 0) {
    const normalized = acl.allowPaths
      .map((raw) => raw.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, ""))
      .filter((p) => p !== "");
    if (normalized.length > 0) {
      const clauses = normalized.map(() => `${col} = ? OR substr(${col}, 1, ?) = ?`).join(" OR ");
      parts.push(`(${clauses})`);
      for (const p of normalized) {
        params.push(p, p.length + 1, `${p}/`);
      }
    }
  }

  return { clauses: parts.join(" AND "), params };
}

/** Escape SQL LIKE special characters so user-supplied folder paths are matched literally. */
function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, "\\$&");
}

function backupFileDatabaseInWorker(dbPath: string, destPath: string): Promise<void> {
  const workerUrl = URL.createObjectURL(new Blob([BACKUP_WORKER_SOURCE], { type: "text/javascript" }));
  const worker = new Worker(workerUrl, { type: "module" });

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      worker.terminate();
      URL.revokeObjectURL(workerUrl);
    };

    worker.onmessage = (event: MessageEvent<BackupWorkerResponse>) => {
      cleanup();
      if (event.data.ok) {
        resolve();
        return;
      }
      const err = new Error(event.data.error.message);
      err.name = event.data.error.name;
      if (event.data.error.stack) err.stack = event.data.error.stack;
      reject(err);
    };

    worker.onerror = (event: ErrorEvent) => {
      cleanup();
      reject(event.error instanceof Error ? event.error : new Error(event.message));
    };

    worker.postMessage({ dbPath, destPath });
  });
}

function isMissingSchemaVersionTableError(err: unknown): boolean {
  return err instanceof Error && /no such table: schema_version/i.test(err.message);
}

function sqliteErrorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Sanitize a query string for FTS5 MATCH.
 * Preserves "quoted phrases" as-is for phrase search.
 * Individual terms are quoted to escape FTS5 operators.
 */
export function sanitizeFTS5Query(query: string): string {
  const parts: string[] = [];
  for (const match of query.matchAll(/"([^"]*)"|\S+/g)) {
    if (match[1] !== undefined) {
      // User-provided quoted phrase — pass through as FTS5 phrase
      const escaped = match[1].replace(/"/g, '""');
      if (escaped.length > 0) parts.push(`"${escaped}"`);
    } else {
      // Individual term — quote to escape FTS5 operators
      parts.push(`"${match[0].replace(/"/g, '""')}"`);
    }
  }
  return parts.join(" ");
}
