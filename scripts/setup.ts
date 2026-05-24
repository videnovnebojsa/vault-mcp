#!/usr/bin/env bun
/**
 * vault-mcp setup script
 * Builds the binary, walks through configuration, and installs a persistent
 * background service (launchd on macOS, systemd on Linux, Task Scheduler on Windows).
 *
 * Usage: bun run setup
 */

import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { $ } from "bun";

// ── Platform detection ────────────────────────────────────────────────────────

type Platform = "macos" | "linux" | "windows";

function detectPlatform(): Platform {
  switch (process.platform) {
    case "darwin":
      return "macos";
    case "linux":
      return "linux";
    case "win32":
      return "windows";
    default:
      return "linux";
  }
}

const PLATFORM = detectPlatform();

const CONFIG_DIR = join(homedir(), ".config", "vault-mcp");
const CONFIG_FILE = join(CONFIG_DIR, ".env");

const LOCAL_APP_DATA = process.env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local");

const BIN_DEST: Record<Platform, string> = {
  macos: join(homedir(), ".local", "bin", "vault-mcp"),
  linux: join(homedir(), ".local", "bin", "vault-mcp"),
  windows: join(LOCAL_APP_DATA, "vault-mcp", "vault-mcp.exe"),
};

const BIN_SRC = join(process.cwd(), "dist-bin", PLATFORM === "windows" ? "vault-mcp.exe" : "vault-mcp");

// ── CLI helpers ───────────────────────────────────────────────────────────────

const rl = createInterface({ input: process.stdin, output: process.stdout });

function ask(question: string): Promise<string> {
  return new Promise((res) => rl.question(question, res));
}

async function prompt(label: string, defaultValue = ""): Promise<string> {
  const hint = defaultValue ? ` [${defaultValue}]` : "";
  const answer = await ask(`    ${label}${hint}: `);
  return answer.trim() || defaultValue;
}

async function confirm(label: string, defaultYes = false): Promise<boolean> {
  const hint = defaultYes ? "Y/n" : "y/N";
  const answer = await ask(`    ${label} (${hint}): `);
  const t = answer.trim().toLowerCase();
  if (!t) return defaultYes;
  return t === "y" || t === "yes";
}

function print(msg: string): void {
  process.stdout.write(`${msg}\n`);
}
function ok(msg: string): void {
  print(`  ✔  ${msg}`);
}
function warn(msg: string): void {
  print(`  ⚠  ${msg}`);
}
function fail(msg: string): void {
  print(`  ✘  ${msg}`);
}
function section(title: string): void {
  print(`\n  ${title}\n  ${"─".repeat(title.length)}`);
}

// ── Step 1: Bun version check ─────────────────────────────────────────────────

function checkBunVersion(): void {
  const version = Bun.version;
  const [majorStr, minorStr] = version.split(".");
  const major = Number(majorStr ?? "0");
  const minor = Number(minorStr ?? "0");
  if (major < 1 || (major === 1 && minor < 3)) {
    fail(`Bun 1.3+ required, found ${version}. Install at https://bun.sh`);
    process.exit(1);
  }
  ok(`Bun ${version}`);
}

// ── Step 2: Build binary ──────────────────────────────────────────────────────

async function buildBinary(): Promise<void> {
  print("  Building binary (this takes ~30s) ...");
  try {
    await $`bun run build:bun`.quiet();
    ok("Binary built → dist-bin/vault-mcp");
  } catch {
    fail("Binary build failed. Run 'bun run build:bun' manually to see errors.");
    process.exit(1);
  }
}

// ── Step 3: Interactive config prompts ────────────────────────────────────────

function expandHome(p: string): string {
  if (p === "~" || p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

async function isPortInUse(port: number): Promise<boolean> {
  try {
    const server = Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response() });
    server.stop();
    return false;
  } catch {
    return true;
  }
}

interface ExtraVault {
  name: string;
  path: string;
}

interface SetupConfig {
  vaultPath: string;
  port: number;
  apiKey: string;
  extraVaults: ExtraVault[];
  enableEmbeddings: boolean;
  embeddingEndpoint: string;
  embeddingApiKey: string;
}

