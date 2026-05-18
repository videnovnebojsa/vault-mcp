import { applyAclFilter, applyMetadataFilters } from "../../search/utils.js";
import { VaultError, VaultErrorCode } from "../../utils/errors.js";
import type { VaultServices } from "../../vault/manager.js";
import { isAclAllowed } from "../../vault/path-safety.js";
import { errorResult, listResult, type ToolResult } from "../format.js";

export const DEFAULT_QUERY_EMBEDDING_CACHE_MAX = 128;
export const DEFAULT_QUERY_EMBEDDING_CACHE_TTL_MS = 300_000;
const queryEmbeddingCache = new Map<string, { embedding: Float32Array; expiresAt: number }>();

export function resetQueryEmbeddingCache(): void {
  queryEmbeddingCache.clear();
}

export interface VaultSearchArgs {
  query: string;
  limit?: number | undefined;
  offset?: number | undefined;
  folder?: string | undefined;
  mode?: "keyword" | "semantic" | "hybrid" | undefined;
  tags?: string[] | undefined;
  type?: string | undefined;
  modified_after?: string | undefined;
  created_after?: string | undefined;
  vault?: string | undefined;
}

export async function handleVaultSearch(args: VaultSearchArgs, services: VaultServices): Promise<ToolResult> {
  const { vault, searchStore, embeddingStore, embedProvider, embeddingConfig, aclConfig } = services;
  const effectiveLimit = args.limit ?? 20;
  const offset = args.offset ?? 0;
  const embeddingsAvailable = embeddingStore && embedProvider && embeddingConfig?.enabled;

  if (args.mode && (args.mode === "semantic" || args.mode === "hybrid") && !embeddingsAvailable) {
    return errorResult(
      VaultErrorCode.MODE_UNAVAILABLE,
      `Search mode "${args.mode}" requires embeddings. ` +
        'Set ENABLE_EMBEDDINGS=true and EMBEDDING_API_KEY, or use mode="keyword".',
    );
  }

  const effectiveMode = args.mode ?? (embeddingsAvailable ? "hybrid" : "keyword");

  const modifiedAfterMs = (() => {
    if (!args.modified_after) return undefined;
    const t = new Date(args.modified_after).getTime();
    return Number.isNaN(t) ? undefined : t;
  })();
  const createdAfterMs = (() => {
    if (!args.created_after) return undefined;
    const t = new Date(args.created_after).getTime();
    return Number.isNaN(t) ? undefined : t;
  })();
  const filters =
    args.tags || args.type || modifiedAfterMs !== undefined || createdAfterMs !== undefined
      ? {
          ...(args.tags !== undefined ? { tags: args.tags } : {}),
          ...(args.type !== undefined ? { type: args.type } : {}),
          ...(modifiedAfterMs !== undefined ? { modifiedAfter: modifiedAfterMs } : {}),
          ...(createdAfterMs !== undefined ? { createdAfter: createdAfterMs } : {}),
        }
      : undefined;

  const aclActive = aclConfig.allowPaths.length > 0 || aclConfig.denyPaths.length > 0;
  const pageLimit = offset + effectiveLimit + 1;
  const candidateLimit = Math.max(pageLimit, effectiveLimit * 10, 100) + 1;
  const toSearchPage = <T>(results: T[]) => {
    const page = results.slice(offset, offset + effectiveLimit);
    return listResult(page, { kind: "knownTotal", total: results.length, offset, limit: effectiveLimit });
  };
  const nextCandidateLimit = (current: number, totalSize?: number) =>
    totalSize !== undefined ? Math.min(totalSize, Math.max(current + 1, current * 2)) : current * 2;

  if (effectiveMode === "keyword" || !searchStore) {
    if (searchStore) {
      const results = collectExactResults(pageLimit, (limit) =>
        searchStore.searchFTS(args.query, limit, args.folder, filters, aclConfig),
      );
      return toSearchPage(results);
    }
    const results = await collectExactResultsAsync(pageLimit, async (limit) => {
      const raw = await vault.searchByPathOrName(args.query, {
        limit,
        ...(args.folder !== undefined ? { folder: args.folder } : {}),
      });
      return applyMetadataFilters(raw, filters);
    });
    return toSearchPage(results);
  }

  if (effectiveMode === "semantic" && embeddingsAvailable) {
    const queryEmbed = await getQueryEmbedding(
      embedProvider,
      args.query,
      args.vault ?? "default",
      embeddingConfig.queryCacheMax,
    );
    if (!queryEmbed) throw new VaultError("Embedding returned no results", VaultErrorCode.EXTERNAL_API);
    const semanticPathFilter = buildSemanticPathFilter(args.folder, aclConfig, aclActive);
    let searchLimit = candidateLimit;
    while (true) {
      const vectorResults = semanticPathFilter
        ? embeddingStore.search(queryEmbed, searchLimit, semanticPathFilter)
        : embeddingStore.search(queryEmbed, searchLimit);
      if (!filters) {
        const pageVectors = vectorResults.slice(offset, offset + effectiveLimit);
        const entries = searchStore.getBatchByPaths(pageVectors.map((vr) => vr.path));
        const mappedPage = pageVectors.map((vr) => {
          const entry = entries.get(vr.path);
          return {
            path: vr.path,
            name: entry?.fileName ?? vr.path.split("/").pop()?.replace(/\.md$/, "") ?? vr.path,
            score: vr.similarity,
            snippet: entry?.content.slice(0, 200) ?? "",
            frontmatter: entry?.metadata ?? {},
            updatedAt: entry?.updatedAt,
            createdAt: entry?.createdAt,
          };
        });
        if (vectorResults.length < searchLimit || searchLimit >= embeddingStore.size) {
          return listResult(applyAclFilter(mappedPage, aclConfig, aclActive), {
            kind: "knownTotal",
            total: vectorResults.length,
            offset,
            limit: effectiveLimit,
          });
        }
        searchLimit = nextCandidateLimit(searchLimit, embeddingStore.size);
        continue;
      }
      const entries = searchStore.getBatchByPaths(vectorResults.map((vr) => vr.path));
      const mappedResults = vectorResults.map((vr) => {
        const entry = entries.get(vr.path);
        return {
          path: vr.path,
          name: entry?.fileName ?? vr.path.split("/").pop()?.replace(/\.md$/, "") ?? vr.path,
          score: vr.similarity,
          snippet: entry?.content.slice(0, 200) ?? "",
          frontmatter: entry?.metadata ?? {},
          updatedAt: entry?.updatedAt,
          createdAt: entry?.createdAt,
        };
      });
      const results = applyAclFilter(applyMetadataFilters(mappedResults, filters), aclConfig, aclActive);
      if (vectorResults.length < searchLimit || searchLimit >= embeddingStore.size) {
        return toSearchPage(results);
      }
      const expandedLimit = nextCandidateLimit(searchLimit, embeddingStore.size);
      if (expandedLimit <= searchLimit) return toSearchPage(results);
      searchLimit = expandedLimit;
    }
  }

  if (effectiveMode === "hybrid" && embeddingsAvailable) {
    const queryEmbed = await getQueryEmbedding(
      embedProvider,
      args.query,
      args.vault ?? "default",
      embeddingConfig.queryCacheMax,
    );
    if (!queryEmbed) throw new VaultError("Embedding returned no results", VaultErrorCode.EXTERNAL_API);
    const alpha = embeddingConfig.hybridAlpha;
    let searchLimit = candidateLimit;
    while (true) {
      const hybridRaw = searchStore.searchHybrid(
        args.query,
        queryEmbed,
        embeddingStore,
        alpha,
        searchLimit,
        args.folder,
        aclConfig,
      );
      if (!filters) {
        if (hybridRaw.length < searchLimit || searchLimit >= embeddingStore.size) {
          return toSearchPage(hybridRaw);
        }
        searchLimit = nextCandidateLimit(searchLimit, embeddingStore.size);
        continue;
      }
      const entries = searchStore.getBatchByPaths(hybridRaw.map((r) => r.path));
      const hybridWithDates = hybridRaw.map((r) => {
        const entry = entries.get(r.path);
        return { ...r, updatedAt: entry?.updatedAt, createdAt: entry?.createdAt };
      });
      const results = applyAclFilter(applyMetadataFilters(hybridWithDates, filters), aclConfig, aclActive);
      if (hybridRaw.length < searchLimit || searchLimit >= embeddingStore.size) {
        return toSearchPage(results);
      }
      const expandedLimit = nextCandidateLimit(searchLimit, embeddingStore.size);
      if (expandedLimit <= searchLimit) return toSearchPage(results);
      searchLimit = expandedLimit;
    }
  }

  const results = searchStore.searchFTS(args.query, pageLimit, args.folder, filters, aclConfig);
  return toSearchPage(results);
}

