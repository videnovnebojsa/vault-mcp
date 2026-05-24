// Public library API — stable surface for vault-service consumption.
// Import from "vault-mcp/lib" rather than internal "vault-mcp/src/..." paths.

export { appendClassificationLog } from "./capture/audit-log.js";
export { classifyWithHeuristic } from "./capture/classify-adapter.js";
export { buildAuditLogPath, buildCapturePath, sanitizeFilename } from "./capture/filename.js";
export type { ConnectionSuggestion } from "./search/connections.js";
export { findConnections } from "./search/connections.js";
export type { EmbedProvider } from "./search/embed-provider.js";
export { HttpEmbedProvider } from "./search/embed-provider.js";
export { EmbeddingStore } from "./search/embeddings.js";
export { VaultSearchStore } from "./search/store.js";
export { VaultSync } from "./search/sync.js";
export type { VaultWatcher } from "./search/watcher.js";
export { createVaultWatcher } from "./search/watcher.js";
export type { ChildLogger } from "./utils/logger.js";
export { logger } from "./utils/logger.js";
export { RetryableError, withRetry } from "./utils/retry.js";
export { VaultRepository } from "./vault/repository.js";
export type {
  ListFolderOptions,
  VaultFrontmatter,
  VaultNote,
  VaultNoteSummary,
  VaultOperationResult,
  WriteNoteInput,
} from "./vault/types.js";