async function promptConfig(): Promise<SetupConfig> {
  section("Configuration");

  // Vault path — required, must exist
  let vaultPath = "";
  while (!vaultPath) {
    const raw = await prompt("Obsidian vault path");
    const abs = resolve(expandHome(raw || "~/Documents/obsidian"));
    if (!existsSync(abs)) {
      warn(`Path not found: ${abs}  (create it or check for typos)`);
      continue;
    }
    vaultPath = abs;
  }

  // Port — default 3782, validated
  let port = 3782;
  while (true) {
    const raw = await prompt("Port", "3782");
    const parsed = parseInt(raw, 10);
    if (Number.isNaN(parsed) || parsed < 1024 || parsed > 65535) {
      warn("Enter a valid port number (1024–65535)");
      continue;
    }
    if (await isPortInUse(parsed)) {
      warn(`Port ${parsed} is already in use. Choose another or stop the existing process.`);
      continue;
    }
    port = parsed;
    break;
  }

  // API key — optional
  const apiKey = await prompt("API key (Enter to skip — local-only use)", "");

  // Extra vaults — optional, repeatable
  const extraVaults: ExtraVault[] = [];
  if (await confirm("Add a second vault?")) {
    let addMore = true;
    while (addMore) {
      const name = await prompt("  Vault name (e.g. work)");
      let vPath = "";
      while (!vPath) {
        const raw = await prompt(`  Path for "${name}"`);
        const abs = resolve(expandHome(raw));
        if (!existsSync(abs)) {
          warn(`Path not found: ${abs}`);
          continue;
        }
        vPath = abs;
      }
      extraVaults.push({ name, path: vPath });
      addMore = await confirm("Add another vault?");
    }
  }

  // Embeddings — optional
  let enableEmbeddings = false;
  let embeddingEndpoint = "";
  let embeddingApiKey = "";
  if (await confirm("Enable vector embeddings for semantic search?")) {
    enableEmbeddings = true;
    embeddingEndpoint = await prompt("  Embedding API endpoint", "https://api.openai.com/v1");
    embeddingApiKey = await prompt("  Embedding API key");
  }

  return { vaultPath, port, apiKey, extraVaults, enableEmbeddings, embeddingEndpoint, embeddingApiKey };
}

// ── Step 4: Write .env file ───────────────────────────────────────────────────

function buildEnvFile(cfg: SetupConfig, restartCmd: string): string {
  const vaultPathsLine =
    cfg.extraVaults.length > 0
      ? `VAULT_PATHS=${cfg.extraVaults.map((v) => `${v.name}:${v.path}`).join(";")}`
      : `# VAULT_PATHS=work:~/vaults/work;archive:~/vaults/archive`;

  const apiKeyLine = cfg.apiKey
    ? `MCP_API_KEY=${cfg.apiKey}`
    : `# MCP_API_KEY=                       # Bearer token; empty = local-only`;

  const embeddingLines = cfg.enableEmbeddings
    ? [
        `ENABLE_EMBEDDINGS=true`,
        `EMBEDDING_ENDPOINT=${cfg.embeddingEndpoint}`,
        `EMBEDDING_API_KEY=${cfg.embeddingApiKey}`,
      ].join("\n")
    : [
        `# ENABLE_EMBEDDINGS=false`,
        `# EMBEDDING_ENDPOINT=               # e.g. https://api.openai.com/v1`,
        `# EMBEDDING_API_KEY=`,
      ].join("\n");

  return `# vault-mcp configuration
# Generated by setup on ${new Date().toISOString().slice(0, 10)}
# Edit this file to change settings, then restart: ${restartCmd}
# Full reference: https://github.com/videnovnebojsa/vault-mcp/blob/main/docs/CONFIGURATION.md

# ── Vault Paths ───────────────────────────────────────────────────────────────
OBSIDIAN_VAULT_PATH=${cfg.vaultPath}
${vaultPathsLine}
# MEMORY_DB_PATH=                      # default: {vault}/.vault-search.db

# ── HTTP Server ───────────────────────────────────────────────────────────────
MCP_PORT=${cfg.port}
# MCP_HOST=127.0.0.1                   # 0.0.0.0 to expose on the network
${apiKeyLine}
# MCP_HTTP_BODY_LIMIT_BYTES=1048576
# MCP_MAX_SESSIONS=100
# MCP_SESSION_IDLE_MS=1800000          # 30 minutes

# ── Vector Embeddings ─────────────────────────────────────────────────────────
${embeddingLines}
# EMBEDDING_MODEL=text-embedding-3-small
# HYBRID_ALPHA=0.5                     # 0=pure semantic, 1=pure keyword
# EMBED_BATCH_SIZE=20
# QUERY_EMBEDDING_CACHE_MAX=128

# ── Capture Pipeline ──────────────────────────────────────────────────────────
# ENABLE_CAPTURE_PIPELINE=false
# CLASSIFY_RULES_PATH=                 # path to JSON rules file
# LOG_RAW_INPUT=false

# ── Periodic Notes ────────────────────────────────────────────────────────────
# PERIODIC_NOTES_ROOT=Journal

# ── Backup ────────────────────────────────────────────────────────────────────
# ENABLE_DB_BACKUP=true
# DB_BACKUP_DIR=                       # default: {vault}/.vault-backups
# DB_BACKUP_MAX_KEEP=5

# ── File Watcher ──────────────────────────────────────────────────────────────
# ENABLE_FILE_WATCHER=true
# FILE_WATCHER_DEBOUNCE_MS=300

# ── Access Control ────────────────────────────────────────────────────────────
# VAULT_ALLOW_PATHS=                   # comma-separated vault-relative allowlist
# VAULT_DENY_PATHS=                    # comma-separated denylist (applied after allow)

# ── Logging & Monitoring ──────────────────────────────────────────────────────
# LOG_LEVEL=info                       # debug | info | warn | error
# LOG_FORMAT=text                      # text | json
# ALERT_WEBHOOK_URL=
# ENABLE_OTEL=false
# OTEL_EXPORTER_OTLP_ENDPOINT=

# ── Advanced ──────────────────────────────────────────────────────────────────
# TOOL_TIMEOUT_MS=30000                # 0 = disabled
`;
}

