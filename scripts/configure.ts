#!/usr/bin/env bun
/**
 * vault-mcp configure script
 * Interactively update any subset of settings in ~/.config/vault-mcp/.env
 * without touching the installed binary or service.
 *
 * Usage:
 *   bun run configure
 *   bun run configure -- --section embeddings
 */

import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

import {
  ask,
  CONFIG_DIR,
  CONFIG_FILE,
  closeReadline,
  expandHome,
  fail,
  isPortInUse,
  isServiceInstalled,
  LOG_ERR_FILE,
  ok,
  PLATFORM,
  print,
  restartCommand,
  restartService,
  section,
  waitForHealth,
  warn,
} from "./lib/cli-helpers.ts";
import { parseEnvFile, writeEnvFile } from "./lib/env-io.ts";

// ── Setting types ─────────────────────────────────────────────────────────────

type SettingType =
  | "string"
  | "path" // filesystem path; pathMustExist controls existsSync check
  | "port" // integer 1024–65535; async port-in-use check
  | "boolean" // "true" | "false"
  | "integer"
  | "float"
  | "http_url" // http:// or https:// only
  | "path_list" // comma-separated paths (no existence check)
  | "vault_paths"; // semicolon-separated name:path pairs

interface Setting {
  key: string;
  label: string;
  type: SettingType;
  default: string; // shown as hint when value is absent
  description: string;
  optional?: boolean; // "." clears the value (comments it out)
  pathMustExist?: boolean; // for type "path"
  intRange?: [number, number];
  floatRange?: [number, number];
}

interface Section {
  id: string;
  title: string;
  settings: Setting[];
}

// ── Section registry ──────────────────────────────────────────────────────────

