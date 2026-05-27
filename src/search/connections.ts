/**
 * Cross-reference gap detection — finds semantically similar notes that aren't linked.
 */
import { setImmediate as yieldImmediate } from "node:timers/promises";
import { resolveSkipConnectionPrefixes, VAULT_FOLDERS, type VaultFolders } from "../config/folders.js";
import { extractWikilinks } from "../vault/markdown.js";
import type { EmbedProvider } from "./embed-provider.js";
import type { EmbeddingStore } from "./embeddings.js";
import type { ISearchStore } from "./store.js";

export interface ConnectionSuggestion {
  source: string;
  target: string;
  similarity: number;
}

// Memoize by object reference — the VaultFolders instance is stable within a
// single boot, so we avoid re-allocating the prefixes array and closure on every
// findConnections call.
let _memoSkipFolders: VaultFolders | undefined;
let _memoShouldSkip: ((path: string) => boolean) | undefined;

function buildShouldSkip(folders?: VaultFolders): (path: string) => boolean {
  const effective = folders ?? VAULT_FOLDERS;
  if (effective !== _memoSkipFolders || !_memoShouldSkip) {
    _memoSkipFolders = effective;
    const prefixes = resolveSkipConnectionPrefixes(effective);
    _memoShouldSkip = (path: string) => prefixes.some((prefix) => path.startsWith(prefix));
  }
  return _memoShouldSkip;
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

function getLinkedPaths(content: string, pathIndex: Map<string, string>): Set<string> {
  const links = new Set(extractWikilinks(content));
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
  searchStore: ISearchStore;
  embeddingStore: EmbeddingStore;
  embedProvider: EmbedProvider;
  folders?: VaultFolders;
}): Promise<ConnectionSuggestion[]> {
  const { notePath, limit, minSimilarity, searchStore, embeddingStore, embedProvider, folders } = opts;

  const pathIndex = searchStore.getPathIndex();
  const shouldSkip = buildShouldSkip(folders);

  if (notePath) {
    return findConnectionsForNote(
      notePath,
      limit,
      minSimilarity,
      searchStore,
      embeddingStore,
      embedProvider,
      pathIndex,
      shouldSkip,
    );
  }

  return findConnectionsBatch(limit, minSimilarity, searchStore, embeddingStore, pathIndex, shouldSkip);
}

async function findConnectionsForNote(
  notePath: string,
  limit: number,
  minSimilarity: number,
  searchStore: ISearchStore,
  embeddingStore: EmbeddingStore,
  embedProvider: EmbedProvider,
  pathIndex: Map<string, string>,
  shouldSkip: (path: string) => boolean,
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
  const targetContents = searchStore.getContentBatchByPaths(similar.map((r) => r.path));

  const suggestions: ConnectionSuggestion[] = [];
  for (const result of similar) {
    if (linkedPaths.has(result.path)) continue;
    if (shouldSkip(result.path)) continue;
    if (result.similarity < minSimilarity) continue;

    // Check reverse link
    const targetContent = targetContents.get(result.path);
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

async function findConnectionsBatch(
  limitPerNote: number,
  minSimilarity: number,
  searchStore: ISearchStore,
  embeddingStore: EmbeddingStore,
  pathIndex: Map<string, string>,
  shouldSkip: (path: string) => boolean,
): Promise<ConnectionSuggestion[]> {
  const embeddedPaths = embeddingStore.getPaths().filter((p) => !shouldSkip(p));

  // Cap to avoid huge computation
  const maxNotes = 50;
  const pathsToCheck = embeddedPaths.slice(0, maxNotes);

  // Build link graph
  const linkGraph = new Map<string, Set<string>>();
  const contents = searchStore.getContentBatchByPaths(pathsToCheck);
  for (const p of pathsToCheck) {
    const content = contents.get(p);
    if (!content) continue;
    linkGraph.set(p, getLinkedPaths(content, pathIndex));
  }

  // Find gaps: similar but not linked (in either direction)
  const seen = new Set<string>();
  const allSuggestions: ConnectionSuggestion[] = [];

  for (let sourceIndex = 0; sourceIndex < pathsToCheck.length; sourceIndex++) {
    if (sourceIndex > 0 && sourceIndex % 25 === 0) {
      await yieldImmediate();
    }
    const sourcePath = pathsToCheck[sourceIndex];
    if (!sourcePath) continue;
    const sourceEmbedding = embeddingStore.getEmbedding(sourcePath);
    if (!sourceEmbedding) continue;

    const sourceLinks: Set<string> = linkGraph.get(sourcePath) ?? new Set<string>();

    const similar = embeddingStore.search(sourceEmbedding, limitPerNote * 2);

    for (const result of similar) {
      if (result.path === sourcePath) continue;
      if (sourceLinks.has(result.path)) continue;
      if (shouldSkip(result.path)) continue;
      if (result.similarity < minSimilarity) continue;

      // Check reverse link
      const targetLinks: Set<string> = linkGraph.get(result.path) ?? new Set<string>();
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