function collectExactResults<T>(initialLimit: number, fetch: (limit: number) => T[]): T[] {
  let limit = initialLimit;
  while (true) {
    const results = fetch(limit);
    if (results.length < limit) return results;
    limit = nextLimit(limit);
  }
}

async function collectExactResultsAsync<T>(initialLimit: number, fetch: (limit: number) => Promise<T[]>): Promise<T[]> {
  let limit = initialLimit;
  while (true) {
    const results = await fetch(limit);
    if (results.length < limit) return results;
    limit = nextLimit(limit);
  }
}

function nextLimit(current: number): number {
  return Math.max(current + 1, current * 2);
}

function buildSemanticPathFilter(
  folder: string | undefined,
  aclConfig: { allowPaths: string[]; denyPaths: string[] },
  aclActive: boolean,
): ((path: string) => boolean) | undefined {
  if (!folder && !aclActive) return undefined;
  const normalizedFolder = folder ? normalizeSemanticFolder(folder) : undefined;
  const prefix = normalizedFolder ? `${normalizedFolder}/` : undefined;
  return (path: string) => {
    if (prefix && !path.startsWith(prefix)) return false;
    if (aclActive && !isAclAllowed(path, aclConfig)) return false;
    return true;
  };
}

function normalizeSemanticFolder(folder: string): string {
  const slashNormalized = folder.replace(/\\/g, "/");
  if (slashNormalized.startsWith("/")) {
    throw new VaultError("folder must be vault-relative", VaultErrorCode.VALIDATION);
  }
  const parts = slashNormalized.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.includes("..")) {
    throw new VaultError('folder must not contain ".."', VaultErrorCode.VALIDATION);
  }
  return parts.join("/");
}

async function getQueryEmbedding(
  embedProvider: { embed(texts: string[]): Promise<Float32Array[]>; readonly modelName: string },
  query: string,
  vaultName: string,
  cacheMax = DEFAULT_QUERY_EMBEDDING_CACHE_MAX,
): Promise<Float32Array | undefined> {
  const cacheKey = [vaultName, embedProvider.modelName, query].map(encodeURIComponent).join("|");
  const now = Date.now();
  const cached = queryEmbeddingCache.get(cacheKey);
  if (cached) {
    if (cached.expiresAt > now) return cached.embedding;
    queryEmbeddingCache.delete(cacheKey);
  }

  const results = await embedProvider.embed([query]);
  const embedding = results[0];
  if (!embedding) return undefined;
  if (cacheMax <= 0) return embedding;
  queryEmbeddingCache.set(cacheKey, { embedding, expiresAt: now + DEFAULT_QUERY_EMBEDDING_CACHE_TTL_MS });
  if (queryEmbeddingCache.size > cacheMax) {
    const oldest = queryEmbeddingCache.keys().next().value;
    if (oldest !== undefined) queryEmbeddingCache.delete(oldest);
  }
  return embedding;
}
