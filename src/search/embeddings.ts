import type Database from "better-sqlite3";

const EMBEDDINGS_SCHEMA_VERSION = 1;

const EMBEDDINGS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS embeddings_schema_version (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL
  );

  INSERT OR IGNORE INTO embeddings_schema_version (id, version) VALUES (1, ${EMBEDDINGS_SCHEMA_VERSION});

  CREATE TABLE IF NOT EXISTS vault_embeddings (
    path TEXT PRIMARY KEY,
    embedding BLOB NOT NULL,
    content_hash TEXT NOT NULL,
    model TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
`;

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
  private stmtUpsert!: Database.Statement;
  private stmtDelete!: Database.Statement;
  private stmtAllPaths!: Database.Statement;
  private stmtStaleCheck!: Database.Statement;
  private stmtLoad!: Database.Statement;

  constructor(private readonly db: Database.Database) {}

  initSchema(): void {
    this.db.exec(EMBEDDINGS_SCHEMA);
    this.stmtUpsert = this.db.prepare(
      `INSERT OR REPLACE INTO vault_embeddings (path, embedding, content_hash, model, updated_at) VALUES (?, ?, ?, ?, ?)`,
    );
    this.stmtDelete = this.db.prepare("DELETE FROM vault_embeddings WHERE path = ?");
    this.stmtAllPaths = this.db.prepare("SELECT path FROM vault_embeddings");
    this.stmtStaleCheck = this.db.prepare("SELECT path, content_hash, model FROM vault_embeddings");
    this.stmtLoad = this.db.prepare("SELECT path, embedding FROM vault_embeddings");
  }

  load(): void {
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
    this.stmtDelete.run(path);
    this.vectors.delete(path);
  }

  search(queryEmbedding: Float32Array, limit: number): Array<{ path: string; similarity: number }> {
    const queryNorm = computeNorm(queryEmbedding);
    if (queryNorm === 0) return [];

    const results: Array<{ path: string; similarity: number }> = [];

    for (const [path, entry] of this.vectors) {
      if (entry.norm === 0) continue;
      const dot = dotProduct(queryEmbedding, entry.vec);
      const similarity = dot / (queryNorm * entry.norm);
      results.push({ path, similarity });
    }

    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, limit);
  }

  getStaleOrMissing(currentEntries: Map<string, string>, currentModel?: string): string[] {
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

  /**
   * Remove embeddings for paths that no longer exist in the vault.
   * Returns the number of orphaned entries deleted.
   */
  deleteOrphans(currentPaths: Set<string>): number {
    const rows = this.stmtAllPaths.all() as Array<{ path: string }>;

    let deleted = 0;
    for (const row of rows) {
      if (!currentPaths.has(row.path)) {
        this.delete(row.path);
        deleted++;
      }
    }
    return deleted;
  }
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