export const SECTIONS: Section[] = [
  {
    id: "vault-paths",
    title: "Vault Paths",
    settings: [
      {
        key: "OBSIDIAN_VAULT_PATH",
        label: "Primary Obsidian vault path",
        type: "path",
        default: "~/Documents/obsidian",
        description: "Absolute path to your main Obsidian vault folder.",
        pathMustExist: true,
      },
      {
        key: "VAULT_PATHS",
        label: "Additional named vaults",
        type: "vault_paths",
        default: "",
        description: "Semicolon-separated name:path pairs, e.g. work:~/vaults/work;archive:~/vaults/archive",
        optional: true,
      },
      {
        key: "MEMORY_DB_PATH",
        label: "SQLite index path",
        type: "path",
        default: "{vault}/.vault-search.db",
        description: "Override where the search database is stored. Leave blank for the default.",
        optional: true,
        pathMustExist: false,
      },
    ],
  },
  {
    id: "network",
    title: "HTTP Server",
    settings: [
      {
        key: "MCP_PORT",
        label: "HTTP port",
        type: "port",
        default: "3782",
        description: "Port the MCP server listens on (1024–65535).",
      },
      {
        key: "MCP_HOST",
        label: "Bind address",
        type: "string",
        default: "127.0.0.1",
        description: "Use 0.0.0.0 to expose on the local network.",
        optional: true,
      },
      {
        key: "MCP_API_KEY",
        label: "API key (Bearer token)",
        type: "string",
        default: "",
        description: "Leave blank for local-only use (no auth).",
        optional: true,
      },
      {
        key: "MCP_HTTP_BODY_LIMIT_BYTES",
        label: "Max request body (bytes)",
        type: "integer",
        default: "1048576",
        description: "Maximum HTTP request body size in bytes.",
        optional: true,
        intRange: [1024, 104857600],
      },
      {
        key: "MCP_MAX_SESSIONS",
        label: "Max concurrent sessions",
        type: "integer",
        default: "100",
        description: "Maximum number of simultaneous MCP sessions.",
        optional: true,
        intRange: [1, 10000],
      },
      {
        key: "MCP_SESSION_IDLE_MS",
        label: "Session idle timeout (ms)",
        type: "integer",
        default: "1800000",
        description: "Milliseconds before an idle session is closed (default 30 min).",
        optional: true,
        intRange: [0, 86400000],
      },
    ],
  },
  {
    id: "embeddings",
    title: "Vector Embeddings",
    settings: [
      {
        key: "ENABLE_EMBEDDINGS",
        label: "Enable vector embeddings",
        type: "boolean",
        default: "false",
        description: "Set true to enable semantic / hybrid search.",
      },
      {
        key: "EMBEDDING_API_KEY",
        label: "Embedding API key",
        type: "string",
        default: "",
        description: "API key for your embedding provider.",
        optional: true,
      },
      {
        key: "EMBEDDING_ENDPOINT",
        label: "Embedding API endpoint",
        type: "http_url",
        default: "",
        description: "Base URL for the OpenAI-compatible embedding endpoint.",
        optional: true,
      },
      {
        key: "EMBEDDING_MODEL",
        label: "Embedding model",
        type: "string",
        default: "text-embedding-3-small",
        description: "Model name passed to the embedding endpoint.",
        optional: true,
      },
      {
        key: "HYBRID_ALPHA",
        label: "Hybrid search blend (0–1)",
        type: "float",
        default: "0.5",
        description: "0 = pure semantic, 1 = pure keyword.",
        optional: true,
        floatRange: [0, 1],
      },
      {
        key: "EMBED_BATCH_SIZE",
        label: "Embedding batch size",
        type: "integer",
        default: "20",
        description: "Notes per embedding API request.",
        optional: true,
        intRange: [1, 500],
      },
      {
        key: "QUERY_EMBEDDING_CACHE_MAX",
        label: "Query embedding cache size",
        type: "integer",
        default: "128",
        description: "Number of query embeddings to cache in memory.",
        optional: true,
        intRange: [0, 10000],
      },
    ],
  },
  {
    id: "capture",
    title: "Capture Pipeline",
    settings: [
      {
        key: "ENABLE_CAPTURE_PIPELINE",
        label: "Enable capture pipeline",
        type: "boolean",
        default: "false",
        description: "Enables the vault_capture tool with AI-powered classification.",
      },
      {
        key: "CLASSIFY_RULES_PATH",
        label: "Classification rules file",
        type: "path",
        default: "",
        description: "Path to a JSON file with custom classification rules.",
        optional: true,
        pathMustExist: false,
      },
      {
        key: "LOG_RAW_INPUT",
        label: "Log raw capture input",
        type: "boolean",
        default: "false",
        description: "Debug option: log unprocessed capture content.",
      },
    ],
  },
  {
    id: "backup",
    title: "Backup",
    settings: [
      {
        key: "ENABLE_DB_BACKUP",
        label: "Enable automatic backups",
        type: "boolean",
        default: "true",
        description: "Automatically back up the SQLite search index.",
      },
      {
        key: "DB_BACKUP_DIR",
        label: "Backup directory",
        type: "path",
        default: "{vault}/.vault-backups",
        description: "Where to store backup files. Leave blank for the default.",
        optional: true,
        pathMustExist: false,
      },
      {
        key: "DB_BACKUP_MAX_KEEP",
        label: "Backups to retain",
        type: "integer",
        default: "5",
        description: "Number of recent backups to keep before rotation.",
        optional: true,
        intRange: [1, 1000],
      },
    ],
  },
  {
    id: "watcher",
    title: "File Watcher",
    settings: [
      {
        key: "ENABLE_FILE_WATCHER",
        label: "Enable file watcher",
        type: "boolean",
        default: "true",
        description: "Watch the vault for changes and sync the index automatically.",
      },
      {
        key: "FILE_WATCHER_DEBOUNCE_MS",
        label: "Debounce delay (ms)",
        type: "integer",
        default: "300",
        description: "Milliseconds to wait after a file event before processing.",
        optional: true,
        intRange: [0, 60000],
      },
    ],
  },
  {
    id: "access",
    title: "Access Control",
    settings: [
      {
        key: "VAULT_ALLOW_PATHS",
        label: "Allowed paths (allowlist)",
        type: "path_list",
        default: "",
        description: "Comma-separated vault-relative paths. If set, only these are accessible.",
        optional: true,
      },
      {
        key: "VAULT_DENY_PATHS",
        label: "Denied paths (denylist)",
        type: "path_list",
        default: "",
        description: "Comma-separated vault-relative paths to block (applied after allow).",
        optional: true,
      },
    ],
  },
  {
    id: "logging",
    title: "Logging & Monitoring",
    settings: [
      {
        key: "LOG_LEVEL",
        label: "Log level",
        type: "string",
        default: "info",
        description: "Verbosity: debug | info | warn | error",
        optional: true,
      },
      {
        key: "LOG_FORMAT",
        label: "Log format",
        type: "string",
        default: "text",
        description: "Output format: text | json",
        optional: true,
      },
      {
        key: "ALERT_WEBHOOK_URL",
        label: "Alert webhook URL",
        type: "http_url",
        default: "",
        description: "POST alerts here on errors (http/https).",
        optional: true,
      },
      {
        key: "ENABLE_OTEL",
        label: "Enable OpenTelemetry",
        type: "boolean",
        default: "false",
        description: "Emit OTLP spans per tool call.",
      },
      {
        key: "OTEL_EXPORTER_OTLP_ENDPOINT",
        label: "OTLP exporter endpoint",
        type: "http_url",
        default: "",
        description: "Endpoint for the OpenTelemetry OTLP exporter.",
        optional: true,
      },
    ],
  },
  {
    id: "advanced",
    title: "Advanced",
    settings: [
      {
        key: "TOOL_TIMEOUT_MS",
        label: "Tool call timeout (ms)",
        type: "integer",
        default: "30000",
        description: "Maximum milliseconds per tool call. 0 = disabled.",
        optional: true,
        intRange: [0, 600000],
      },
      {
        key: "PERIODIC_NOTES_ROOT",
        label: "Periodic notes root folder",
        type: "string",
        default: "Journal",
        description: "Vault folder that contains daily/weekly/monthly notes.",
        optional: true,
      },
    ],
  },
];

