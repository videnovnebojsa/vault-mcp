import type { Database, Statement } from "bun:sqlite";
import { EMBEDDINGS_MIGRATIONS, runMigrations } from "./migrations.js";

interface EmbeddingRow {
  path: string;
  embedding: Buffer;
  content_hash: string;
  model: string;
  updated_at: number;
}

interface VectorEntry {
  vec: Float32Array;
  norm: number;
}

export class EmbeddingStore {
  private vectors = new Map<string, VectorEntry>();
  private readonly stmtCache = new Map<string, Statement>();
  private stmtUpsert!: Statement;
  private stmtDelete!: Statement;
  private stmtAllPaths!: Statement;
  private stmtStaleCheck!: Statement;
  private stmtLoad!: Statement;
  private initialized = false;

  constructor(private readonly db: Database) {}

  initSchema(): void {
    runMigrations(this.db, EMBEDDINGS_MIGRATIONS, "embeddings_schema_version");
    this.stmtUpsert = this.db.prepare(
      `INSERT OR REPLACE INTO vault_embeddings (path, embedding, content_hash, model, updated_at) VALUES (?, ?, ?, ?, ?)`,
    );
    this.stmtDelete = this.db.prepare("DELETE FROM vault_embeddings WHERE path = ?");
    this.stmtAllPaths = this.db.prepare("SELECT path FROM vault_embeddings");
    this.stmtStaleCheck = this.db.prepare("SELECT path, content_hash, model FROM vault_embeddings");
    this.stmtLoad = this.db.prepare("SELECT path, embedding FROM vault_embeddings");
    this.initialized = true;
  }

  load(): void {
    this.assertInitialized();
    this.vectors.clear();
    const rows = this.stmtLoad.all() as EmbeddingRow[];

    for (const row of rows) {
      const vec = new Float32Array(
        row.embedding.buffer.slice(row.embedding.byteOffset, row.embedding.byteOffset + row.embedding.byteLength),
      );
      this.vectors.set(row.path, { vec, norm: computeNorm(vec) });
    }
  }

  get size(): number {
    return this.vectors.size;
  }

  upsert(path: string, embedding: Float32Array, contentHash: string, model: string): void {
    this.assertInitialized();
    const buf = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
    this.stmtUpsert.run(path, buf, contentHash, model, Date.now());
    this.vectors.set(path, { vec: embedding, norm: computeNorm(embedding) });
  }

  getEmbedding(path: string): Float32Array | undefined {
    return this.vectors.get(path)?.vec;
  }

  getPaths(): string[] {
    return [...this.vectors.keys()];
  }

  delete(path: string): void {
    this.assertInitialized();
    this.stmtDelete.run(path);
    this.vectors.delete(path);
  }

  search(
    queryEmbedding: Float32Array,
    limit: number,
    pathFilter?: (path: string) => boolean,
  ): Array<{ path: string; similarity: number }> {
    this.assertInitialized();
    if (limit <= 0) return [];
    const queryNorm = computeNorm(queryEmbedding);
    if (queryNorm === 0) return [];

    const results: Array<{ path: string; similarity: number }> = [];

    for (const [path, entry] of this.vectors) {
      if (pathFilter && !pathFilter(path)) continue;
      if (entry.norm === 0) continue;
      const dot = dotProduct(queryEmbedding, entry.vec);
      const similarity = dot / (queryNorm * entry.norm);
      insertTopResult(results, { path, similarity }, limit);
    }

    return results.sort((a, b) => b.similarity - a.similarity);
  }

  getStaleOrMissing(currentEntries: Map<string, string>, currentModel?: string): string[] {
    this.assertInitialized();
    const rows = this.stmtStaleCheck.all() as Array<{
      path: string;
      content_hash: string;
      model: string;
    }>;

    const embeddedInfo = new Map<string, { hash: string; model: string }>();
    for (const row of rows) {
      embeddedInfo.set(row.path, { hash: row.content_hash, model: row.model });
    }

    const stale: string[] = [];
    for (const [path, contentHash] of currentEntries) {
      const existing = embeddedInfo.get(path);
      if (!existing || existing.hash !== contentHash) {
        stale.push(path);
      } else if (currentModel && existing.model !== currentModel) {
        // Model changed — embeddings are incompatible
        stale.push(path);
      }
    }

    return stale;
  }

  getStaleOrMissingPage(
    limit: number,
    currentModel?: string,
    excludePaths: string[] = [],
  ): Array<{ path: string; contentHash: string }> {
    return this.getStaleOrMissingPageWithTotal(limit, currentModel, excludePaths).rows;
  }

  getStaleOrMissingPageWithTotal(
    limit: number,
    currentModel?: string,
    excludePaths: string[] = [],
  ): { rows: Array<{ path: string; contentHash: string }>; total: number } {
    this.assertInitialized();
    const { clause, params } = buildExcludeClause(excludePaths);
    const modelClause = currentModel ? " OR e.model != ?" : "";
    const sql = `SELECT v.canonical_path AS path, v.content_hash AS contentHash, COUNT(*) OVER() AS totalCount
      FROM vault_entries v
      LEFT JOIN vault_embeddings e ON e.path = v.canonical_path
      WHERE (e.path IS NULL OR e.content_hash != v.content_hash${modelClause})${clause}
      ORDER BY v.canonical_path
      LIMIT ?`;
    const modelParams = currentModel ? [currentModel] : [];
    const rows = this.cachedPrepare(sql).all(...modelParams, ...params, limit) as Array<{
      path: string;
      contentHash: string;
      totalCount: number;
    }>;
    return {
      rows: rows.map(({ path, contentHash }) => ({ path, contentHash })),
      total: rows[0]?.totalCount ?? 0,
    };
  }

