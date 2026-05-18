import { isAclAllowed } from "../vault/path-safety.js";

export function applyAclFilter<T extends { path: string }>(
  results: T[],
  aclConfig: { allowPaths: string[]; denyPaths: string[] },
  aclActive: boolean,
): T[] {
  if (!aclActive) return results;
  return results.filter((r) => isAclAllowed(r.path, aclConfig));
}

export function applyMetadataFilters<
  T extends {
    frontmatter: Record<string, unknown>;
    updatedAt?: number | undefined;
    createdAt?: number | undefined;
  },
>(
  results: T[],
  filters:
    | {
        tags?: string[];
        type?: string | undefined;
        modifiedAfter?: number | undefined;
        createdAfter?: number | undefined;
      }
    | undefined,
): T[] {
  if (!filters) return results;
  let filtered = results;
  if (filters.tags && filters.tags.length > 0) {
    filtered = filtered.filter((r) => {
      const noteTags = r.frontmatter["tags"];
      return Array.isArray(noteTags) && filters.tags?.some((t) => (noteTags as unknown[]).includes(t));
    });
  }
  if (filters.type) filtered = filtered.filter((r) => r.frontmatter["type"] === filters.type);
  if (filters.modifiedAfter !== undefined) {
    const threshold = filters.modifiedAfter;
    filtered = filtered.filter((r) => r.updatedAt !== undefined && r.updatedAt >= threshold);
  }
  if (filters.createdAfter !== undefined) {
    const threshold = filters.createdAfter;
    filtered = filtered.filter((r) => r.createdAt !== undefined && r.createdAt >= threshold);
  }
  return filtered;
}
