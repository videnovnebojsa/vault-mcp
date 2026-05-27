import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { VaultError, VaultErrorCode } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { beginSpan } from "../utils/span.js";
import { withTimeout } from "../utils/timeout.js";
import type { VaultManager, VaultServices } from "../vault/manager.js";
import { errorResult, type ToolResult } from "./format.js";
import {
  handleVaultBackupDb,
  handleVaultBatch,
  handleVaultCapture,
  handleVaultClassify,
  handleVaultDeleteNote,
  handleVaultEmbedBacklog,
  handleVaultFindConnections,
  handleVaultListFolder,
  handleVaultListTags,
  handleVaultListVaults,
  handleVaultMoveNote,
  handleVaultPeriodicNote,
  handleVaultReadNote,
  handleVaultReadNoteWithLinks,
  handleVaultReadSection,
  handleVaultSearch,
  handleVaultSync,
  handleVaultTriageInbox,
  handleVaultUpdateProperties,
  handleVaultWriteNote,
} from "./handlers/index.js";

export interface RegisterToolsOptions {
  server: McpServer;
  vaultManager: VaultManager;
}

const VAULT_PARAM = z
  .string()
  .regex(/^[a-zA-Z0-9_-]+$/, "Vault name must contain only alphanumeric characters, hyphens, and underscores")
  .max(100)
  .optional()
  .describe("Vault name (alphanumeric, hyphens, underscores; default: primary vault)");

const PATH_PARAM = (desc: string) => z.string().trim().min(1).max(500).describe(desc);
const CONTENT_PARAM = (desc: string) => z.string().max(1_000_000).describe(`${desc} (max 1MB)`);
const QUERY_PARAM = (desc: string) => z.string().trim().min(1).max(500).describe(desc);
const FOLDER_PARAM = (desc: string) => z.string().trim().min(1).max(500).optional().describe(desc);

const DATE_PARAM = (desc: string, optional = true) => {
  const schema = z
    .string()
    .max(50)
    .refine((s) => !Number.isNaN(new Date(s).getTime()), {
      message: "Must be a valid ISO 8601 date string (e.g. '2024-01-15' or '2024-01-15T09:00:00Z')",
    })
    .describe(desc);
  return optional ? schema.optional() : schema;
};

const LIMIT_PARAM = (max = 500, defaultVal = 20) =>
  z
    .number()
    .int()
    .min(1)
    .max(max)
    .default(defaultVal)
    .describe(`Max results to return (1–${max}, default ${defaultVal})`);

const OFFSET_PARAM = z.number().int().min(0).max(10_000).default(0).describe("Pagination offset (0-10000, default 0)");

const NOTE_WITH_LINKS_SCHEMA = {
  path: PATH_PARAM("Vault-relative path to the note"),
  max_links: z
    .number()
    .int()
    .min(0)
    .max(20)
    .default(10)
    .describe("Max linked notes to fetch (0 = root note only, max 20)"),
  include_content: z
    .boolean()
    .default(false)
    .describe("Include full content of linked notes (false returns path, name, and frontmatter only)."),
  snippet_length: z
    .number()
    .int()
    .min(0)
    .max(2000)
    .default(200)
    .describe("When include_content=false, characters to return as snippet."),
  vault: VAULT_PARAM,
};

const PROPERTY_KEY_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_-]*$/;
const PROPERTIES_PARAM = z
  .record(z.string().regex(PROPERTY_KEY_PATTERN, "Property keys must start with a letter or underscore"), z.unknown())
  .describe("Frontmatter properties to merge");

function isUnknownVaultError(err: unknown): boolean {
  return err instanceof Error && /^Unknown vault\b/.test(err.message);
}

