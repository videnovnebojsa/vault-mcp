import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { findConnections } from "../search/connections.js";
import { runBackupTask, runEmbedBacklogTask } from "../search/tasks.js";
import { triageInbox } from "../triage/inbox.js";
import { logger } from "../utils/logger.js";
import { beginSpan } from "../utils/span.js";
import { withTimeout } from "../utils/timeout.js";
import type { VaultManager, VaultServices } from "../vault/manager.js";
import { readSection } from "../vault/markdown.js";
import { isAclAllowed } from "../vault/path-safety.js";
import type { Period } from "../vault/periodic.js";
import { openOrCreatePeriodicNote } from "../vault/periodic.js";
import type { VaultFrontmatter } from "../vault/types.js";
import { classify } from "./classify.js";
import { toClientNote } from "./format.js";

export interface RegisterToolsOptions {
  server: McpServer;
  vaultManager: VaultManager;
}

// ── Wikilink helpers ──────────────────────────────────────────────────────────

function extractWikilinks(content: string): string[] {
  const links: string[] = [];
  for (const m of content.matchAll(/\[\[([^\]|#]+?)(?:\|[^\]]+)?\]\]/g)) {
    links.push((m[1] ?? "").trim());
  }
  return [...new Set(links)];
}

// ── Tool registration ─────────────────────────────────────────────────────────

const VAULT_PARAM = z.string().max(100).optional().describe("Vault name (default: primary vault)");

const PATH_PARAM = (desc: string) => z.string().max(500).describe(desc);
const CONTENT_PARAM = (desc: string) => z.string().max(1_000_000).describe(desc);
const QUERY_PARAM = (desc: string) => z.string().max(500).describe(desc);
const FOLDER_PARAM = (desc: string) => z.string().max(500).optional().describe(desc);

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export function registerTools(opts: RegisterToolsOptions): void {
  const { server, vaultManager } = opts;
  const { periodicNotesRoot, backup: backupConfig, toolTimeoutMs: cfgTimeout, classifyRules } = vaultManager.config;
  const toolTimeoutMs = cfgTimeout ?? 30_000;

  /** Wraps a tool handler with per-call telemetry (correlation ID + timing) and a configurable timeout. */
  function wrapHandler<A extends Record<string, unknown>>(
    toolName: string,
    fn: (args: A) => Promise<ToolResult>,
  ): (args: A) => Promise<ToolResult> {
    return async (args: A): Promise<ToolResult> => {
      const vault = typeof args["vault"] === "string" ? args["vault"] : "default";
      const span = beginSpan(toolName, vault);
      try {
        const result = await withTimeout(() => fn(args), toolTimeoutMs);
        const isError = result.isError ?? false;
        const errMsg = isError ? (result.content[0]?.text ?? "tool error") : undefined;
        span.end(isError ? new Error(errMsg) : undefined);
        return result;
      } catch (err) {
        span.end(err);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
            },
          ],
          isError: true,
        };
      }
    };
  }

  async function getSvc(vaultName?: string): Promise<VaultServices> {
    const svc = vaultManager.getServices(vaultName);
    await svc.bootReady.catch(() => {});
    if (svc.bootFailed) {
      throw new Error(`Vault "${vaultName ?? "default"}" failed to initialise — check server logs`);
    }
    return svc;
  }

  // ── vault_read_note ───────────────────────────────────────────────────────
  server.tool(
    "vault_read_note",
    "Read a note from the vault by path. Returns content, frontmatter, and metadata.",
    { path: PATH_PARAM("Vault-relative path to the note (e.g. '00_Inbox/my-note')"), vault: VAULT_PARAM },
    wrapHandler("vault_read_note", async ({ path: notePath, vault: vaultName }) => {
      try {
        const { vault } = await getSvc(vaultName);
        const note = await vault.readNote(notePath);
        return { content: [{ type: "text" as const, text: JSON.stringify(toClientNote(note), null, 2) }] };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
            },
          ],
          isError: true,
        };
      }
    }),
  );

  // ── vault_write_note ──────────────────────────────────────────────────────
  server.tool(
    "vault_write_note",
    "Create or update a note in the vault with optional frontmatter.",
    {
      path: PATH_PARAM("Vault-relative path for the note"),
      content: CONTENT_PARAM("Markdown content of the note"),
      frontmatter: z.record(z.unknown()).optional().describe("Optional YAML frontmatter fields"),
      vault: VAULT_PARAM,
    },
    wrapHandler("vault_write_note", async ({ path: notePath, content, frontmatter, vault: vaultName }) => {
      try {
        const { vault, vaultSync } = await getSvc(vaultName);
        const result = await vault.writeNote(notePath, {
          content,
          ...(frontmatter !== undefined ? { frontmatter: frontmatter as VaultFrontmatter } : {}),
        });
        if (vaultSync && result.path) {
          vaultSync.handleUpsert(result.path).catch((err) =>
            logger.error("tools", "sync index update failed", {
              err: err instanceof Error ? err.message : String(err),
            }),
          );
        }
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
            },
          ],
          isError: true,
        };
      }
    }),
  );

  // ── vault_search ──────────────────────────────────────────────────────────
  server.tool(
    "vault_search",
    "Search notes by content or filename. Supports keyword (FTS5), semantic (vector), and hybrid modes. Optionally filter by tags, type, or date.",
    {
      query: QUERY_PARAM("Search query"),
      limit: z.number().optional().describe("Max results (default 20)"),
      folder: FOLDER_PARAM("Folder to scope search to"),
      mode: z
        .enum(["keyword", "semantic", "hybrid"])
        .optional()
        .describe("Search mode (default: hybrid when embeddings enabled, keyword otherwise)"),
      tags: z.array(z.string().max(100)).optional().describe("Filter to notes with any of these tags"),
      type: z.string().max(100).optional().describe("Filter to notes with this frontmatter type"),
      modified_after: z
        .string()
        .max(50)
        .optional()
        .describe("ISO date string — only return notes modified after this date"),
      created_after: z
        .string()
        .max(50)
        .optional()
        .describe("ISO date string — only return notes created after this date"),
      vault: VAULT_PARAM,
    },
    wrapHandler(
      "vault_search",
      async ({ query, limit, folder, mode, tags, type, modified_after, created_after, vault: vaultName }) => {
        try {
          const { vault, searchStore, embeddingStore, embedProvider, embeddingConfig, aclConfig } =
            await getSvc(vaultName);
          const effectiveLimit = limit ?? 20;
          const embeddingsAvailable = embeddingStore && embedProvider && embeddingConfig?.enabled;
          const effectiveMode = mode ?? (embeddingsAvailable ? "hybrid" : "keyword");
          const modeWarning =
            mode && (mode === "semantic" || mode === "hybrid") && !embeddingsAvailable
              ? `Search mode "${mode}" unavailable (embeddings not configured), fell back to "keyword"`
              : undefined;

          const modifiedAfterMs = (() => {
            if (!modified_after) return undefined;
            const t = new Date(modified_after).getTime();
            return Number.isNaN(t) ? undefined : t;
          })();
          const createdAfterMs = (() => {
            if (!created_after) return undefined;
            const t = new Date(created_after).getTime();
            return Number.isNaN(t) ? undefined : t;
          })();
          const filters =
            tags || type || modifiedAfterMs !== undefined || createdAfterMs !== undefined
              ? {
                  ...(tags !== undefined ? { tags } : {}),
                  ...(type !== undefined ? { type } : {}),
                  ...(modifiedAfterMs !== undefined ? { modifiedAfter: modifiedAfterMs } : {}),
                  ...(createdAfterMs !== undefined ? { createdAfter: createdAfterMs } : {}),
                }
              : undefined;

          const aclActive = aclConfig.allowPaths.length > 0 || aclConfig.denyPaths.length > 0;

          function applyAclFilter<T extends { path: string }>(results: T[]): T[] {
            if (!aclActive) return results;
            return results.filter((r) => isAclAllowed(r.path, aclConfig));
          }

          function applyMetadataFilters<
            T extends {
              frontmatter: Record<string, unknown>;
              updatedAt?: number | undefined;
              createdAt?: number | undefined;
            },
          >(results: T[]): T[] {
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

          if (effectiveMode === "keyword" || !searchStore) {
            if (searchStore) {
              const results = applyAclFilter(searchStore.searchFTS(query, effectiveLimit, folder, filters, aclConfig));
              const payload = modeWarning ? { results, warning: modeWarning } : results;
              return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
            }
            const results = await vault.searchByPathOrName(query, {
              limit: effectiveLimit,
              ...(folder !== undefined ? { folder } : {}),
            });
            const payload = modeWarning ? { results, warning: modeWarning } : results;
            return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
          }

          if (effectiveMode === "semantic" && embeddingsAvailable) {
            const embedResults = await embedProvider.embed([query]);
            const queryEmbed = embedResults[0];
            if (!queryEmbed) throw new Error("Embedding returned no results");
            const candidateCount =
              filters || folder || aclActive ? embeddingStore.size : Math.max(effectiveLimit * 10, 100);
            const vectorResults = embeddingStore.search(queryEmbed, candidateCount);
            let filtered = vectorResults;
            if (folder) {
              const prefix = folder.endsWith("/") ? folder : `${folder}/`;
              filtered = vectorResults.filter((r) => r.path.startsWith(prefix));
            }
            const mappedResults = filtered.map((vr) => {
              const entry = searchStore.getByPath(vr.path);
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
            const results = applyAclFilter(applyMetadataFilters(mappedResults));
            return {
              content: [{ type: "text" as const, text: JSON.stringify(results.slice(0, effectiveLimit), null, 2) }],
            };
          }

          if (effectiveMode === "hybrid" && embeddingsAvailable) {
            const hybridEmbedResults = await embedProvider.embed([query]);
            const queryEmbed = hybridEmbedResults[0];
            if (!queryEmbed) throw new Error("Embedding returned no results");
            const alpha = embeddingConfig.hybridAlpha;
            const hybridRaw = searchStore.searchHybrid(
              query,
              queryEmbed,
              embeddingStore,
              alpha,
              Math.max(effectiveLimit * 10, 100),
              folder,
              aclConfig,
            );
            const hybridWithDates = hybridRaw.map((r) => {
              const entry = searchStore.getByPath(r.path);
              return { ...r, updatedAt: entry?.updatedAt, createdAt: entry?.createdAt };
            });
            const results = applyAclFilter(applyMetadataFilters(hybridWithDates));
            return {
              content: [{ type: "text" as const, text: JSON.stringify(results.slice(0, effectiveLimit), null, 2) }],
            };
          }

          const results = applyAclFilter(searchStore.searchFTS(query, effectiveLimit, folder, filters, aclConfig));
          const payload = modeWarning ? { results, warning: modeWarning } : results;
          return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
        } catch (err) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
              },
            ],
            isError: true,
          };
        }
      },
    ),
  );

  // ── vault_list_tags ───────────────────────────────────────────────────────
  server.tool(
    "vault_list_tags",
    "List all tags in the vault with their note counts, sorted by frequency.",
    { vault: VAULT_PARAM },
    wrapHandler("vault_list_tags", async ({ vault: vaultName }) => {
      try {
        const { searchStore, aclConfig } = await getSvc(vaultName);
        if (!searchStore) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: "Search index not available" }) }],
            isError: true,
          };
        }
        const tags = searchStore.listTags(aclConfig);
        return { content: [{ type: "text" as const, text: JSON.stringify({ tags, total: tags.length }, null, 2) }] };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
            },
          ],
          isError: true,
        };
      }
    }),
  );

  // ── vault_classify ────────────────────────────────────────────────────────
  server.tool(
    "vault_classify",
    "Classify text and suggest a vault folder and title using keyword heuristics.",
    { text: z.string().max(10_000).describe("Text to classify"), vault: VAULT_PARAM },
    wrapHandler("vault_classify", async ({ text, vault: vaultName }) => {
      await getSvc(vaultName); // validates vault exists; throws structured error if unknown
      const result = classify(text, classifyRules);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }),
  );

  // ── vault_list_folder ─────────────────────────────────────────────────────
  server.tool(
    "vault_list_folder",
    "List notes in a vault folder with metadata. Returns lightweight summaries.",
    {
      folder: PATH_PARAM("Vault-relative folder path"),
      recursive: z.boolean().optional().describe("Recurse into subfolders (default true)"),
      limit: z.number().optional().describe("Max results (default 200)"),
      modified_after: z
        .string()
        .optional()
        .describe("ISO 8601 date string — only return notes modified after this date"),
      vault: VAULT_PARAM,
    },
    wrapHandler("vault_list_folder", async ({ folder, recursive, limit, modified_after, vault: vaultName }) => {
      try {
        const { vault, searchStore } = await getSvc(vaultName);
        const modifiedAfterMs = modified_after ? new Date(modified_after).getTime() : undefined;
        const results = await vault.listFolder(folder, {
          ...(recursive !== undefined ? { recursive } : {}),
          ...(limit !== undefined ? { limit } : {}),
          ...(modifiedAfterMs !== undefined && !Number.isNaN(modifiedAfterMs)
            ? { modifiedAfter: modifiedAfterMs }
            : {}),
        });
        if (searchStore) {
          const enriched = results.map((note) => {
            const entry = searchStore.getByPath(note.path);
            if (!entry) return note;
            return {
              ...note,
              tags: entry.metadata?.["tags"],
              type: entry.metadata?.["type"],
              createdAt: entry.createdAt,
            };
          });
          return { content: [{ type: "text" as const, text: JSON.stringify(enriched, null, 2) }] };
        }
        return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
            },
          ],
          isError: true,
        };
      }
    }),
  );

  // ── vault_update_properties ───────────────────────────────────────────────
  server.tool(
    "vault_update_properties",
    "Update frontmatter properties on an existing note. Merges with existing fields.",
    {
      path: PATH_PARAM("Vault-relative path to the note"),
      properties: z.record(z.unknown()).describe("Properties to merge into frontmatter"),
      vault: VAULT_PARAM,
    },
    wrapHandler("vault_update_properties", async ({ path: notePath, properties, vault: vaultName }) => {
      try {
        const { vault, vaultSync } = await getSvc(vaultName);
        const result = await vault.updateProperties(notePath, properties);
        if (vaultSync && result.path) {
          vaultSync.handleUpsert(result.path).catch((err) =>
            logger.error("tools", "sync index update failed", {
              err: err instanceof Error ? err.message : String(err),
            }),
          );
        }
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
            },
          ],
          isError: true,
        };
      }
    }),
  );

  // ── vault_move_note ───────────────────────────────────────────────────────
  server.tool(
    "vault_move_note",
    "Move or rename a note in the vault. Automatically updates all [[wikilinks]] in other notes that reference the old path.",
    {
      from_path: PATH_PARAM("Current vault-relative path of the note"),
      to_path: PATH_PARAM("New vault-relative path for the note"),
      update_backlinks: z.boolean().optional().describe("Update wikilinks in all other notes (default true)"),
      vault: VAULT_PARAM,
    },
    wrapHandler("vault_move_note", async ({ from_path, to_path, update_backlinks = true, vault: vaultName }) => {
      try {
        const { vault, vaultSync, searchStore } = await getSvc(vaultName);
        const result = await vault.moveNote(from_path, to_path);
        if (!result.ok) {
          return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }], isError: true };
        }

        if (vaultSync) {
          await vaultSync
            .handleRename(`${from_path.replace(/\.md$/, "")}.md`, `${to_path.replace(/\.md$/, "")}.md`)
            .catch((err) =>
              logger.error("tools", "sync index update failed", {
                err: err instanceof Error ? err.message : String(err),
              }),
            );
        }

        let backlinksUpdated = 0;
        if (update_backlinks) {
          const { updated, errors } = await vault.updateWikilinks(
            from_path.replace(/\.md$/, ""),
            to_path.replace(/\.md$/, ""),
            searchStore,
          );
          backlinksUpdated = updated;
          if (errors.length > 0) {
            logger.warn("tools", "vault_move_note: some wikilink updates failed", { errors });
          }
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ...result, backlinksUpdated }, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
            },
          ],
          isError: true,
        };
      }
    }),
  );

  // ── vault_delete_note ─────────────────────────────────────────────────────
  server.tool(
    "vault_delete_note",
    "Delete a note from the vault. By default moves to .trash/ folder; set trash=false for permanent delete.",
    {
      path: PATH_PARAM("Vault-relative path of the note to delete"),
      trash: z.boolean().optional().describe("Move to .trash/ instead of permanent delete (default true)"),
      vault: VAULT_PARAM,
    },
    wrapHandler("vault_delete_note", async ({ path: notePath, trash = true, vault: vaultName }) => {
      try {
        const { vault, vaultSync } = await getSvc(vaultName);
        if (trash) {
          const result = await vault.softDeleteNote(notePath);
          if (!result.ok) {
            return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }], isError: true };
          }
          if (vaultSync) vaultSync.handleDelete(result.path);
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ ok: result.ok, path: result.path, message: result.message }, null, 2),
              },
            ],
          };
        }

        const result = await vault.deleteNote(notePath);
        if (vaultSync && result.ok) {
          const canonical = notePath.endsWith(".md") ? notePath : `${notePath}.md`;
          vaultSync.handleDelete(canonical);
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          ...(result.ok ? {} : { isError: true }),
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
            },
          ],
          isError: true,
        };
      }
    }),
  );

  // ── vault_read_section ────────────────────────────────────────────────────
  server.tool(
    "vault_read_section",
    "Read a specific heading section from a note. Returns only the content under that heading, reducing context bloat for large notes.",
    {
      path: PATH_PARAM("Vault-relative path to the note"),
      heading: z.string().max(200).describe("Exact heading text to read (case-insensitive)"),
      vault: VAULT_PARAM,
    },
    wrapHandler("vault_read_section", async ({ path: notePath, heading, vault: vaultName }) => {
      try {
        const { vault } = await getSvc(vaultName);
        const note = await vault.readNote(notePath);
        const section = readSection(note.content, heading);
        if (!section) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ error: `Heading "${heading}" not found in ${notePath}` }),
              },
            ],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ path: notePath, heading, content: section }, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
            },
          ],
          isError: true,
        };
      }
    }),
  );

  // ── vault_get_note_with_links ─────────────────────────────────────────────
  server.tool(
    "vault_get_note_with_links",
    "Read a note and all notes it links to via [[wikilinks]] in a single call. Returns the note plus up to 10 linked notes.",
    {
      path: PATH_PARAM("Vault-relative path to the note"),
      max_links: z.number().optional().describe("Max linked notes to fetch (default 10)"),
      vault: VAULT_PARAM,
    },
    wrapHandler("vault_get_note_with_links", async ({ path: notePath, max_links = 10, vault: vaultName }) => {
      try {
        const { vault } = await getSvc(vaultName);
        const note = await vault.readNote(notePath);
        const links = extractWikilinks(note.content).slice(0, max_links);

        const linkedNotes = await Promise.all(
          links.map(async (link) => {
            try {
              const linked = await vault.readNote(link);
              return { path: linked.path, name: linked.name, content: linked.content, frontmatter: linked.frontmatter };
            } catch {
              // Fall back to basename search for Obsidian-style [[Note Title]] links
              try {
                const matches = await vault.searchByPathOrName(path.basename(link), { limit: 2 });
                const exact = matches.find((m) => m.name.replace(/\.md$/, "") === path.basename(link));
                const candidate = exact ?? (matches.length === 1 ? matches[0] : undefined);
                if (candidate) {
                  const linked = await vault.readNote(candidate.path);
                  return {
                    path: linked.path,
                    name: linked.name,
                    content: linked.content,
                    frontmatter: linked.frontmatter,
                  };
                }
              } catch {
                // ignore
              }
              return { path: link, error: "Note not found" };
            }
          }),
        );

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  note: { path: note.path, name: note.name, content: note.content, frontmatter: note.frontmatter },
                  linked_notes: linkedNotes,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
            },
          ],
          isError: true,
        };
      }
    }),
  );

  // ── vault_capture ─────────────────────────────────────────────────────────
  server.tool(
    "vault_capture",
    "Capture text into the vault. Classifies content and files it into the appropriate folder.",
    { text: z.string().max(100_000).describe("Text to capture"), vault: VAULT_PARAM },
    wrapHandler("vault_capture", async ({ text, vault: vaultName }) => {
      try {
        const { capture, vaultSync } = await getSvc(vaultName);
        if (!capture) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ error: "Capture pipeline is disabled — set ENABLE_CAPTURE_PIPELINE=true" }),
              },
            ],
            isError: true,
          };
        }
        const result = await capture.processCapture(text);
        if (vaultSync && result.ok && result.notePath) {
          vaultSync.handleUpsert(result.notePath).catch((err) =>
            logger.error("tools", "sync index update failed", {
              err: err instanceof Error ? err.message : String(err),
            }),
          );
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          ...(result.ok ? {} : { isError: true }),
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
            },
          ],
          isError: true,
        };
      }
    }),
  );

  // ── vault_sync ────────────────────────────────────────────────────────────
  server.tool(
    "vault_sync",
    "Trigger a full vault sync to rebuild the search index. Returns sync statistics.",
    { vault: VAULT_PARAM },
    wrapHandler("vault_sync", async ({ vault: vaultName }) => {
      try {
        const { vaultSync } = await getSvc(vaultName);
        const result = await vaultSync.runFullSync();
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
            },
          ],
          isError: true,
        };
      }
    }),
  );

  // ── vault_embed_backlog ───────────────────────────────────────────────────
  server.tool(
    "vault_embed_backlog",
    "Batch embed notes with missing or stale embeddings. Requires ENABLE_EMBEDDINGS=true.",
    { vault: VAULT_PARAM },
    wrapHandler("vault_embed_backlog", async ({ vault: vaultName }) => {
      try {
        const { embeddingStore, embedProvider, searchStore, embeddingConfig } = await getSvc(vaultName);
        if (!embeddingStore || !embedProvider || !searchStore || !embeddingConfig?.enabled) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ error: "Embeddings not enabled — set ENABLE_EMBEDDINGS=true" }),
              },
            ],
            isError: true,
          };
        }
        const result = await runEmbedBacklogTask({
          searchStore,
          embeddingStore,
          embedProvider,
          batchSize: embeddingConfig.batchSize,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          ...(result.ok ? {} : { isError: true }),
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
            },
          ],
          isError: true,
        };
      }
    }),
  );

  // ── vault_find_connections ────────────────────────────────────────────────
  server.tool(
    "vault_find_connections",
    "Find notes that are semantically similar but don't link to each other. Requires ENABLE_EMBEDDINGS=true.",
    {
      path: z.string().max(500).optional().describe("Vault-relative note path, or omit for batch mode"),
      limit: z.number().optional().describe("Max suggestions per note (default 5)"),
      min_similarity: z.number().optional().describe("Minimum cosine similarity threshold (default 0.75)"),
      vault: VAULT_PARAM,
    },
    wrapHandler("vault_find_connections", async ({ path: notePath, limit, min_similarity, vault: vaultName }) => {
      try {
        const { vault, embeddingStore, embedProvider, searchStore } = await getSvc(vaultName);
        if (!embeddingStore || !embedProvider || !searchStore) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ error: "Embeddings not enabled — set ENABLE_EMBEDDINGS=true" }),
              },
            ],
            isError: true,
          };
        }
        const suggestions = await findConnections({
          ...(notePath !== undefined ? { notePath } : {}),
          limit: limit ?? 5,
          minSimilarity: min_similarity ?? 0.75,
          searchStore,
          embeddingStore,
          embedProvider,
          vault,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ok: true, count: suggestions.length, suggestions }, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
            },
          ],
          isError: true,
        };
      }
    }),
  );

  // ── vault_backup_db ───────────────────────────────────────────────────────
  server.tool(
    "vault_backup_db",
    "Backup the vault search database. Creates a timestamped copy in the backup directory and prunes old backups.",
    { vault: VAULT_PARAM },
    wrapHandler("vault_backup_db", async ({ vault: vaultName }) => {
      try {
        const { searchStore } = await getSvc(vaultName);
        if (!backupConfig.enabled) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: "Backup is not enabled" }) }],
            isError: true,
          };
        }
        // Use a vault-specific subdirectory so multi-vault backups never collide
        const resolvedVault = vaultName ?? "default";
        const backupDir = path.join(backupConfig.dir, resolvedVault);
        const result = await runBackupTask({
          searchStore,
          backupDir,
          maxBackups: backupConfig.maxBackups,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          ...(result.ok ? {} : { isError: true }),
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
            },
          ],
          isError: true,
        };
      }
    }),
  );

  // ── vault_triage_inbox ────────────────────────────────────────────────────
  server.tool(
    "vault_triage_inbox",
    "Classify notes in the inbox and auto-move high-confidence ones to the right folder. Returns moved, suggested, and skipped lists.",
    {
      dry_run: z.boolean().optional().describe("Preview moves without writing (default false)"),
      auto_move_threshold: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Confidence threshold for auto-move (default 0.8)"),
      suggest_threshold: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Confidence threshold for suggestions (default 0.6)"),
      inbox_folder: z.string().max(500).optional().describe("Inbox folder path (default 00_Inbox)"),
      vault: VAULT_PARAM,
    },
    wrapHandler(
      "vault_triage_inbox",
      async ({ dry_run, auto_move_threshold, suggest_threshold, inbox_folder, vault: vaultName }) => {
        try {
          const { vault, vaultSync, vaultPath } = await getSvc(vaultName);
          const result = await triageInbox({
            vault,
            vaultSync,
            autoMoveThreshold: auto_move_threshold ?? 0.8,
            suggestThreshold: suggest_threshold ?? 0.6,
            inboxFolder: inbox_folder ?? "00_Inbox",
            dryRun: dry_run ?? false,
            vaultPath,
          });
          return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
              },
            ],
            isError: true,
          };
        }
      },
    ),
  );

  // ── vault_periodic_note ───────────────────────────────────────────────────
  server.tool(
    "vault_periodic_note",
    "Open or create a periodic note (daily, weekly, monthly). Creates the note if it doesn't exist and returns its content.",
    {
      period: z.enum(["daily", "weekly", "monthly"]).describe("Note period"),
      date: z.string().max(50).optional().describe("ISO 8601 date string (default today)"),
      vault: VAULT_PARAM,
    },
    wrapHandler("vault_periodic_note", async ({ period, date, vault: vaultName }) => {
      try {
        const { vault, vaultSync } = await getSvc(vaultName);
        const d = date ? new Date(date) : new Date();
        const root = periodicNotesRoot ?? "Journal";
        const note = await openOrCreatePeriodicNote(vault, period as Period, d, root);
        if (vaultSync) {
          vaultSync.handleUpsert(note.path).catch((err) =>
            logger.error("tools", "sync index update failed", {
              err: err instanceof Error ? err.message : String(err),
            }),
          );
        }
        return { content: [{ type: "text" as const, text: JSON.stringify(toClientNote(note), null, 2) }] };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
            },
          ],
          isError: true,
        };
      }
    }),
  );

  // ── vault_batch ───────────────────────────────────────────────────────────
  server.tool(
    "vault_batch",
    "Execute multiple vault operations (move, delete, update_properties) in a single call. Processes sequentially and non-atomically — partial completion is possible if continue_on_error is true. Stops on first error otherwise.",
    {
      operations: z
        .array(
          z.object({
            type: z.enum(["move", "delete", "update_properties"]),
            path: PATH_PARAM("Vault-relative source path"),
            to_path: z.string().max(500).optional().describe("Destination path (required for move)"),
            properties: z
              .record(z.unknown())
              .optional()
              .describe("Properties to merge (required for update_properties)"),
            trash: z
              .boolean()
              .optional()
              .describe("For delete: move to .trash/ instead of permanent delete (default true)"),
          }),
        )
        .min(1)
        .max(100)
        .describe("List of operations to execute"),
      continue_on_error: z
        .boolean()
        .optional()
        .describe("Continue processing remaining operations after a failure (default false)"),
      vault: VAULT_PARAM,
    },
    wrapHandler("vault_batch", async ({ operations, continue_on_error, vault: vaultName }) => {
      let resolved: VaultServices;
      try {
        resolved = await getSvc(vaultName);
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
            },
          ],
          isError: true,
        };
      }
      const { vault, vaultSync } = resolved;
      const results: Array<{ type: string; ok: boolean; path: string; message?: string }> = [];
      for (const op of operations) {
        try {
          if (op.type === "move") {
            if (!op.to_path) {
              results.push({ type: op.type, ok: false, path: op.path, message: "to_path is required for move" });
              if (!continue_on_error) break;
              continue;
            }
            const result = await vault.moveNote(op.path, op.to_path);
            if (result.ok && vaultSync) {
              vaultSync
                .handleRename(
                  op.path.endsWith(".md") ? op.path : `${op.path}.md`,
                  op.to_path.endsWith(".md") ? op.to_path : `${op.to_path}.md`,
                )
                .catch((err: unknown) =>
                  logger.error("tools", "vault_batch rename sync failed", {
                    err: err instanceof Error ? err.message : String(err),
                  }),
                );
            }
            results.push({
              type: op.type,
              ok: result.ok,
              path: result.path,
              ...(result.message ? { message: result.message } : {}),
            });
          } else if (op.type === "delete") {
            const useTrash = op.trash !== false;
            if (useTrash) {
              const result = await vault.softDeleteNote(op.path);
              if (result.ok && vaultSync) vaultSync.handleDelete(result.path);
              results.push({
                type: op.type,
                ok: result.ok,
                path: result.path,
                ...(result.message ? { message: result.message } : {}),
              });
            } else {
              const result = await vault.deleteNote(op.path);
              if (result.ok && vaultSync) {
                vaultSync.handleDelete(op.path.endsWith(".md") ? op.path : `${op.path}.md`);
              }
              results.push({
                type: op.type,
                ok: result.ok,
                path: result.path,
                ...(result.message ? { message: result.message } : {}),
              });
            }
          } else if (op.type === "update_properties") {
            if (!op.properties) {
              results.push({
                type: op.type,
                ok: false,
                path: op.path,
                message: "properties is required for update_properties",
              });
              if (!continue_on_error) break;
              continue;
            }
            const result = await vault.updateProperties(op.path, op.properties);
            if (result.ok && vaultSync) {
              vaultSync.handleUpsert(result.path).catch((err: unknown) =>
                logger.error("tools", "vault_batch upsert sync failed", {
                  err: err instanceof Error ? err.message : String(err),
                }),
              );
            }
            results.push({
              type: op.type,
              ok: result.ok,
              path: result.path,
              ...(result.message ? { message: result.message } : {}),
            });
          }
          if (!results[results.length - 1]?.ok && !continue_on_error) break;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          results.push({ type: op.type as string, ok: false, path: op.path as string, message });
          if (!continue_on_error) break;
        }
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
    }),
  );

  // ── vault_list_vaults ─────────────────────────────────────────────────────
  server.tool(
    "vault_list_vaults",
    "List all configured vaults. Returns vault names and their paths.",
    {},
    wrapHandler("vault_list_vaults", async () => {
      const vaults = vaultManager.listVaults();
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ vaults, total: vaults.length }, null, 2) }],
      };
    }),
  );
}
