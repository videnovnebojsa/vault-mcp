import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { resolveVaultFolders, type VaultFolders } from "./config/folders.js";
import { logger } from "./utils/logger.js";

interface WatcherConfig {
  enabled: boolean;
  debounceMs: number;
}

interface BackupConfig {
  enabled: boolean;
  dir: string;
  maxBackups: number;
}

export interface EmbeddingConfig {
  enabled: boolean;
  apiKey: string;
  endpoint: string;
  model: string;
  hybridAlpha: number;
  batchSize: number;
  queryCacheMax: number;
}

export interface CaptureConfig {
  enableCapturePipeline: boolean;
  logRawInput: boolean;
}

interface ClassifyRuleEntry {
  keywords: string[];
  folder: string;
}

export type ClassifyRules = Record<string, ClassifyRuleEntry>;

export interface VaultConfig {
  vaultPath: string;
  memoryDbPath: string;
  sqliteBusyTimeoutMs: number;
  namedVaults: Record<string, string>;
  periodicNotesRoot: string;
  embedding: EmbeddingConfig;
  backup: BackupConfig;
  capture: CaptureConfig;
  watcher: WatcherConfig;
  mcpPort: number;
  mcpHost: string;
  mcpApiKey: string;
  alertWebhookUrl: string;
  acl: { allowPaths: string[]; denyPaths: string[] };
  /** Maximum ms a single tool call may run before being aborted. 0 = disabled. */
  toolTimeoutMs: number;
  /** Custom classification rules loaded from CLASSIFY_RULES_PATH, or undefined to use built-in defaults. */
  classifyRules: ClassifyRules | undefined;
  /** Vault folder names, resolved from VAULT_FOLDER_* env vars (falls back to built-in defaults). */
  folders: VaultFolders;
  /** Emit OpenTelemetry spans per tool call when true. */
  enableOtel: boolean;
  /** OTLP exporter endpoint (used only when enableOtel is true). */
  otelEndpoint: string;
}

function parseNamedVaults(envValue: string | undefined, defaultPath: string): Record<string, string> {
  const result: Record<string, string> = { default: defaultPath };
  if (!envValue?.trim()) return result;
  for (const entry of envValue.split(";")) {
    const colonIdx = entry.indexOf(":");
    if (colonIdx <= 0) continue;
    const name = entry.slice(0, colonIdx).trim();
    const rawPath = entry.slice(colonIdx + 1).trim();
    if (!name || !rawPath) continue;
    if (name === "default") continue;
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) continue;
    result[name] = path.resolve(expandHome(rawPath));
  }
  return result;
}

function parsePathList(v: string | undefined): string[] {
  if (!v?.trim()) return [];
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseHttpUrlEnv(name: string): string {
  const raw = process.env[name]?.trim();
  if (!raw) return "";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} must be a valid http or https URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} must use http or https`);
  }
  return raw;
}

function safeInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) {
    logger.warn("config", "non-integer env value ignored", { value, fallback });
    return fallback;
  }
  return n;
}

function expandHome(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return path.join(homedir(), p.slice(1));
  }
  return p;
}

export function loadConfig(): VaultConfig {
  const raw = process.env["OBSIDIAN_VAULT_PATH"] ?? "~/Documents/obsidian";
  const vaultPath = path.resolve(expandHome(raw));

  const memoryDbPathRaw = process.env["MEMORY_DB_PATH"];
  const memoryDbPath = memoryDbPathRaw
    ? path.resolve(expandHome(memoryDbPathRaw))
    : path.join(vaultPath, ".vault-search.db");

  const sqliteBusyTimeoutMs = Math.max(0, Math.min(300_000, safeInt(process.env["SQLITE_BUSY_TIMEOUT_MS"], 5_000)));

  const hybridAlphaRaw = parseFloat(process.env["HYBRID_ALPHA"] ?? "");
  const hybridAlpha = Number.isFinite(hybridAlphaRaw) ? Math.max(0, Math.min(1, hybridAlphaRaw)) : 0.5;

  const backupDirRaw = process.env["DB_BACKUP_DIR"];

  const namedVaults = parseNamedVaults(process.env["VAULT_PATHS"], vaultPath);

  const ClassifyRulesSchema = z.record(z.object({ keywords: z.array(z.string()), folder: z.string() }));

  let classifyRules: ClassifyRules | undefined;
  const classifyRulesPathRaw = process.env["CLASSIFY_RULES_PATH"];
  if (classifyRulesPathRaw?.trim()) {
    const rulesPath = path.resolve(expandHome(classifyRulesPathRaw.trim()));
    try {
      const raw = readFileSync(rulesPath, "utf-8");
      classifyRules = ClassifyRulesSchema.parse(JSON.parse(raw));
    } catch (err) {
      throw new Error(`CLASSIFY_RULES_PATH: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    vaultPath,
    memoryDbPath,
    sqliteBusyTimeoutMs,
    namedVaults,
    periodicNotesRoot: process.env["PERIODIC_NOTES_ROOT"] ?? "Journal",
    backup: {
      enabled: process.env["ENABLE_DB_BACKUP"] !== "false",
      dir: backupDirRaw ? path.resolve(expandHome(backupDirRaw)) : path.join(vaultPath, ".vault-backups"),
      maxBackups: safeInt(process.env["DB_BACKUP_MAX_KEEP"], 5),
    },
    embedding: {
      enabled: process.env["ENABLE_EMBEDDINGS"] === "true",
      apiKey: process.env["EMBEDDING_API_KEY"] ?? "",
      endpoint: parseHttpUrlEnv("EMBEDDING_ENDPOINT"),
      model: process.env["EMBEDDING_MODEL"] ?? "text-embedding-3-small",
      hybridAlpha,
      batchSize: safeInt(process.env["EMBED_BATCH_SIZE"], 20),
      queryCacheMax: safeInt(process.env["QUERY_EMBEDDING_CACHE_MAX"], 128),
    },
    capture: {
      enableCapturePipeline: process.env["ENABLE_CAPTURE_PIPELINE"] === "true",
      logRawInput: process.env["LOG_RAW_INPUT"] === "true",
    },
    mcpPort: safeInt(process.env["MCP_PORT"], 3782),
    mcpHost: process.env["MCP_HOST"] ?? "127.0.0.1",
    mcpApiKey: process.env["MCP_API_KEY"] ?? "",
    alertWebhookUrl: parseHttpUrlEnv("ALERT_WEBHOOK_URL"),
    watcher: {
      enabled: process.env["ENABLE_FILE_WATCHER"] !== "false",
      debounceMs: safeInt(process.env["FILE_WATCHER_DEBOUNCE_MS"], 300),
    },
    acl: {
      allowPaths: parsePathList(process.env["VAULT_ALLOW_PATHS"]),
      denyPaths: parsePathList(process.env["VAULT_DENY_PATHS"]),
    },
    toolTimeoutMs: safeInt(process.env["TOOL_TIMEOUT_MS"], 30_000),
    classifyRules,
    folders: resolveVaultFolders(),
    enableOtel: process.env["ENABLE_OTEL"] === "true",
    otelEndpoint: parseHttpUrlEnv("OTEL_EXPORTER_OTLP_ENDPOINT"),
  };
}
