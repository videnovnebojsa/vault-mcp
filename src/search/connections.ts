/**
 * Cross-reference gap detection — finds semantically similar notes that aren't linked.
 */
import type { VaultRepository } from "../vault/repository.js";
import type { EmbedProvider } from "./embed-provider.js";
import type { EmbeddingStore } from "./embeddings.js";
import type { VaultSearchStore } from "./store.js";

export interface ConnectionSuggestion {
  source: string;
  target: string;
  similarity: number;
}

const SKIP_PREFIXES = ["70_AI_Logs/", "50_Templates/", "99_Archive/", "35_Artefacts/", "36_Canvases/"];

function extractWikilinks(content: string): Set<string> {
  const links = new Set<string>();
  for (const match of content.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)) {
    links.add((match[1] ?? "").trim());
  }
  return links;
}

function shouldSkip(path: string): boolean {
  return SKIP_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/**
 * Resolve a wikilink target to a vault path.
 * Wikilinks can be just a note name ("My Note") or a path ("folder/My Note").
 */
function resolveWikilink(target: string, pathIndex: Map<string, string>): string | undefined {
  if (pathIndex.has(`${target}.md`)) return `${target}.md`;
  if (pathIndex.has(target)) return target;
  return pathIndex.get(target);
}

function buildPathIndex(allPaths: Iterable<string>): Map<string, string> {
  const pathIndex = new Map<string, string>();
  for (const path of allPaths) {
    const stem = path.replace(/\.md$/, "").split("/").pop() ?? "";
    if (stem && !pathIndex.has(stem)) {
      pathIndex.set(stem, path);
    }
    // Also index full path without .md
    pathIndex.set(path, path);
  }
  return pathIndex;
}

function getLinkedPaths(content: string, pathIndex: Map<string, string>): Set<string> {
  const links = extractWikilinks(content);
  const resolved = new Set<string>();
  for (const link of links) {
    const r = resolveWikilink(link, pathIndex);
    if (r) resolved.add(r);
  }
  return resolved;
}

export async function findConnections(opts: {
  notePath?: string;
  limit: number;
  minSimilarity: number;
  searchStore: VaultSearchStore;
  embeddingStore: EmbeddingStore;
  embedProvider: EmbedProvider;
  vault: VaultRepository;
}): Promise<ConnectionSuggestion[]> {
  const { notePath, limit, minSimilarity, searchStore, embeddingStore, embedProvider } = opts;

  const allHashes = searchStore.getContentHashMap();
  const allPaths = [...allHashes.keys()];
  const pathIndex = buildPathIndex(allPaths);

  if (notePath) {
    return findConnectionsForNote(
      notePath,
      limit,
      minSimilarity,
      searchStore,
      embeddingStore,
      embedProvider,
      pathIndex,
    );
  }

  return findConnectionsBatch(limit, minSimilarity, searchStore, embeddingStore, pathIndex);
}

async function findConnectionsForNote(
  notePath: string,
  limit: number,
  minSimilarity: number,
  searchStore: VaultSearchStore,
  embeddingStore: EmbeddingStore,
  embedProvider: EmbedProvider,
  pathIndex: Map<string, string>,
): Promise<ConnectionSuggestion[]> {
  const content = searchStore.getContentByPath(notePath);
  if (!content) return [];

  // Get existing links (both directions)
  const linkedPaths = getLinkedPaths(content, pathIndex);
  linkedPaths.add(notePath);

  // Get or compute embedding
  let embedding = embeddingStore.getEmbedding(notePath);
  if (!embedding) {
    const embeddings = await embedProvider.embed([content]);
    if (!embeddings || embeddings.length === 0) return [];
    embedding = embeddings[0];
    if (!embedding) return [];
  }

  const similar = embeddingStore.search(embedding, limit * 3);

  const suggestions: ConnectionSuggestion[] = [];
  for (const result of similar) {
    if (linkedPaths.has(result.path)) continue;
    if (shouldSkip(result.path)) continue;
    if (result.similarity < minSimilarity) continue;

    // Check reverse link
    const targetContent = searchStore.getContentByPath(result.path);
    if (targetContent) {
      const targetLinked = getLinkedPaths(targetContent, pathIndex);
      if (targetLinked.has(notePath)) continue;
    }

    suggestions.push({
      source: notePath,
      target: result.path,
      similarity: result.similarity,
    });

    if (suggestions.length >= limit) break;
  }

  return suggestions;
}

function findConnectionsBatch(
  limitPerNote: number,
  minSimilarity: number,
  searchStore: VaultSearchStore,
  embeddingStore: EmbeddingStore,
  pathIndex: Map<string, string>,
): ConnectionSuggestion[] {
  const embeddedPaths = embeddingStore.getPaths().filter((p) => !shouldSkip(p));

  // Cap to avoid huge computation
  const maxNotes = 200;
  const pathsToCheck = embeddedPaths.slice(0, maxNotes);

  // Build link graph
  const linkGraph = new Map<string, Set<string>>();
  for (const p of pathsToCheck) {
    const content = searchStore.getContentByPath(p);
    if (!content) continue;
    linkGraph.set(p, getLinkedPaths(content, pathIndex));
  }

  // Find gaps: similar but not linked (in either direction)
  const seen = new Set<string>();
  const allSuggestions: ConnectionSuggestion[] = [];

  for (const sourcePath of pathsToCheck) {
    const sourceEmbedding = embeddingStore.getEmbedding(sourcePath);
    if (!sourceEmbedding) continue;

    const sourceLinks = linkGraph.get(sourcePath) ?? new Set();

    const similar = embeddingStore.search(sourceEmbedding, limitPerNote * 2);

    for (const result of similar) {
      if (result.path === sourcePath) continue;
      if (sourceLinks.has(result.path)) continue;
      if (shouldSkip(result.path)) continue;
      if (result.similarity < minSimilarity) continue;

      // Check reverse link
      const targetLinks = linkGraph.get(result.path) ?? new Set();
      if (targetLinks.has(sourcePath)) continue;

      // Deduplicate: A↔B same as B↔A
      const pairKey = [sourcePath, result.path].sort().join("↔");
      if (seen.has(pairKey)) continue;
      seen.add(pairKey);

      allSuggestions.push({
        source: sourcePath,
        target: result.path,
        similarity: result.similarity,
      });
    }
  }

  // Sort by similarity, return top results
  allSuggestions.sort((a, b) => b.similarity - a.similarity);
  return allSuggestions.slice(0, limitPerNote * 10);
}
