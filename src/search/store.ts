import Database from "better-sqlite3";
import { logger } from "../utils/logger.js";
import type { EmbeddingStore } from "./embeddings.js";
import type { SearchResult, VaultEntry } from "./types.js";

const CURRENT_SCHEMA_VERSION = 1;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS schema_version (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL
  );

  INSERT OR IGNORE INTO schema_version (id, version) VALUES (1, ${CURRENT_SCHEMA_VERSION});

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

export class VaultSearchStore {
  private db: Database.Database;
  private readonly stmtGetByPath: Database.Statement;
  private readonly stmtUpsertEntry: Database.Statement;
  private readonly stmtDeleteEntry: Database.Statement;
  private readonly stmtDeleteFts: Database.Statement;
  private readonly stmtInsertFts: Database.Statement;
  private readonly stmtCountFTS: Database.Statement;
  private readonly stmtGetContentHashMap: Database.Statement;
  private readonly stmtGetContentByPath: Database.Statement;
  /** Lazy cache for dynamic-SQL statements (key = SQL string). */
  private readonly stmtCache = new Map<string, Database.Statement>();

  constructor(dbPath: string = ":memory:") {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);

    this.stmtGetByPath = this.db.prepare("SELECT * FROM vault_entries WHERE canonical_path = ?");
    this.stmtUpsertEntry = this.db.prepare(
      `INSERT OR REPLACE INTO vault_entries (canonical_path, content, content_hash, file_name, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.stmtDeleteEntry = this.db.prepare("DELETE FROM vault_entries WHERE canonical_path = ?");
    this.stmtDeleteFts = this.db.prepare("DELETE FROM vault_fts WHERE canonical_path = ?");
    this.stmtInsertFts = this.db.prepare("INSERT INTO vault_fts (content, file_name, canonical_path) VALUES (?, ?, ?)");
    this.stmtCountFTS = this.db.prepare("SELECT COUNT(*) as n FROM vault_fts");
    this.stmtGetContentHashMap = this.db.prepare("SELECT canonical_path, content_hash FROM vault_entries");
    this.stmtGetContentByPath = this.db.prepare("SELECT content FROM vault_entries WHERE canonical_path = ?");
  }

  private cachedPrepare(sql: string): Database.Statement {
    let stmt = this.stmtCache.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.stmtCache.set(sql, stmt);
    }
    return stmt;
  }

  /** Expose the underlying database for shared use (e.g. EmbeddingStore). */
  getDatabase(): Database.Database {
    return this.db;
  }

  getSchemaVersion(): number {
    try {
      const row = this.db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as
        | { version: number }
        | undefined;
      return row?.version ?? 0;
    } catch {
      return 0;
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

    this.db.transaction(() => {
      this.stmtUpsertEntry.run(
        canonicalPath,
        content,
        contentHash,
        fileName,
        JSON.stringify(metadata),
        createdAt,
        updatedAt,
      );
      this.stmtDeleteFts.run(canonicalPath);
      this.stmtInsertFts.run(content, fileName, canonicalPath);
    })();

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
    const { clauses, params } = buildAclClauses(acl, "canonical_path");
    const where = clauses ? `AND ${clauses}` : "";
    const sql = `SELECT json_each.value AS tag, COUNT(*) AS count
         FROM vault_entries, json_each(json_extract(metadata, '$.tags'))
         WHERE json_extract(metadata, '$.tags') IS NOT NULL ${where}
         GROUP BY tag
         ORDER BY count DESC`;
    return this.cachedPrepare(sql).all(...params) as Array<{ tag: string; count: number }>;
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
    const placeholders = paths.map(() => "?").join(",");
    const sql = `SELECT * FROM vault_entries WHERE canonical_path IN (${placeholders})`;
    const rows = this.cachedPrepare(sql).all(...paths) as DatabaseRow[];
    return new Map(rows.map((r) => [r.canonical_path, rowToEntry(r)]));
  }

  deleteByPath(canonicalPath: string): boolean {
    let deleted = false;
    this.db.transaction(() => {
      const result = this.stmtDeleteEntry.run(canonicalPath);
      this.stmtDeleteFts.run(canonicalPath);
      deleted = result.changes > 0;
    })();
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

  searchHybrid(
    ftsQuery: string,
    queryEmbedding: Float32Array,
    embeddingStore: EmbeddingStore,
    alpha: number,
    limit: number,
    folder?: string,
    acl?: { allowPaths: string[]; denyPaths: string[] },
  ): SearchResult[] {
    // Get FTS results — ACL conditions applied in SQL so LIMIT is taken from allowed rows only
    const ftsResults = this.searchFTS(ftsQuery, limit * 2, folder, undefined, acl);

    // Get vector results — use full pool when ACL is active so lower-ranked allowed paths are reachable
    const vectorCandidateCount =
      acl && (acl.allowPaths.length > 0 || acl.denyPaths.length > 0) ? embeddingStore.size : limit * 2;
    let vectorResults = embeddingStore.search(queryEmbedding, vectorCandidateCount);

    // Apply folder filter to vector results if specified
    if (folder) {
      const prefix = folder.endsWith("/") ? folder : `${folder}/`;
      vectorResults = vectorResults.filter((r) => r.path.startsWith(prefix));
    }

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
    if (normalized.length === acl.allowPaths.length) {
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
