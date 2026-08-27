# Installation

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Obsidian vault | — | Any local vault directory (required for all options) |
| [Bun](https://bun.sh) | 1.3+ | Required for Options B / C only |
| Node.js | 20+ | Required for Option D only |

---

## Option A — Quick install (no Bun required) ✦ recommended

Downloads the pre-built binary for your platform, walks you through configuration, and optionally installs a background service — all without installing Bun or cloning the repo.

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/videnovnebojsa/vault-mcp/main/install.sh | sh

# Windows (PowerShell)
irm https://raw.githubusercontent.com/videnovnebojsa/vault-mcp/main/install.ps1 | iex
```

**What the script asks:**

| Prompt | Default | Notes |
|---|---|---|
| Vault path | — | Must exist; `~` is expanded |
| Port | `3782` | Change if 3782 is in use |
| API key | _(empty)_ | Leave empty for local-only use |
| Enable embeddings? | N | Requires an OpenAI-compatible endpoint |

**Config file:** `~/.config/vault-mcp/.env` (macOS/Linux) · `%APPDATA%\vault-mcp\.env` (Windows)  
**Binary location:**
- macOS / Linux → `~/.local/bin/vault-mcp`
- Windows → `%LOCALAPPDATA%\vault-mcp\vault-mcp.exe`

**Reconfigure anytime** (change vault path, port, API key, embeddings):

```bash
bash install.sh --configure    # macOS / Linux — skips download, re-prompts settings
.\install.ps1 -Configure       # Windows
```

For advanced settings (access control, OpenTelemetry, backup, folder names, etc.) use the full interactive editor (requires Bun):

```bash
bun run configure
```

Or edit `~/.config/vault-mcp/.env` directly — see [configuration.md](configuration.md) for the full reference.

---

## Option B — Setup script (build from source)

The setup script handles everything: builds the binary, walks through configuration, and installs a background service that starts automatically at login.

```bash
git clone https://github.com/videnovnebojsa/vault-mcp
cd vault-mcp
bun install
bun run setup
```

**What the script asks:**

| Prompt | Default | Notes |
|---|---|---|
| Vault path | — | Must exist; `~` is expanded |
| Port | `3782` | Checked for conflicts before accepting |
| API key | _(empty)_ | Leave empty for local-only use |
| Add a second vault? | N | Repeatable; each vault needs a name and path |
| Enable embeddings? | N | Requires an OpenAI-compatible endpoint and API key. See [Semantic & Hybrid Search](semantic-search.md) for post-install steps. |

Everything else (backup, watcher, logging, capture pipeline, access control, etc.) uses its default and is written as a commented-out line in the config file — edit to tune.

**Config file:** `~/.config/vault-mcp/.env`  
**Binary location:**
- macOS / Linux → `~/.local/bin/vault-mcp`
- Windows → `%LOCALAPPDATA%\vault-mcp\vault-mcp.exe`

**Re-running the script** offers three options:
- `[U]pdate config` — rewrites `.env` and restarts the service, no reinstall
- `[R]einstall` — full flow from binary build onward
- `[Q]uit`

---

## Option C — Manual (Bun)

Use this if you prefer not to run the setup script or want to manage the service yourself.

```bash
git clone https://github.com/videnovnebojsa/vault-mcp
cd vault-mcp
bun install
bun run build
OBSIDIAN_VAULT_PATH=~/Documents/obsidian bun run start
```

The server starts on `http://127.0.0.1:3782` by default. Set `MCP_PORT` to change it.

To run as a background service, create the service definition manually (see [Running as a background service](#running-as-a-background-service) below) and point it to `bun run start` in the vault-mcp directory.

---

## Option D — Compiled binary (manual)

Produces a standalone executable with no runtime dependency. The setup script does this automatically; use this option if you want the binary without the service install.

```bash
bun run build:bun
# binary written to dist-bin/vault-mcp
```

Copy the binary to a stable path, create `~/.config/vault-mcp/.env` from [.env.example](../.env.example), then set up the service manually (see below).

---

## Option E — Node.js 20+

```bash
git clone https://github.com/videnovnebojsa/vault-mcp
cd vault-mcp
npm install
npm run build
OBSIDIAN_VAULT_PATH=~/Documents/obsidian node dist/index.js
```

---

## Running as a background service

These are the service definitions the setup script generates. Use them as a reference for manual installs or customisation.

### macOS — launchd

File: `~/Library/LaunchAgents/com.vault-mcp.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.vault-mcp</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/you/.local/bin/vault-mcp</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/you/.config/vault-mcp</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/Users/you/Library/Logs/vault-mcp/vault-mcp.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/you/Library/Logs/vault-mcp/vault-mcp.err</string>
</dict>
</plist>
```

Load / restart:

```bash
launchctl load ~/Library/LaunchAgents/com.vault-mcp.plist
# restart after config changes:
launchctl kickstart -k gui/$UID/com.vault-mcp
```

Logs: `tail -f ~/Library/Logs/vault-mcp/vault-mcp.err`

### Linux — systemd (user)

File: `~/.config/systemd/user/vault-mcp.service`

```ini
[Unit]
Description=vault-mcp MCP server
After=default.target

[Service]
Type=simple
ExecStart=%h/.local/bin/vault-mcp
WorkingDirectory=%h/.config/vault-mcp
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

Enable and start:

```bash
systemctl --user daemon-reload
systemctl --user enable --now vault-mcp
# restart after config changes:
systemctl --user restart vault-mcp
```

Logs: `journalctl --user -u vault-mcp -f`

### Windows — Task Scheduler

The setup script registers the task via `schtasks /Create /XML`. The task runs the
**HTTP server** (`vault-mcp.exe`, no args). It launches through a `launch-hidden.vbs`
shim (`wscript.exe "...\launch-hidden.vbs"`) rather than the exe directly — `vault-mcp.exe`
is a console app, so running it from the task would pop a black console window on every
login. The shim starts it with a hidden window. To manage manually:

```powershell
# Start
schtasks /Run /TN vault-mcp
# Restart after config changes
schtasks /End /TN vault-mcp; schtasks /Run /TN vault-mcp
```

Logs: Task Scheduler → vault-mcp → History

> Claude Desktop does **not** use this task. It spawns `vault-mcp.exe bridge` on demand —
> a stdio↔HTTP proxy to the running server, not a second server.

---

## Verifying the installation

These examples use the default port. If you picked a different one during setup, substitute the
`MCP_PORT` value from your config file:

```bash
PORT=$(grep '^MCP_PORT=' ~/.config/vault-mcp/.env | cut -d= -f2)

curl "http://localhost:${PORT:-3782}/health"
# {"status":"ok","uptimeSeconds":12,...}

curl "http://localhost:${PORT:-3782}/ready"
# {"ready":true,"vaultCount":1}
# 503 while still indexing: {"ready":false,"vaultCount":1,"unreadyCount":1}
```

`/ready` returns HTTP 503 until the vault index finishes its initial sync. `/health` always returns 200.

> **A reply is not proof you reached vault-mcp.** If another service holds the port you queried,
> it answers with its own error rather than refusing the connection, so a stray `Cannot GET /ready`
> or an HTML page reads like a broken install when the real server is healthy elsewhere. Check
> which process owns a port with `lsof -nP -iTCP:<port> -sTCP:LISTEN` (macOS/Linux) or
> `netstat -ano | findstr :<port>` (Windows).