// ── Secret masking ────────────────────────────────────────────────────────────

const SECRET_KEYS = new Set(["MCP_API_KEY", "EMBEDDING_API_KEY"]);

function maskIfSecret(key: string, value: string): string {
  if (!SECRET_KEYS.has(key)) return value;
  if (!value || value === "(not set)" || value === "(cleared)") return value;
  if (value.length <= 6) return "••••••";
  return `${value.slice(0, 4)}${"•".repeat(Math.min(value.length - 4, 20))}`;
}

// ── Validation ────────────────────────────────────────────────────────────────

/**
 * Validate a raw string for the given setting.
 * Returns an error message string, or null if valid.
 * `currentPort` is the port in the current config (to skip in-use check for unchanged ports).
 */
export async function validateSetting(setting: Setting, raw: string, currentPort?: string): Promise<string | null> {
  switch (setting.type) {
    case "path": {
      if (!setting.pathMustExist) return null;
      const abs = resolve(expandHome(raw));
      if (!existsSync(abs)) return `Path not found: ${abs}  (create it or check for typos)`;
      return null;
    }

    case "port": {
      const p = parseInt(raw, 10);
      if (Number.isNaN(p) || p < 1024 || p > 65535) return "Port must be a number between 1024 and 65535";
      // Skip in-use check if port is unchanged (the existing service holds it)
      if (raw === currentPort) return null;
      if (await isPortInUse(p)) return `Port ${p} is already in use`;
      return null;
    }

    case "boolean": {
      const v = raw.toLowerCase();
      if (v !== "true" && v !== "false") return 'Must be "true" or "false"';
      return null;
    }

    case "integer": {
      const n = parseInt(raw, 10);
      // Reject fractions: parseInt("3.14") = 3 but parseFloat("3.14") = 3.14
      if (Number.isNaN(n) || n !== parseFloat(raw)) return "Must be a whole number";
      if (setting.intRange) {
        const [min, max] = setting.intRange;
        if (n < min || n > max) return `Must be between ${min} and ${max}`;
      }
      return null;
    }

    case "float": {
      const f = parseFloat(raw);
      if (Number.isNaN(f)) return "Must be a number";
      if (setting.floatRange) {
        const [min, max] = setting.floatRange;
        if (f < min || f > max) return `Must be between ${min} and ${max}`;
      }
      return null;
    }

    case "http_url": {
      try {
        const url = new URL(raw);
        if (!["http:", "https:"].includes(url.protocol)) return "Must be an http:// or https:// URL";
      } catch {
        return "Invalid URL — must start with http:// or https://";
      }
      return null;
    }

    case "vault_paths": {
      for (const segment of raw.split(";")) {
        const trimmed = segment.trim();
        if (!trimmed) continue;
        const colonIdx = trimmed.indexOf(":");
        if (colonIdx === -1) return `Invalid format in "${trimmed}" — expected name:path (e.g. work:~/vaults/work)`;
        const name = trimmed.slice(0, colonIdx).trim();
        const vaultPath = trimmed.slice(colonIdx + 1).trim();
        if (!/^[a-zA-Z0-9_-]+$/.test(name))
          return `Invalid vault name "${name}" — use letters, numbers, hyphens, underscores`;
        const abs = resolve(expandHome(vaultPath));
        if (!existsSync(abs)) return `Vault path not found: ${abs}`;
      }
      return null;
    }

    case "string":
    case "path_list":
    default:
      return null;
  }
}