// ── Step 5: Install binary ────────────────────────────────────────────────────

function installBinary(): void {
  const dest = BIN_DEST[PLATFORM];
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(BIN_SRC, dest);
  if (PLATFORM !== "windows") chmodSync(dest, 0o755);
  ok(`Binary installed → ${dest}`);
}

// ── Step 6: Service installation ─────────────────────────────────────────────

async function installService(): Promise<string> {
  const binPath = BIN_DEST[PLATFORM];
  switch (PLATFORM) {
    case "macos":
      return installMacos(binPath);
    case "linux":
      return installLinux(binPath);
    case "windows":
      return installWindows(binPath);
  }
}

async function installMacos(binPath: string): Promise<string> {
  const plistDir = join(homedir(), "Library", "LaunchAgents");
  const plistPath = join(plistDir, "com.vault-mcp.plist");

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.vault-mcp</string>
  <key>ProgramArguments</key>
  <array>
    <string>${binPath}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${CONFIG_DIR}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/vault-mcp.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/vault-mcp.err</string>
</dict>
</plist>
`;

  mkdirSync(plistDir, { recursive: true });
  writeFileSync(plistPath, plist);

  // Unload first in case a previous version is running
  await $`launchctl unload ${plistPath}`.quiet().nothrow();
  await $`launchctl load ${plistPath}`.quiet();

  ok(`launchd service installed → ${plistPath}`);
  return `launchctl kickstart -k gui/$UID/com.vault-mcp`;
}

async function installLinux(binPath: string): Promise<string> {
  const unitDir = join(homedir(), ".config", "systemd", "user");
  const unitPath = join(unitDir, "vault-mcp.service");

  const unit = `[Unit]
Description=vault-mcp MCP server
After=default.target

[Service]
Type=simple
ExecStart=${binPath}
WorkingDirectory=${CONFIG_DIR}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;

  mkdirSync(unitDir, { recursive: true });
  writeFileSync(unitPath, unit);

  await $`systemctl --user daemon-reload`.quiet();
  await $`systemctl --user enable --now vault-mcp`.quiet();

  ok(`systemd user service installed → ${unitPath}`);
  return "systemctl --user restart vault-mcp";
}

