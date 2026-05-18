import path from "node:path";
import { VaultErrorCode } from "../../utils/errors.js";
import { logger } from "../../utils/logger.js";
import type { VaultServices } from "../../vault/manager.js";
import { extractWikilinks } from "../../vault/markdown.js";
import { successResult, type ToolResult } from "../format.js";

type LinkCandidate = {
  path: string;
  name: string;
};

function makeLimiter(concurrency: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return function limit<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const run = () => {
        active++;
        fn()
          .then(resolve, reject)
          .finally(() => {
            active--;
            queue.shift()?.();
          });
      };
      if (active < concurrency) run();
      else queue.push(run);
    });
  };
}

export async function handleVaultReadNoteWithLinks(
  args: {
    path: string;
    max_links?: number | undefined;
    include_content?: boolean | undefined;
    snippet_length?: number | undefined;
    vault?: string | undefined;
  },
  services: VaultServices,
): Promise<ToolResult> {
  const maxLinks = args.max_links;
  const includeContent = args.include_content;
  const snippetLen = args.snippet_length;
  const { vault, searchStore } = services;
  const note = await vault.readNote(args.path);
  const links = extractWikilinks(note.content).slice(0, maxLinks);

  const limit = makeLimiter(5);
  const fallbackLimit = makeLimiter(2);

  const linkedNotes = await Promise.all(
    links.map((link) =>
      limit(async () => {
        try {
          const linked = await vault.readNote(link);
          return includeContent
            ? { path: linked.path, name: linked.name, content: linked.content, frontmatter: linked.frontmatter }
            : {
                path: linked.path,
                name: linked.name,
                frontmatter: linked.frontmatter,
                snippet: linked.content.slice(0, snippetLen),
              };
        } catch (directErr) {
          const directErrMsg = directErr instanceof Error ? directErr.message : String(directErr);
          logger.debug(
            "note-with-links",
            "vault_read_note_with_links: direct read failed, attempting basename fallback",
            {
              link,
              directErr: directErrMsg,
            },
          );
          // Fall back to basename search for Obsidian-style [[Note Title]] links
          try {
            const matches = await fallbackLimit(async (): Promise<LinkCandidate[]> => {
              const basename = path.basename(link);
              return searchStore
                ? searchStore.searchFTS(basename, 2).map((match) => ({ path: match.path, name: match.name }))
                : vault.searchByPathOrName(basename, { limit: 2 });
            });
            const exact = matches.find((m) => m.name.replace(/\.md$/, "") === path.basename(link));
            const candidate = exact ?? (matches.length === 1 ? matches[0] : undefined);
            if (candidate) {
              const linked = await vault.readNote(candidate.path);
              return includeContent
                ? { path: linked.path, name: linked.name, content: linked.content, frontmatter: linked.frontmatter }
                : {
                    path: linked.path,
                    name: linked.name,
                    frontmatter: linked.frontmatter,
                    snippet: linked.content.slice(0, snippetLen),
                  };
            }
          } catch (fallbackErr) {
            logger.warn("note-with-links", "vault_read_note_with_links: failed to resolve wikilink", {
              link,
              directErr: {
                message: directErrMsg,
                stack: directErr instanceof Error ? directErr.stack : undefined,
              },
              fallbackErr: {
                message: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
                stack: fallbackErr instanceof Error ? fallbackErr.stack : undefined,
              },
            });
          }
          return { path: path.basename(link), error: { code: VaultErrorCode.NOT_FOUND, message: "Note not found" } };
        }
      }),
    ),
  );

  // primary note always returns full content regardless of include_content — use vault_read_section for large notes
  return successResult({
    note: { path: note.path, name: note.name, content: note.content, frontmatter: note.frontmatter },
    linked_notes: linkedNotes,
  });
}
