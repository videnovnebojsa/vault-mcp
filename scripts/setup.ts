#!/usr/bin/env bun
/**
 * vault-mcp setup script
 * Builds the binary, walks through configuration, and installs a persistent
 * background service (launchd on macOS, systemd on Linux, Task Scheduler on Windows).
 *
 * Usage: bun run setup
 */

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { $ } from "bun";
import { resolveVaultFolders } from "../src/config/folders.js";

import {
  ask,
  BIN_DEST,
  BIN_SRC,
  CONFIG_DIR,
  CONFIG_FILE,
  closeReadline,
  confirm,
  expandHome,
  fail,
  isPortInUse,
  LOG_DIR,
  LOG_ERR_FILE,
  LOG_FILE,
  ok,
  PLATFORM,
  print,
  prompt,
  restartCommand,
  restartService,
  section,
  waitForHealth,
  warn,
} from "./lib/cli-helpers.ts";
import { writeEnvFile } from "./lib/env-io.ts";

// Re-export for test compat (src/setup-script.test.ts imports these)
export { expandHome } from "./lib/cli-helpers.ts";

/**
 * Create vault folders inside `vaultPath`. Returns the list of names created.
 * Throws with the folder name in the message if any `mkdirSync` call fails.
 */
export function createVaultFolders(vaultPath: string, folderNames: string[]): string[] {
  const created: string[] = [];
  for (const folderName of folderNames) {
    try {
      mkdirSync(join(vaultPath, folderName), { recursive: true });
      created.push(folderName);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to create folder "${folderName}" in ${vaultPath}: ${msg}`);
    }
  }
  return created;
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
    await $`bun run build:bun`;
    ok("Binary built → dist-bin/vault-mcp");
  } catch {
    fail("Binary build failed. See the build output above for the compiler error.");
    process.exit(1);
  }
}

// ── Step 3: Interactive config prompts ────────────────────────────────────────

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

interface ExistingSetupConfig {
  vaultPath?: string;
  port?: number;
}

export function readExistingConfig(configFile = CONFIG_FILE): ExistingSetupConfig {
  if (!existsSync(configFile)) return {};

  const config: ExistingSetupConfig = {};
  const env = readFileSync(configFile, "utf8");
  for (const line of env.split("\n")) {
    if (!line || line.startsWith("#")) continue;

    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) continue;
    const key = line.slice(0, separatorIndex);
    const value = line.slice(separatorIndex + 1).trim();

    if (key === "OBSIDIAN_VAULT_PATH" && value) config.vaultPath = value;
    if (key === "MCP_PORT") {
      const port = Number.parseInt(value, 10);
      if (!Number.isNaN(port)) config.port = port;
    }
  }

  return config;
}

function shouldAllowPortReuse(port: number, existingPort?: number): boolean {
  return existingPort !== undefined && existingPort === port;
}

async function promptConfig(existingConfig: ExistingSetupConfig = {}): Promise<SetupConfig> {
  section("Configuration");

  const defaultVaultPath = existingConfig.vaultPath ?? "~/Documents/obsidian";
  const defaultPort = String(existingConfig.port ?? 3782);

  // Vault path — required, must exist
  let vaultPath = "";
  while (!vaultPath) {
    const raw = await prompt("Obsidian vault path", defaultVaultPath);
    const abs = resolve(expandHome(raw));
    if (!existsSync(abs)) {
      warn(`Path not found: ${abs}  (create it or check for typos)`);
      continue;
    }
    vaultPath = abs;
  }

  // Offer to create the recommended folder structure.
  // If some folders already exist, warn so users aren't surprised (e.g. partial
  // setup, pre-existing vault with custom names, or a re-run after partial failure).
  const defaultFolderNames = Object.values(resolveVaultFolders());
  const existingCount = defaultFolderNames.filter((f) => existsSync(join(vaultPath, f))).length;
  const missingCount = defaultFolderNames.length - existingCount;
  if (existingCount > 0 && missingCount > 0) {
    warn(
      `${existingCount} of ${defaultFolderNames.length} recommended folders already exist; ${missingCount} are missing.`,
    );
  }
  if (missingCount > 0) {
    if (await confirm("Create the recommended folder structure in your vault?")) {
      createVaultFolders(vaultPath, defaultFolderNames);
      ok(`Created ${defaultFolderNames.length} folders in ${vaultPath}`);
    }
  }

  // Port — default 3782, validated
  let port = 3782;
  while (true) {
    const raw = await prompt("Port", defaultPort);
    const parsed = parseInt(raw, 10);
    if (Number.isNaN(parsed) || parsed < 1024 || parsed > 65535) {
      warn("Enter a valid port number (1024–65535)");
      continue;
    }
    if (await isPortInUse(parsed)) {
      if (shouldAllowPortReuse(parsed, existingConfig.port)) {
        ok(`Port ${parsed} is already in use by the existing vault-mcp service; reusing it.`);
        port = parsed;
        break;
      }
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

  return {
    vaultPath,
    port,
    apiKey,
    extraVaults,
    enableEmbeddings,
    embeddingEndpoint,
    embeddingApiKey,
  };
}

// ── Step 4: Write .env file ───────────────────────────────────────────────────

/** Convert a SetupConfig into a flat Map of env var values. */
function cfgToMap(cfg: SetupConfig): Map<string, string> {
  const values = new Map<string, string>();
  values.set("OBSIDIAN_VAULT_PATH", cfg.vaultPath);
  values.set("MCP_PORT", String(cfg.port));
  if (cfg.apiKey) values.set("MCP_API_KEY", cfg.apiKey);
  if (cfg.extraVaults.length > 0) {
    values.set("VAULT_PATHS", cfg.extraVaults.map((v) => `${v.name}:${v.path}`).join(";"));
  }
  if (cfg.enableEmbeddings) {
    values.set("ENABLE_EMBEDDINGS", "true");
    values.set("EMBEDDING_ENDPOINT", cfg.embeddingEndpoint);
    values.set("EMBEDDING_API_KEY", cfg.embeddingApiKey);
  }
  return values;
}

function ensureLogDir(): void {
  mkdirSync(LOG_DIR, { recursive: true });
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

async function installService(): Promise<void> {
  const binPath = BIN_DEST[PLATFORM];
  switch (PLATFORM) {
    case "macos":
      await installMacos(binPath);
      break;
    case "linux":
      await installLinux(binPath);
      break;
    case "windows":
      await installWindows(binPath);
      break;
  }
}

async function installMacos(binPath: string): Promise<void> {
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
  <string>${LOG_FILE}</string>
  <key>StandardErrorPath</key>
  <string>${LOG_ERR_FILE}</string>
</dict>
</plist>
`;

  ensureLogDir();
  mkdirSync(plistDir, { recursive: true });
  writeFileSync(plistPath, plist);

  await $`launchctl unload ${plistPath}`.quiet().nothrow();
  await $`launchctl load ${plistPath}`.quiet();

  ok(`launchd service installed → ${plistPath}`);
}

async function installLinux(binPath: string): Promise<void> {
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
}

async function installWindows(binPath: string): Promise<void> {
  const xmlPath = join(CONFIG_DIR, "vault-mcp-task.xml");

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

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  print("\n  vault-mcp installer");
  print("  ─────────────────────");

  section("Preflight");
  checkBunVersion();

  const mode = await detectMode();
  const existingConfig = readExistingConfig();
  if (mode === "exit") {
    print("  Aborted.");
    closeReadline();
    return;
  }

  if (mode === "fresh") {
    await buildBinary();
    installBinary();
  } else {
    ok(`Keeping existing binary at ${BIN_DEST[PLATFORM]}`);
  }

  const cfg = await promptConfig(existingConfig);
  const restartCmd = restartCommand();

  section("Writing config");
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeEnvFile(CONFIG_FILE, cfgToMap(cfg), restartCmd);
  ok(`Config written → ${CONFIG_FILE}`);

  const shouldRefreshService = mode === "fresh" || PLATFORM === "macos";
  section(shouldRefreshService ? "Installing service" : "Restarting service");
  if (shouldRefreshService) {
    await installService();
  } else {
    await restartService();
  }

  section("Health check");
  const healthy = await waitForHealth(cfg.port);
  if (!healthy) {
    warn("Server did not respond in 15s.");
    if (PLATFORM === "macos") warn(`Check logs: tail -f ${LOG_ERR_FILE}`);
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
    bun run configure
    edit  ${CONFIG_FILE}
    then  ${restartCmd}
`);

  closeReadline();
}

if (import.meta.main) {
  main().catch((e) => {
    fail(String(e));
    closeReadline();
    process.exit(1);
  });
}
