# Installation

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| [Bun](https://bun.sh) | 1.3+ | Required for Option A and B |
| Node.js | 20+ | Required for Option C only |
| Obsidian vault | — | Any local vault directory |
| Embedding endpoint | — | Optional; any OpenAI-compatible API |

---

## Option A — Bun (recommended)

```bash
git clone https://github.com/videnovnebojsa/vault-mcp
cd vault-mcp
bun install
bun run build
OBSIDIAN_VAULT_PATH=~/Documents/obsidian bun run start
```

The server starts on `http://127.0.0.1:3782` by default.

---

## Option B — Compiled binary

Produces a single self-contained executable with no runtime dependency.

```bash
bun run build:bun
# binary written to dist-bin/
./dist-bin/vault-mcp
```

Set `OBSIDIAN_VAULT_PATH` and other variables in the environment before running, or place them in a `.env` file in the working directory.

---

## Option C — Node.js 20+

```bash
git clone https://github.com/videnovnebojsa/vault-mcp
cd vault-mcp
npm install   # or pnpm install
npm run build
OBSIDIAN_VAULT_PATH=~/Documents/obsidian node dist/index.js
```

---

## Running as a background service

### macOS — launchd

Create `~/Library/LaunchAgents/com.vault-mcp.plist`:

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
    <string>/path/to/bun</string>
    <string>run</string>
    <string>start</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/path/to/vault-mcp</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>OBSIDIAN_VAULT_PATH</key>
    <string>/Users/you/Documents/obsidian</string>
  </dict>
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
```

Load it:

```bash
launchctl load ~/Library/LaunchAgents/com.vault-mcp.plist
```

### Linux — systemd

Create `/etc/systemd/system/vault-mcp.service`:

```ini
[Unit]
Description=vault-mcp MCP server
After=network.target

[Service]
Type=simple
User=youruser
WorkingDirectory=/path/to/vault-mcp
ExecStart=/usr/local/bin/bun run start
Environment=OBSIDIAN_VAULT_PATH=/home/youruser/obsidian
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now vault-mcp
```

---

## Verifying the installation

```bash
curl http://localhost:3782/health
# {"status":"ok","uptimeSeconds":12,...}

curl http://localhost:3782/ready
# {"ready":true,"vaultCount":1,"unreadyCount":0}
```

`/ready` returns HTTP 503 until the vault index finishes its initial sync. `/health` always returns 200.