export function registerTools(opts: RegisterToolsOptions): void {
  const { server, vaultManager } = opts;
  const {
    periodicNotesRoot,
    backup: backupConfig,
    toolTimeoutMs: cfgTimeout,
    classifyRules,
    folders,
  } = vaultManager.config;
  const toolTimeoutMs = cfgTimeout ?? 30_000;

  function wrapHandler<A extends Record<string, unknown>>(
    toolName: string,
    fn: (args: A, requestId: string) => Promise<ToolResult>,
    spanAttributes?: Record<string, string | number | boolean>,
  ): (args: A) => Promise<ToolResult> {
    return async (args: A): Promise<ToolResult> => {
      const vault = typeof args["vault"] === "string" ? args["vault"] : "default";
      const span = beginSpan(toolName, vault, spanAttributes);
      try {
        const result = await withTimeout(() => fn(args, span.id), toolTimeoutMs);
        const isError = result.isError ?? false;
        const errMsg = isError ? (result.content[0]?.text ?? "tool error") : undefined;
        span.end(isError ? new Error(errMsg) : undefined);
        return result;
      } catch (err) {
        span.end(err);
        const isVaultErr = err instanceof VaultError;
        const isUnknownVault = isUnknownVaultError(err);
        if (!isVaultErr && !isUnknownVault) {
          logger.error("tools", `${toolName} threw an unexpected error`, {
            err: err instanceof Error ? err.message : String(err),
          });
        }
        const message = isUnknownVault ? "Unknown vault" : err instanceof Error ? err.message : String(err);
        const code = isVaultErr ? err.code : isUnknownVault ? VaultErrorCode.VALIDATION : VaultErrorCode.INTERNAL_ERROR;
        return errorResult(code, message);
      }
    };
  }

  async function getSvc(vaultName?: string): Promise<VaultServices> {
    const svc = vaultManager.getServices(vaultName);
    const bootError = await svc.bootReady.then(() => null).catch((e: unknown) => e);
    if (bootError !== null) {
      const reason = bootError instanceof Error ? bootError.message : String(bootError);
      throw new VaultError(
        `Vault "${vaultName ?? "default"}" failed to initialise: ${reason}`,
        VaultErrorCode.BOOT_FAILED,
        bootError,
      );
    }
    return svc;
  }

  // ── vault_read_note ───────────────────────────────────────────────────────
  server.tool(
    "vault_read_note",
    "Read a note from the vault by path. Returns content, frontmatter, and metadata.",
    {
      path: PATH_PARAM(
        "Vault-relative path WITHOUT the .md extension (e.g. '00_Inbox/my-note'). The .md extension is added automatically.",
      ),
      vault: VAULT_PARAM,
    },
    wrapHandler("vault_read_note", async (args) => {
      const services = await getSvc(args.vault);
      return handleVaultReadNote(args, services);
    }),
  );

  // ── vault_write_note ──────────────────────────────────────────────────────
  server.tool(
    "vault_write_note",
    "Create or update a note in the vault with optional frontmatter.",
    {
      path: PATH_PARAM(
        "Vault-relative path WITHOUT the .md extension (e.g. 'Projects/my-idea'). The .md extension is added automatically.",
      ),
      content: CONTENT_PARAM("Markdown content of the note"),
      frontmatter: PROPERTIES_PARAM.optional().describe("Optional YAML frontmatter fields"),
      vault: VAULT_PARAM,
    },
    wrapHandler("vault_write_note", async (args) => {
      const services = await getSvc(args.vault);
      return handleVaultWriteNote(args, services, vaultManager);
    }),
  );

  // ── vault_search ──────────────────────────────────────────────────────────
  server.tool(
    "vault_search",
    "Search notes by content or filename. Supports keyword (FTS5), semantic (vector), and hybrid modes; semantic and hybrid require ENABLE_EMBEDDINGS=true. Optionally filter by tags, type, or date. Paginated responses include hasMore; nextOffset is omitted when hasMore is false.",
    {
      query: QUERY_PARAM("Search query"),
      limit: LIMIT_PARAM(200, 20),
      offset: OFFSET_PARAM,
      folder: FOLDER_PARAM("Folder to scope search to"),
      mode: z
        .enum(["keyword", "semantic", "hybrid"])
        .optional()
        .describe("Search mode (default: hybrid when embeddings enabled, keyword otherwise)"),
      tags: z.array(z.string().max(100)).optional().describe("Filter to notes with any of these tags"),
      type: z.string().max(100).optional().describe("Filter to notes with this frontmatter type"),
      modified_after: DATE_PARAM("ISO date — only return notes modified after this date"),
      created_after: DATE_PARAM("ISO date — only return notes created after this date"),
      vault: VAULT_PARAM,
    },
    wrapHandler("vault_search", async (args) => {
      const services = await getSvc(args.vault);
      return handleVaultSearch(args, services);
    }),
  );

  // ── vault_list_tags ───────────────────────────────────────────────────────
  server.tool(
    "vault_list_tags",
    "List all tags in the vault with their note counts, sorted by frequency. Paginated responses include hasMore; nextOffset is omitted when hasMore is false.",
    { limit: LIMIT_PARAM(200, 50), offset: OFFSET_PARAM, vault: VAULT_PARAM },
    wrapHandler("vault_list_tags", async (args) => {
      const services = await getSvc(args.vault);
      return handleVaultListTags(args, services);
    }),
  );

  // ── vault_classify ────────────────────────────────────────────────────────
  server.tool(
    "vault_classify",
    "Classify text and suggest a vault folder and title using keyword heuristics. " +
      "The suggested_folder is determined by the server's configured folder map (VAULT_FOLDER_* env vars) — " +
      "it is a folder name, not a full path. Custom folder names without numeric prefixes are fully supported.",
    { text: z.string().max(10_000).describe("Text to classify"), vault: VAULT_PARAM },
    wrapHandler("vault_classify", async (args) => {
      const services = await getSvc(args.vault);
      return handleVaultClassify(args, services, classifyRules, folders);
    }),
  );

  // ── vault_list_folder ─────────────────────────────────────────────────────
  server.tool(
    "vault_list_folder",
    "List notes in a vault folder with metadata. Returns lightweight summaries. Paginated responses include hasMore; nextOffset is omitted when hasMore is false.",
    {
      folder: PATH_PARAM("Vault-relative folder path"),
      recursive: z.boolean().default(true).describe("Recurse into subfolders (default true)"),
      limit: LIMIT_PARAM(500, 100),
      offset: OFFSET_PARAM,
      modified_after: DATE_PARAM("ISO 8601 date — only return notes modified after this date"),
      vault: VAULT_PARAM,
    },
    wrapHandler("vault_list_folder", async (args) => {
      const services = await getSvc(args.vault);
      return handleVaultListFolder(args, services);
    }),
  );

  // ── vault_update_properties ───────────────────────────────────────────────
  server.tool(
    "vault_update_properties",
    "Update frontmatter properties on an existing note. Merges with existing fields.",
    {
      path: PATH_PARAM("Vault-relative path to the note"),
      properties: PROPERTIES_PARAM,
      vault: VAULT_PARAM,
    },
    wrapHandler("vault_update_properties", async (args) => {
      const services = await getSvc(args.vault);
      return handleVaultUpdateProperties(args, services, vaultManager);
    }),
  );

  // ── vault_move_note ───────────────────────────────────────────────────────
  server.tool(
    "vault_move_note",
    "Move or rename a note in the vault. Automatically updates all [[wikilinks]] in other notes that reference the old path.",
    {
      from_path: PATH_PARAM("Current vault-relative path of the note"),
      to_path: PATH_PARAM("New vault-relative path for the note"),
      update_backlinks: z.boolean().default(true).describe("Update wikilinks in all other notes"),
      confirm: z
        .literal(true)
        .optional()
        .describe(
          "Pass confirm=true to overwrite the destination if it already exists. This will permanently replace the existing note.",
        ),
      vault: VAULT_PARAM,
    },
    wrapHandler("vault_move_note", async (args) => {
      const services = await getSvc(args.vault);
      return handleVaultMoveNote(args, services, vaultManager);
    }),
  );

  // ── vault_delete_note ─────────────────────────────────────────────────────
  server.tool(
    "vault_delete_note",
    "Delete a note from the vault. By default moves to .trash/ folder; set trash=false for permanent delete.",
    {
      path: PATH_PARAM("Vault-relative path of the note to delete"),
      trash: z
        .boolean()
        .default(true)
        .describe(
          "When true, moves to .trash/ for recovery. " +
            "When false, PERMANENTLY deletes — set confirm=true to proceed.",
        ),
      confirm: z
        .literal(true)
        .optional()
        .describe("Required when trash=false. Set to true to confirm permanent, irreversible deletion."),
      vault: VAULT_PARAM,
    },
    wrapHandler("vault_delete_note", async (args) => {
      const services = await getSvc(args.vault);
      return handleVaultDeleteNote(args, services, vaultManager);
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
    wrapHandler("vault_read_section", async (args) => {
      const services = await getSvc(args.vault);
      return handleVaultReadSection(args, services);
    }),
  );

  // ── vault_read_note_with_links ────────────────────────────────────────────
  server.tool(
    "vault_read_note_with_links",
    "Read a note and all notes it links to via [[wikilinks]] in a single call. Returns the note plus up to 20 linked notes (0 = root note only, default 10, configurable via max_links).",
    { ...NOTE_WITH_LINKS_SCHEMA },
    wrapHandler("vault_read_note_with_links", async (args) => {
      const services = await getSvc(args.vault);
      return handleVaultReadNoteWithLinks(args, services);
    }),
  );

  // ── vault_get_note_with_links (deprecated) ────────────────────────────────
  // intentional — wrapHandler records spans under the old name to track migration progress on dashboards
  // [API-03] metrics will show vault_get_note_with_links separately; sum both names for canonical tool totals
  server.tool(
    "vault_get_note_with_links",
    "Deprecated alias for vault_read_note_with_links — will be removed in a future release. Read a note and all notes it links to via [[wikilinks]] in a single call. Use vault_read_note_with_links instead.",
    { ...NOTE_WITH_LINKS_SCHEMA },
    wrapHandler(
      "vault_get_note_with_links",
      async (args, requestId) => {
        const services = await getSvc(args.vault);
        logger.info("tools", "vault_get_note_with_links is deprecated; use vault_read_note_with_links", {
          replacement: "vault_read_note_with_links",
          requestId,
          vault: args.vault,
        });
        const result = await handleVaultReadNoteWithLinks(args, services);
        const envelope = JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
        const data =
          envelope["data"] && typeof envelope["data"] === "object" && !Array.isArray(envelope["data"])
            ? (envelope["data"] as Record<string, unknown>)
            : {};
        data["_deprecated"] = { replacement: "vault_read_note_with_links" };
        envelope["data"] = data;
        return { ...result, content: [{ type: "text" as const, text: JSON.stringify(envelope) }] };
      },
      { deprecated: true },
    ),
  );

  // ── vault_capture ─────────────────────────────────────────────────────────
  server.tool(
    "vault_capture",
    "Capture text into the vault. Classifies content using keyword heuristics and files it into the " +
      "operator-configured folder (set via VAULT_FOLDER_* env vars on the server). " +
      "The target folder is determined server-side; you do not need to specify it.",
    { text: z.string().trim().min(1).max(100_000).describe("Text to capture"), vault: VAULT_PARAM },
    wrapHandler("vault_capture", async (args) => {
      const services = await getSvc(args.vault);
      return handleVaultCapture(args, services, vaultManager);
    }),
  );

  // ── vault_sync ────────────────────────────────────────────────────────────
  server.tool(
    "vault_sync",
    "Trigger a full vault sync to rebuild the search index. Returns sync statistics.",
    { vault: VAULT_PARAM },
    wrapHandler("vault_sync", async (args) => {
      const services = await getSvc(args.vault);
      return handleVaultSync(args, services);
    }),
  );

  // ── vault_embed_backlog ───────────────────────────────────────────────────
  server.tool(
    "vault_embed_backlog",
    "Batch embed notes with missing or stale embeddings. Requires ENABLE_EMBEDDINGS=true.",
    {
      max_notes: z
        .number()
        .int()
        .min(1)
        .max(10_000)
        .default(500)
        .describe("Max notes to embed in this call (default 500). Call repeatedly until result.remaining === 0."),
      vault: VAULT_PARAM,
    },
    wrapHandler("vault_embed_backlog", async (args) => {
      const services = await getSvc(args.vault);
      return handleVaultEmbedBacklog(args, services);
    }),
  );

  // ── vault_find_connections ────────────────────────────────────────────────
  server.tool(
    "vault_find_connections",
    "Find notes that are semantically similar but don't link to each other. Requires ENABLE_EMBEDDINGS=true.",
    {
      path: PATH_PARAM(
        "Vault-relative note path. If omitted, enters batch mode — scans up to 200 embedded notes. " +
          "Batch mode may take several seconds on a large vault.",
      ).optional(),
      limit: z.number().int().min(1).max(50).default(5).describe("Max suggestions per note"),
      min_similarity: z.number().min(0).max(1).default(0.75).describe("Minimum cosine similarity threshold"),
      vault: VAULT_PARAM,
    },
    wrapHandler("vault_find_connections", async (args) => {
      const services = await getSvc(args.vault);
      return handleVaultFindConnections(args, services, folders);
    }),
  );

  // ── vault_backup_db ───────────────────────────────────────────────────────
  server.tool(
    "vault_backup_db",
    "Backup the vault search database. Creates a timestamped copy in the backup directory and prunes old backups.",
    { vault: VAULT_PARAM },
    wrapHandler("vault_backup_db", async (args) => {
      const services = await getSvc(args.vault);
      return handleVaultBackupDb(args, services, {
        ...backupConfig,
        alertWebhookUrl: vaultManager.config.alertWebhookUrl,
      });
    }),
  );

  // ── vault_triage_inbox ────────────────────────────────────────────────────
  server.tool(
    "vault_triage_inbox",
    "Classify notes in the inbox and auto-move high-confidence ones to the right folder. Returns moved, suggested, and skipped lists.",
    {
      dry_run: z.boolean().default(false).describe("Preview moves without writing"),
      auto_move_threshold: z.number().min(0).max(1).default(0.8).describe("Confidence threshold for auto-move"),
      suggest_threshold: z.number().min(0).max(1).default(0.6).describe("Confidence threshold for suggestions"),
      inbox_folder: z
        .string()
        .trim()
        .min(1)
        .max(500)
        .refine((s) => !s.split("/").includes(".."), "Inbox folder must not contain '..' path components")
        .default(folders.INBOX)
        .describe(`Inbox folder path (default: "${folders.INBOX}" from server config)`),
      vault: VAULT_PARAM,
    },
    wrapHandler("vault_triage_inbox", async (args) => {
      const services = await getSvc(args.vault);
      return handleVaultTriageInbox(args, services, folders);
    }),
  );

  // ── vault_periodic_note ───────────────────────────────────────────────────
  server.tool(
    "vault_periodic_note",
    "Open or create a periodic note (daily, weekly, monthly). Creates the note if it doesn't exist and returns its content.",
    {
      period: z.enum(["daily", "weekly", "monthly"]).describe("Note period"),
      date: DATE_PARAM("Target date for the note (default: today)"),
      create_if_missing: z
        .boolean()
        .default(true)
        .describe("Create the note if it doesn't exist. Set false to check existence without creating."),
      vault: VAULT_PARAM,
    },
    wrapHandler("vault_periodic_note", async (args) => {
      const services = await getSvc(args.vault);
      return handleVaultPeriodicNote(args, services, vaultManager, periodicNotesRoot ?? "Journal");
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
            to_path: PATH_PARAM("Destination path (required for move)").optional(),
            properties: PROPERTIES_PARAM.optional().describe("Properties to merge (required for update_properties)"),
            trash: z
              .boolean()
              .optional()
              .describe("For delete: move to .trash/ instead of permanent delete (default true)"),
            confirm: z
              .literal(true)
              .optional()
              .describe("For delete with trash=false: required to confirm permanent deletion."),
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
    wrapHandler("vault_batch", async (args) => {
      const services = await getSvc(args.vault);
      return handleVaultBatch(args, services, vaultManager);
    }),
  );

  // ── vault_list_vaults ─────────────────────────────────────────────────────
  server.tool(
    "vault_list_vaults",
    "List all configured vaults. Returns vault names and their paths.",
    {},
    wrapHandler("vault_list_vaults", async (args) => {
      return handleVaultListVaults(args, vaultManager.listVaults());
    }),
  );
}
