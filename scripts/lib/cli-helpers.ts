/**
 * Shared CLI helpers for vault-mcp scripts.
 * Provides readline I/O, print utilities, platform detection,
 * path expansion, port probing, and service management —
 * reused by both setup.ts and configure.ts.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { $ } from "bun";

// ── Platform detection ────────────────────────────────────────────────────────

export type Platform = "macos" | "linux" | "windows";

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

export const PLATFORM = detectPlatform();

const LOCAL_APP_DATA = process.env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local");

export const CONFIG_DIR = join(homedir(), ".config", "vault-mcp");
export const CONFIG_FILE = join(CONFIG_DIR, ".env");
export const LOG_DIR =
  PLATFORM === "macos" ? join(homedir(), "Library", "Logs", "vault-mcp") : join(CONFIG_DIR, "logs");
export const LOG_FILE = join(LOG_DIR, "vault-mcp.log");
export const LOG_ERR_FILE = join(LOG_DIR, "vault-mcp.err");

export const BIN_DEST: Record<Platform, string> = {
  macos: join(homedir(), ".local", "bin", "vault-mcp"),
  linux: join(homedir(), ".local", "bin", "vault-mcp"),
  windows: join(LOCAL_APP_DATA, "vault-mcp", "vault-mcp.exe"),
};

export const BIN_SRC = join(process.cwd(), "dist-bin", PLATFORM === "windows" ? "vault-mcp.exe" : "vault-mcp");

/** Returns the platform-specific command to restart the service. */
export function restartCommand(): string {
  return PLATFORM === "macos"
    ? "launchctl kickstart -k gui/$UID/com.vault-mcp"
    : PLATFORM === "linux"
      ? "systemctl --user restart vault-mcp"
      : "schtasks /End /TN vault-mcp && schtasks /Run /TN vault-mcp";
}

// ── Readline I/O ──────────────────────────────────────────────────────────────

let rl: Interface | null = null;

function ensureReadline(): Interface {
  rl ??= createInterface({ input: process.stdin, output: process.stdout });
  return rl;
}

export function closeReadline(): void {
  rl?.close();
  rl = null;
}

export function ask(question: string): Promise<string> {
  return new Promise((res) => ensureReadline().question(question, res));
}

export async function prompt(label: string, defaultValue = ""): Promise<string> {
  const hint = defaultValue ? ` [${defaultValue}]` : "";
  const answer = await ask(`    ${label}${hint}: `);
  return answer.trim() || defaultValue;
}

export async function confirm(label: string, defaultYes = false): Promise<boolean> {
  const hint = defaultYes ? "Y/n" : "y/N";
  const answer = await ask(`    ${label} (${hint}): `);
  const t = answer.trim().toLowerCase();
  if (!t) return defaultYes;
  return t === "y" || t === "yes";
}

// ── Output formatting ─────────────────────────────────────────────────────────

export function print(msg: string): void {
  process.stdout.write(`${msg}\n`);
}
export function ok(msg: string): void {
  print(`  ✔  ${msg}`);
}
export function warn(msg: string): void {
  print(`  ⚠  ${msg}`);
}
export function fail(msg: string): void {
  print(`  ✘  ${msg}`);
}
export function section(title: string): void {
  print(`\n  ${title}\n  ${"─".repeat(title.length)}`);
}

// ── Path helpers ──────────────────────────────────────────────────────────────

function lookupHomeDir(username: string): string | null {
  if (PLATFORM === "windows") return null;
  if (username === userInfo().username) return homedir();
  try {
    const passwd = readFileSync("/etc/passwd", "utf8");
    for (const line of passwd.split("\n")) {
      if (!line) continue;
      const [name, , , , , home] = line.split(":");
      if (name === username && home) return home;
    }
  } catch {
    return null;
  }
  return null;
}

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  if (!p.startsWith("~")) return p;
  const slashIndex = p.indexOf("/");
  const username = p.slice(1, slashIndex === -1 ? undefined : slashIndex);
  const remainder = slashIndex === -1 ? "" : p.slice(slashIndex + 1);
  const home = lookupHomeDir(username);
  if (!home) return p;
  if (!remainder) return home;
  return join(home, remainder);
}

// ── Port helpers ──────────────────────────────────────────────────────────────

export async function isPortInUse(port: number): Promise<boolean> {
  try {
    const server = Bun.serve({
      port,
      hostname: "127.0.0.1",
      fetch: () => new Response(),
    });
    server.stop();
    return false;
  } catch {
    return true;
  }
}

// ── Service management ────────────────────────────────────────────────────────

export async function restartService(): Promise<void> {
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

export async function waitForHealth(port: number): Promise<boolean> {
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

/** Returns true if a vault-mcp service is already installed on this machine. */
export function isServiceInstalled(): boolean {
  switch (PLATFORM) {
    case "macos":
      return existsSync(join(homedir(), "Library", "LaunchAgents", "com.vault-mcp.plist"));
    case "linux":
      return existsSync(join(homedir(), ".config", "systemd", "user", "vault-mcp.service"));
    case "windows":
      return existsSync(join(CONFIG_DIR, "vault-mcp-task.xml"));
    default:
      return false;
  }
}