  countStaleOrMissing(currentModel?: string, excludePaths: string[] = []): number {
    this.assertInitialized();
    const { clause, params } = buildExcludeClause(excludePaths);
    const modelClause = currentModel ? " OR e.model != ?" : "";
    const sql = `SELECT COUNT(*) AS count
      FROM vault_entries v
      LEFT JOIN vault_embeddings e ON e.path = v.canonical_path
      WHERE (e.path IS NULL OR e.content_hash != v.content_hash${modelClause})${clause}`;
    const modelParams = currentModel ? [currentModel] : [];
    return (this.cachedPrepare(sql).get(...modelParams, ...params) as { count: number }).count;
  }

  /**
   * Remove embeddings for paths that no longer exist in the vault.
   * Returns the number of orphaned entries deleted.
   */
  deleteOrphans(currentPaths: Set<string>): number {
    this.assertInitialized();
    const rows = this.stmtAllPaths.all() as Array<{ path: string }>;
    const orphans = rows.filter((r) => !currentPaths.has(r.path)).map((r) => r.path);
    if (orphans.length === 0) return 0;
    this.db
      .prepare("DELETE FROM vault_embeddings WHERE path IN (SELECT value FROM json_each(?))")
      .run(JSON.stringify(orphans));
    for (const p of orphans) this.vectors.delete(p);
    return orphans.length;
  }

  deleteOrphansFromVaultEntries(): number {
    this.assertInitialized();
    const rows = this.db
      .prepare(
        `SELECT e.path
         FROM vault_embeddings e
         LEFT JOIN vault_entries v ON v.canonical_path = e.path
         WHERE v.canonical_path IS NULL`,
      )
      .all() as Array<{ path: string }>;

    const paths = rows.map((row) => row.path);
    if (paths.length === 0) return 0;
    this.db
      .prepare("DELETE FROM vault_embeddings WHERE path IN (SELECT value FROM json_each(?))")
      .run(JSON.stringify(paths));
    for (const path of paths) this.vectors.delete(path);
    return rows.length;
  }

  private cachedPrepare(sql: string): Statement {
    let stmt = this.stmtCache.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.stmtCache.set(sql, stmt);
    }
    return stmt;
  }

  private assertInitialized(): void {
    if (!this.initialized) {
      throw new Error("EmbeddingStore is not initialized. Call initSchema() before using the embedding store.");
    }
  }
}

function insertTopResult(
  results: Array<{ path: string; similarity: number }>,
  candidate: { path: string; similarity: number },
  limit: number,
): void {
  if (results.length < limit) {
    heapPush(results, candidate);
    return;
  }
  if (candidate.similarity <= (results[0]?.similarity ?? -Infinity)) return;
  heapReplaceRoot(results, candidate);
}

function heapPush(heap: Array<{ path: string; similarity: number }>, item: { path: string; similarity: number }): void {
  heap.push(item);
  siftUp(heap, heap.length - 1);
}

function heapReplaceRoot(
  heap: Array<{ path: string; similarity: number }>,
  item: { path: string; similarity: number },
): void {
  heap[0] = item;
  siftDown(heap, 0);
}

function siftUp(heap: Array<{ path: string; similarity: number }>, index: number): void {
  let child = index;
  while (child > 0) {
    const parent = Math.floor((child - 1) / 2);
    if ((heap[parent]?.similarity ?? -Infinity) <= (heap[child]?.similarity ?? -Infinity)) return;
    swapHeapItems(heap, parent, child);
    child = parent;
  }
}

function siftDown(heap: Array<{ path: string; similarity: number }>, index: number): void {
  let parent = index;
  while (true) {
    const left = parent * 2 + 1;
    const right = left + 1;
    let smallest = parent;

    if ((heap[left]?.similarity ?? Infinity) < (heap[smallest]?.similarity ?? Infinity)) {
      smallest = left;
    }
    if ((heap[right]?.similarity ?? Infinity) < (heap[smallest]?.similarity ?? Infinity)) {
      smallest = right;
    }
    if (smallest === parent) return;
    swapHeapItems(heap, parent, smallest);
    parent = smallest;
  }
}

function swapHeapItems(heap: Array<{ path: string; similarity: number }>, a: number, b: number): void {
  const itemA = heap[a];
  const itemB = heap[b];
  if (!itemA || !itemB) return;
  heap[a] = itemB;
  heap[b] = itemA;
}

function buildExcludeClause(excludePaths: string[]): { clause: string; params: string[] } {
  if (excludePaths.length === 0) return { clause: "", params: [] };
  return {
    clause: " AND v.canonical_path NOT IN (SELECT value FROM json_each(?))",
    params: [JSON.stringify(excludePaths)],
  };
}

function computeNorm(vec: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) {
    sum += (vec[i] ?? 0) * (vec[i] ?? 0);
  }
  return Math.sqrt(sum);
}

function dotProduct(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    sum += (a[i] ?? 0) * (b[i] ?? 0);
  }
  return sum;
}
