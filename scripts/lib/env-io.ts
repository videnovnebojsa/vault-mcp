/**
 * .env file I/O for vault-mcp.
 * Provides canonical parsing and template rendering for
 * ~/.config/vault-mcp/.env — shared by setup.ts and configure.ts.
 */

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";

// ── Parsing ───────────────────────────────────────────────────────────────────

/**
 * Parse an .env file into a Map<key, value>.
 * Comment lines (# …) and blank lines are ignored.
 * Returns an empty Map if the file does not exist.
 */
export function parseEnvFile(filePath: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!existsSync(filePath)) return map;

  const content = readFileSync(filePath, "utf8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;

    const key = trimmed.slice(0, eqIdx).trim();
    const value = parseEnvValue(trimmed.slice(eqIdx + 1).trim());

    if (/^[A-Z_][A-Z0-9_]*$/.test(key)) {
      map.set(key, value);
    }
  }
  return map;
}

// ── Template rendering ────────────────────────────────────────────────────────

/**
 * Emit one .env line for `key`.
 * - If `values` has a non-empty value for the key → `KEY=value` (active)
 * - Otherwise → `# KEY=hint   # comment` (commented-out example)
 */
function parseEnvValue(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    const inner = value.slice(1, -1);
    return inner.replace(/\\(["\\$`])/g, "$1").replace(/\\n/g, "\n");
  }
  return value;
}

function quoteEnvValue(value: string): string {
  if (!/[\s"\\$`#]/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$").replace(/`/g, "\\`").replace(/\n/g, "\\n")}"`;
}

function envLine(values: Map<string, string>, key: string, hint = "", comment = ""): string {
  const v = values.get(key);
  if (v !== undefined && v !== "") return `${key}=${quoteEnvValue(v)}`;
  const suffix = comment ? `   # ${comment}` : "";
  return `# ${key}=${hint}${suffix}`;
}

/**
 * Render the canonical .env template, substituting `values` into active lines.
 * Keys absent from (or empty in) the map are emitted as commented-out hints.
 */
export function renderEnvTemplate(values: Map<string, string>, restartCmd: string): string {
  const date = new Date().toISOString().slice(0, 10);

  return `# vault-mcp configuration
# Generated on ${date}
# Edit this file to change settings, then restart: ${restartCmd}
# Full reference: https://github.com/videnovnebojsa/vault-mcp/blob/main/docs/configuration.md

# ── Vault Paths ───────────────────────────────────────────────────────────────
${envLine(values, "OBSIDIAN_VAULT_PATH", "~/Documents/obsidian")}
${envLine(values, "VAULT_PATHS", "work:~/vaults/work;archive:~/vaults/archive")}
${envLine(values, "MEMORY_DB_PATH", "", "default: {vault}/.vault-search.db")}

# ── HTTP Server ───────────────────────────────────────────────────────────────
${envLine(values, "MCP_PORT", "3782")}
${envLine(values, "MCP_HOST", "127.0.0.1", "0.0.0.0 to expose on the network")}
${envLine(values, "MCP_API_KEY", "", "Bearer token; empty = local-only")}
${envLine(values, "MCP_HTTP_BODY_LIMIT_BYTES", "1048576")}
${envLine(values, "MCP_MAX_SESSIONS", "100")}
${envLine(values, "MCP_MAX_CONCURRENT_REQUESTS", "100")}
${envLine(values, "MCP_SESSION_IDLE_MS", "1800000", "30 minutes")}

# ── Vector Embeddings ─────────────────────────────────────────────────────────
${envLine(values, "ENABLE_EMBEDDINGS", "false")}
${envLine(values, "EMBEDDING_API_KEY", "")}
${envLine(values, "EMBEDDING_ENDPOINT", "", "e.g. https://api.openai.com/v1")}
${envLine(values, "EMBEDDING_MODEL", "text-embedding-3-small")}
${envLine(values, "HYBRID_ALPHA", "0.5", "0=pure semantic, 1=pure keyword")}
${envLine(values, "EMBED_BATCH_SIZE", "20")}
${envLine(values, "QUERY_EMBEDDING_CACHE_MAX", "128")}

# ── Capture Pipeline ──────────────────────────────────────────────────────────
${envLine(values, "ENABLE_CAPTURE_PIPELINE", "false")}
${envLine(values, "CLASSIFY_RULES_PATH", "", "path to JSON rules file")}
${envLine(values, "LOG_RAW_INPUT", "false")}

# ── Periodic Notes ────────────────────────────────────────────────────────────
${envLine(values, "PERIODIC_NOTES_ROOT", "Journal")}

# ── Backup ────────────────────────────────────────────────────────────────────
${envLine(values, "ENABLE_DB_BACKUP", "true")}
${envLine(values, "DB_BACKUP_DIR", "", "default: {vault}/.vault-backups")}
${envLine(values, "DB_BACKUP_MAX_KEEP", "5")}

# ── File Watcher ──────────────────────────────────────────────────────────────
${envLine(values, "ENABLE_FILE_WATCHER", "true")}
${envLine(values, "FILE_WATCHER_DEBOUNCE_MS", "300")}

# ── Access Control ────────────────────────────────────────────────────────────
${envLine(values, "VAULT_ALLOW_PATHS", "", "comma-separated vault-relative allowlist")}
${envLine(values, "VAULT_DENY_PATHS", "", "comma-separated denylist (applied after allow)")}

# ── Logging & Monitoring ──────────────────────────────────────────────────────
${envLine(values, "LOG_LEVEL", "info", "debug | info | warn | error")}
${envLine(values, "LOG_FORMAT", "text", "text | json")}
${envLine(values, "ALERT_WEBHOOK_URL", "")}
${envLine(values, "ENABLE_OTEL", "false")}
${envLine(values, "OTEL_EXPORTER_OTLP_ENDPOINT", "")}

# ── Vault Folder Names ────────────────────────────────────────────────────────
# Override any folder to match your vault's structure. Leave blank to use the defaults.
${envLine(values, "VAULT_FOLDER_INBOX", "00_Inbox", "low-confidence captures and unclassified notes")}
${envLine(values, "VAULT_FOLDER_PROJECTS", "10_Projects", "project captures")}
${envLine(values, "VAULT_FOLDER_ZETTELKASTEN", "30_Zettelkasten", "idea / atomic note captures")}
${envLine(values, "VAULT_FOLDER_ARTEFACTS", "35_Artefacts", "excluded from connection detection")}
${envLine(values, "VAULT_FOLDER_CANVASES", "36_Canvases", "excluded from connection detection")}
${envLine(values, "VAULT_FOLDER_TEMPLATES", "50_Templates", "excluded from connection detection")}
${envLine(values, "VAULT_FOLDER_AI_LOGS", "70_AI_Logs", "classification audit logs written here")}
${envLine(values, "VAULT_FOLDER_PEOPLE", "80_People", "person captures")}
${envLine(values, "VAULT_FOLDER_ADMIN", "90_Admin", "admin captures")}
${envLine(values, "VAULT_FOLDER_ARCHIVE", "99_Archive", "excluded from connection detection")}

# ── Advanced ──────────────────────────────────────────────────────────────────
${envLine(values, "TOOL_TIMEOUT_MS", "30000", "0 = disabled")}
`;
}

// ── Writing ───────────────────────────────────────────────────────────────────

/**
 * Write the canonical .env to `filePath` with the given values substituted in.
 * Sets 0600 permissions on non-Windows. The parent directory must exist.
 */
export function writeEnvFile(filePath: string, values: Map<string, string>, restartCmd: string): void {
  writeFileSync(filePath, renderEnvTemplate(values, restartCmd));
  if (process.platform !== "win32") chmodSync(filePath, 0o600);
}
