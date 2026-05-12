import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EmbeddingConfig } from "../config.js";
import type { EmbeddingStore } from "../search/embeddings.js";
import type { VaultSearchStore } from "../search/store.js";
import type { VaultManager } from "../vault/manager.js";
import type { AclConfig } from "../vault/types.js";
import { registerTools } from "./tools.js";

export interface CreateServerOptions {
  vaultManager: VaultManager;
  mcpHost?: string;
  mcpPort?: number;
}

/** Flat context consumed by registerResources — extracted from VaultManager by createServer,
 *  but also accepted directly in tests so resource handlers can be unit-tested without a full manager. */
export interface ResourcesContext {
  periodicNotesRoot?: string;
  watcherEnabled?: boolean;
  captureEnabled?: boolean;
  embeddingConfig?: EmbeddingConfig;
  backupEnabled?: boolean;
  aclConfig?: AclConfig;
  mcpHost?: string;
  mcpPort?: number;
  searchStore?: VaultSearchStore;
  embeddingStore?: EmbeddingStore;
}

export function createServer(opts: CreateServerOptions): McpServer {
  const server = new McpServer({
    name: "vault-mcp",
    version: "0.1.0",
  });

  const cfg = opts.vaultManager.config;
  const defaultSvc = opts.vaultManager.getServices("default");

  registerResources(server, {
    periodicNotesRoot: cfg.periodicNotesRoot,
    watcherEnabled: cfg.watcher.enabled,
    captureEnabled: cfg.capture.enableCapturePipeline,
    embeddingConfig: cfg.embedding,
    backupEnabled: cfg.backup.enabled,
    aclConfig: cfg.acl,
    mcpHost: opts.mcpHost ?? cfg.mcpHost,
    mcpPort: opts.mcpPort ?? cfg.mcpPort,
    searchStore: defaultSvc.searchStore,
    ...(defaultSvc.embeddingStore !== undefined ? { embeddingStore: defaultSvc.embeddingStore } : {}),
  });

  registerTools({ server, vaultManager: opts.vaultManager });

  return server;
}

export function registerResources(server: McpServer, opts: ResourcesContext): void {
  server.resource(
    "vault-config",
    "vault://config",
    { description: "Current vault-mcp configuration and enabled features", mimeType: "application/json" },
    async (uri) => {
      try {
        const payload = {
          periodicNotesRoot: opts.periodicNotesRoot ?? "Journal",
          features: {
            embeddings: opts.embeddingConfig?.enabled ?? false,
            watcher: opts.watcherEnabled ?? false,
            backup: opts.backupEnabled ?? false,
            capture: opts.captureEnabled ?? false,
          },
          acl: {
            allowCount: opts.aclConfig?.allowPaths.length ?? 0,
            denyCount: opts.aclConfig?.denyPaths.length ?? 0,
          },
          server: {
            host: opts.mcpHost ?? "127.0.0.1",
            port: opts.mcpPort ?? 3782,
          },
        };
        return {
          contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(payload, null, 2) }],
        };
      } catch (err) {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
            },
          ],
        };
      }
    },
  );

  // NOTE: vault://stats reflects the default vault's store only. In multi-vault deployments,
  // use vault_list_vaults + per-vault tool calls for per-vault statistics.
  server.resource(
    "vault-stats",
    "vault://stats",
    {
      description: "Live vault index statistics: note count, tags, and embedding coverage",
      mimeType: "application/json",
    },
    async (uri) => {
      try {
        const total = opts.searchStore?.count(opts.aclConfig) ?? 0;
        const indexed = opts.searchStore?.countFTS() ?? 0;
        const uniqueTags = opts.searchStore?.countUniqueTags(opts.aclConfig) ?? 0;
        const embeddingsEnabled = opts.embeddingConfig?.enabled ?? false;
        const embeddedCount = opts.embeddingStore?.size ?? 0;
        const payload = {
          notes: { total, indexed },
          tags: { unique: uniqueTags },
          embeddings: {
            enabled: embeddingsEnabled,
            coverage: embeddingsEnabled && total > 0 ? embeddedCount / total : null,
          },
        };
        return {
          contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(payload, null, 2) }],
        };
      } catch (err) {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
            },
          ],
        };
      }
    },
  );
}