// ── Per-setting prompt ────────────────────────────────────────────────────────

async function promptSetting(s: Setting, pending: Map<string, string>, currentPort: string | undefined): Promise<void> {
  const currentValue = pending.get(s.key);
  const displayCurrent = currentValue !== undefined ? maskIfSecret(s.key, currentValue) : "(not set)";

  print(`\n  ${s.key} — ${s.label}`);
  print(`  ${s.description}`);

  if (s.type === "boolean") {
    const isCurrent = currentValue?.toLowerCase() === "true";
    print(`  Current: ${displayCurrent}`);
    const answer = (await ask(`    Flip to ${isCurrent ? "false" : "true"}? (y/N): `)).trim().toLowerCase();
    if (answer === "y" || answer === "yes") {
      pending.set(s.key, isCurrent ? "false" : "true");
    }
    return;
  }

  print(`  Current: ${displayCurrent}`);
  const isOptional = s.optional !== false;
  const clearHint = isOptional ? ", . to clear" : "";
  const askLine = `    New value [Enter=keep${clearHint}]: `;

  while (true) {
    const raw = (await ask(askLine)).trim();

    if (!raw) return; // keep current

    if (raw === "." && isOptional) {
      pending.delete(s.key);
      ok(`${s.key} cleared`);
      return;
    }

    const err = await validateSetting(s, raw, currentPort);
    if (err) {
      warn(err);
      continue;
    }

    pending.set(s.key, raw);
    return;
  }
}

// ── Section walker ────────────────────────────────────────────────────────────

async function promptSection(sec: Section, pending: Map<string, string>, idx: number, total: number): Promise<void> {
  section(`${sec.title}  (${idx + 1}/${total})`);

  const currentPort = pending.get("MCP_PORT");

  for (const s of sec.settings) {
    await promptSetting(s, pending, currentPort);
  }
}

// ── Section menu ──────────────────────────────────────────────────────────────

async function pickSections(): Promise<Section[]> {
  section("Which sections do you want to configure?");
  print("");

  const half = Math.ceil(SECTIONS.length / 2);
  for (let i = 0; i < half; i++) {
    const left = `  ${i + 1}) ${SECTIONS[i]!.title}`;
    const right = SECTIONS[i + half] ? `${i + half + 1}) ${SECTIONS[i + half]!.title}` : "";
    print(left.padEnd(36) + right);
  }
  print("\n  0) All sections\n");

  while (true) {
    const raw = (await ask("  Enter numbers separated by commas (e.g. 1,3) or 0 for all: ")).trim();

    if (!raw) continue;

    if (raw === "0") return SECTIONS;

    const parsed = raw
      .split(",")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => !Number.isNaN(n) && n >= 1 && n <= SECTIONS.length);

    if (parsed.length === 0) {
      warn(`Enter numbers from 1–${SECTIONS.length}, or 0 for all`);
      continue;
    }

    return [...new Set(parsed)].sort((a, b) => a - b).map((n) => SECTIONS[n - 1]!);
  }
}

// ── Diff ──────────────────────────────────────────────────────────────────────

interface Change {
  key: string;
  was: string;
  is: string;
}

export function computeChanges(original: Map<string, string>, pending: Map<string, string>): Change[] {
  const allKeys = new Set([...original.keys(), ...pending.keys()]);
  const changes: Change[] = [];

  for (const key of allKeys) {
    const was = original.get(key);
    const is = pending.get(key);
    if (was !== is) {
      changes.push({
        key,
        was: maskIfSecret(key, was ?? "(not set)"),
        is: maskIfSecret(key, is ?? "(cleared)"),
      });
    }
  }

  return changes.sort((a, b) => a.key.localeCompare(b.key));
}