async function installWindows(binPath: string): Promise<string> {
  const xmlPath = join(CONFIG_DIR, "vault-mcp-task.xml");

  // Task Scheduler XML — ONLOGON trigger, no time limit, auto-restart on failure
  const xml = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <LogonTrigger><Enabled>true</Enabled></LogonTrigger>
  </Triggers>
  <Actions Context="Author">
    <Exec>
      <Command>${binPath}</Command>
      <WorkingDirectory>${CONFIG_DIR}</WorkingDirectory>
    </Exec>
  </Actions>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
</Task>
`;

  writeFileSync(xmlPath, xml, "utf16le");
  await $`schtasks /Create /XML ${xmlPath} /TN vault-mcp /F`.quiet();
  await $`schtasks /Run /TN vault-mcp`.quiet();

  ok("Task Scheduler task registered and started");
  return "schtasks /End /TN vault-mcp && schtasks /Run /TN vault-mcp";
}

// ── Step 7: Health check ──────────────────────────────────────────────────────

async function waitForHealth(port: number): Promise<boolean> {
  process.stdout.write("  Waiting for server");
  for (let i = 0; i < 30; i++) {
    await Bun.sleep(500);
    process.stdout.write(".");
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) {
        print(" ✔");
        return true;
      }
    } catch {
      /* not up yet */
    }
  }
  print(" ✘");
  return false;
}

// ── Re-install detection ──────────────────────────────────────────────────────

async function detectMode(): Promise<"fresh" | "update" | "exit"> {
  if (!existsSync(CONFIG_FILE)) return "fresh";
  print("\n  Existing installation detected.");
  const choice = await ask("  [U]pdate config only / [R]einstall / [Q]uit: ");
  switch (choice.trim().toLowerCase()) {
    case "u":
      return "update";
    case "r":
      return "fresh";
    default:
      return "exit";
  }
}

async function restartService(): Promise<void> {
  switch (PLATFORM) {
    case "macos":
      await $`launchctl kickstart -k gui/$UID/com.vault-mcp`.quiet().nothrow();
      break;
    case "linux":
      await $`systemctl --user restart vault-mcp`.quiet().nothrow();
      break;
    case "windows":
      await $`schtasks /End /TN vault-mcp`.quiet().nothrow();
      await $`schtasks /Run /TN vault-mcp`.quiet().nothrow();
      break;
  }
  ok("Service restarted");
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  print("\n  vault-mcp installer");
  print("  ─────────────────────");

  section("Preflight");
  checkBunVersion();

  const mode = await detectMode();
  if (mode === "exit") {
    print("  Aborted.");
    rl.close();
    return;
  }

  if (mode === "fresh") {
    await buildBinary();
    installBinary();
  } else {
    ok(`Keeping existing binary at ${BIN_DEST[PLATFORM]}`);
  }

  const cfg = await promptConfig();

  // Derive restart command before writing .env (it's embedded in the header comment)
  const restartCmd =
    PLATFORM === "macos"
      ? "launchctl kickstart -k gui/$UID/com.vault-mcp"
      : PLATFORM === "linux"
        ? "systemctl --user restart vault-mcp"
        : "schtasks /End /TN vault-mcp && schtasks /Run /TN vault-mcp";

  section("Writing config");
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, buildEnvFile(cfg, restartCmd));
  ok(`Config written → ${CONFIG_FILE}`);

  section(mode === "fresh" ? "Installing service" : "Restarting service");
  if (mode === "fresh") {
    await installService();
  } else {
    await restartService();
  }

  section("Health check");
  const healthy = await waitForHealth(cfg.port);
  if (!healthy) {
    warn("Server did not respond in 15s.");
    if (PLATFORM === "macos") warn("Check logs: tail -f /tmp/vault-mcp.err");
    if (PLATFORM === "linux") warn("Check logs: journalctl --user -u vault-mcp -f");
    if (PLATFORM === "windows") warn("Check logs: Task Scheduler → vault-mcp → History");
  }

  const bridgePath = join(process.cwd(), "bin", "stdio-bridge.ts");

  section("Done");
  print(`
  Connect Claude Code — add to .mcp.json in your project root:

    {
      "mcpServers": {
        "vault": { "type": "http", "url": "http://127.0.0.1:${cfg.port}/mcp" }
      }
    }

  Connect Claude Desktop — add to claude_desktop_config.json:

    {
      "mcpServers": {
        "vault": {
          "command": "bun",
          "args": ["${bridgePath}"],
          "env": { "VAULT_MCP_URL": "http://127.0.0.1:${cfg.port}/mcp" }
        }
      }
    }

  To change settings later:
    edit  ${CONFIG_FILE}
    then  ${restartCmd}
`);

  rl.close();
}

main().catch((e) => {
  fail(String(e));
  rl.close();
  process.exit(1);
});
