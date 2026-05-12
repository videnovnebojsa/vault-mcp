import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";

export interface WatcherConfig {
  enabled: boolean;
  debounceMs: number;
}

export interface BackupConfig {
  enabled: boolean;
  dir: string;
  maxBackups: number;
  intervalHours: number;
}

export interface EmbeddingConfig {
  enabled: boolean;
  apiKey: string;
  endpoint: string;
  model: string;
  hybridAlpha: number;
  batchSize: number;
  intervalMinutes: number;
}

export interface CaptureConfig {
  enableCapturePipeline: boolean;
  logRawInput: boolean;
}

export interface ClassifyRuleEntry {
  keywords: string[];
  folder: string;
}

export type ClassifyRules = Record<string, ClassifyRuleEntry>;

export interface VaultConfig {
  vaultPath: string;
  memoryDbPath: string;
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

function safeInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = parseInt(value, 10);
  return Number.isNaN(n) ? fallback : n;
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
    namedVaults,
    periodicNotesRoot: process.env["PERIODIC_NOTES_ROOT"] ?? "Journal",
    backup: {
      enabled: process.env["ENABLE_DB_BACKUP"] !== "false",
      dir: backupDirRaw ? path.resolve(expandHome(backupDirRaw)) : path.join(vaultPath, ".vault-backups"),
      maxBackups: safeInt(process.env["DB_BACKUP_MAX_KEEP"], 5),
      intervalHours: safeInt(process.env["DB_BACKUP_INTERVAL_HOURS"], 24),
    },
    embedding: {
      enabled: process.env["ENABLE_EMBEDDINGS"] === "true",
      apiKey: process.env["EMBEDDING_API_KEY"] ?? "",
      endpoint: process.env["EMBEDDING_ENDPOINT"] ?? "",
      model: process.env["EMBEDDING_MODEL"] ?? "text-embedding-3-small",
      hybridAlpha,
      batchSize: safeInt(process.env["EMBED_BATCH_SIZE"], 20),
      intervalMinutes: safeInt(process.env["EMBED_INTERVAL_MINUTES"], 30),
    },
    capture: {
      enableCapturePipeline: process.env["ENABLE_CAPTURE_PIPELINE"] === "true",
      logRawInput: process.env["LOG_RAW_INPUT"] === "true",
    },
    mcpPort: safeInt(process.env["MCP_PORT"], 3782),
    mcpHost: process.env["MCP_HOST"] ?? "127.0.0.1",
    mcpApiKey: process.env["MCP_API_KEY"] ?? "",
    alertWebhookUrl: process.env["ALERT_WEBHOOK_URL"] ?? "",
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
    enableOtel: process.env["ENABLE_OTEL"] === "true",
    otelEndpoint: process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] ?? "",
  };
}