export function showDiff(original: Map<string, string>, pending: Map<string, string>): boolean {
  const changes = computeChanges(original, pending);

  section("Summary of changes");

  if (changes.length === 0) {
    print("  No changes made.");
    return false;
  }

  const keyWidth = Math.max(...changes.map((c) => c.key.length));
  const wasWidth = Math.max(...changes.map((c) => c.was.length));

  for (const { key, was, is } of changes) {
    print(`  ${key.padEnd(keyWidth)}  ${was.padEnd(wasWidth)}  →  ${is}`);
  }

  return true;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  process.on("SIGINT", () => {
    print("\n\n  Cancelled.");
    closeReadline();
    process.exit(0);
  });

  print("\n  vault-mcp configure");
  print("  ─────────────────────");

  // --section <id> flag: skip menu and jump to a single section
  const sectionFlagIdx = process.argv.indexOf("--section");
  const sectionArg = sectionFlagIdx !== -1 ? process.argv[sectionFlagIdx + 1] : undefined;

  // Load current config
  let original: Map<string, string>;
  if (existsSync(CONFIG_FILE)) {
    original = parseEnvFile(CONFIG_FILE);
    ok(`Config loaded → ${CONFIG_FILE}`);
  } else {
    original = new Map();
    warn(`No config found at ${CONFIG_FILE} — starting fresh`);
    warn(`Run bun run setup first to install the service`);
  }

  // Select sections
  let selectedSections: Section[];
  if (sectionArg) {
    const found = SECTIONS.find((s) => s.id === sectionArg);
    if (!found) {
      fail(`Unknown section: "${sectionArg}". Valid sections: ${SECTIONS.map((s) => s.id).join(", ")}`);
      closeReadline();
      process.exit(1);
    }
    selectedSections = [found];
  } else {
    selectedSections = await pickSections();
  }

  // Walk through sections — pending starts as a copy of original
  const pending = new Map(original);
  for (let i = 0; i < selectedSections.length; i++) {
    await promptSection(selectedSections[i]!, pending, i, selectedSections.length);
  }

  // Show diff
  print("");
  const hasChanges = showDiff(original, pending);

  if (!hasChanges) {
    print("\n  Nothing to save.");
    closeReadline();
    return;
  }

  // Action prompt
  const serviceInstalled = isServiceInstalled();
  const actionOptions = serviceInstalled ? "[S]ave  /  [A]pply (save + restart)  /  [C]ancel" : "[S]ave  /  [C]ancel";

  if (!serviceInstalled) {
    print("\n  (Service not detected — Apply unavailable. Save writes the config file only.)");
  }

  let action = "";
  while (true) {
    action = (await ask(`\n  ${actionOptions}: `)).trim().toLowerCase();
    if (action === "s" || action === "c") break;
    if (serviceInstalled && action === "a") break;
    print("  Please press S, A, or C");
  }

  if (action === "c") {
    print("\n  Cancelled. No changes written.");
    closeReadline();
    return;
  }

  // Write config
  mkdirSync(CONFIG_DIR, { recursive: true });
  const restartCmd = restartCommand();
  writeEnvFile(CONFIG_FILE, pending, restartCmd);
  ok(`Config saved → ${CONFIG_FILE}`);

  if (action === "a") {
    section("Restarting service");
    await restartService();

    const portStr = pending.get("MCP_PORT") ?? "3782";
    const port = parseInt(portStr, 10) || 3782;

    section("Health check");
    const healthy = await waitForHealth(port);
    if (!healthy) {
      warn("Server did not respond in 15s.");
      if (PLATFORM === "macos") warn(`Check logs: tail -f ${LOG_ERR_FILE}`);
      if (PLATFORM === "linux") warn("Check logs: journalctl --user -u vault-mcp -f");
      if (PLATFORM === "windows") warn("Check logs: Task Scheduler → vault-mcp → History");
    }
  }

  print(`\n  To restart manually: ${restartCmd}\n`);
  closeReadline();
}

if (import.meta.main) {
  main().catch((e) => {
    fail(String(e));
    closeReadline();
    process.exit(1);
  });
}
