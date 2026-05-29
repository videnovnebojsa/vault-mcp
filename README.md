# vault-mcp

[![CI](https://github.com/videnovnebojsa/vault-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/videnovnebojsa/vault-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Bun ≥ 1.3](https://img.shields.io/badge/bun-%E2%89%A51.3-black?logo=bun&logoColor=white)](https://bun.sh)

MCP server that gives your agent direct, always-on access to your Obsidian vault - no plugin, no Obsidian process required.

Ask Claude to find everything you've written about a topic, draft a note in the right folder, or triage your inbox - without ever opening Obsidian.

## Why vault-mcp?

**Works whether Obsidian is open or not** - reads your vault straight from the filesystem, so your agent isn't blocked when the app is closed.

**One vault, many AI tools at once** - it runs as an always-on server, so Claude Code and Claude Desktop can talk to the same vault at the same time, sharing one live index.

**Finds what you mean, not just what you typed** - hybrid search blends keyword ranking and semantic embeddings. Exact phrases surface when precision matters; conceptual queries work when it doesn't.

## Demo

<!--
  TODO: record docs/demo.gif — split-screen, ~60s, loopable.
  Left half: Claude Desktop. Right half: the Obsidian vault (so changes are visibly real).
  Beats (~12s each), watch the file appear/change on the right as Claude acts on the left:
    1. Search  — "Find my notes on X" → results stream in.
    2. Capture — "File this idea: …" → a new note pops into the right folder in Obsidian.
    3. Connect — "What should I link this note to?" → related notes surfaced.
    4. Move    — "Move note A to Archive" → file moves and a [[wikilink]] elsewhere updates live.
  Trim dead air; keep it short.
-->

![vault-mcp demo](docs/demo.gif)

## What you can do

**Read & write notes**
- Ask for a note, a section of one, or a note plus everything it links to - in a single call
- Move or rename a note and every `[[wikilink]]` pointing to it updates automatically
- Delete safely - soft-delete sends notes to `.trash/` instead of destroying them
- Change one note or batch dozens of moves, deletes, and frontmatter edits in one go

**Find & connect**
- Search your whole vault by keyword, by meaning, or both at once - with tag, type, and date filters
- Surface notes that *should* be linked but aren't, so related ideas stop drifting apart

**Capture & triage**
- Drop in free-form text and have it classified and filed in the right folder for you
- Auto-triage your inbox: move everything above a confidence threshold to where it belongs
- Open or create today's daily, this week's weekly, or this month's monthly note on demand

**Runs as a service**
- Name and switch between multiple vaults from one server instance
- Connect Claude Desktop through the bundled stdio bridge
- Automatic SQLite index backups with configurable retention
- OpenTelemetry spans per tool call and webhook alerts, plus `/health` and `/ready` probes

## Quick Start

### Option 1 - Quick install (no Bun required)

Downloads the pre-built binary for your platform, walks you through configuration, and optionally installs a background service.

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/videnovnebojsa/vault-mcp/main/install.sh | sh

# Windows (PowerShell)
irm https://raw.githubusercontent.com/videnovnebojsa/vault-mcp/main/install.ps1 | iex
```

To reconfigure later (vault path, port, etc.):

```bash
bash install.sh --configure    # macOS / Linux
.\install.ps1 -Configure       # Windows
```

### Option 2 - Developer install (build from source)

Requires [Bun](https://bun.sh) 1.3+.

```bash
git clone https://github.com/videnovnebojsa/vault-mcp
cd vault-mcp
bun install
bun run setup
```

`bun run setup` builds the binary, walks you through configuration, and installs a background service that starts at login - **launchd** on macOS, **systemd** on Linux, **Task Scheduler** on Windows.

### Connect Claude Code

Add to `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "vault": { "type": "http", "url": "http://127.0.0.1:3782/mcp" }
  }
}
```

### Connect Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "vault": {
      "command": "bun",
      "args": ["/path/to/vault-mcp/bin/stdio-bridge.ts"],
      "env": { "VAULT_MCP_URL": "http://127.0.0.1:3782/mcp" }
    }
  }
}
```

### Verify

```bash
curl http://localhost:3782/health
# {"status":"ok","uptimeSeconds":12,...}
```

`/health` always returns 200; `/ready` returns 503 until the vault index finishes its initial sync.

## Common workflows

Once connected, just talk to your agent in plain language. Try:

- *"Find my notes on productivity systems"* → hybrid search across your whole vault
- *"File this meeting summary"* → capture pipeline classifies it and routes it to the right folder
- *"What notes should I connect to this one?"* → semantic connection finder surfaces related notes
- *"Archive these three project notes"* → batch move, with every `[[wikilink]]` rewritten automatically

See [docs/prompts.md](docs/prompts.md) for the full prompt cheat-sheet.

## Configuration

All settings live in `~/.config/vault-mcp/.env`. The setup script writes this file with your answers and leaves every optional variable commented out with its default; for a manual install, start from [.env.example](.env.example).

To change settings interactively after installation:

```bash
bun run configure
```

This opens a section menu, validates each setting, shows a diff of what will change, and optionally restarts the service. Jump straight to a section with `--section <id>`:

```bash
bun run configure -- --section embeddings
```

**Custom folder structure?** vault-mcp defaults to a numbered Zettelkasten-style layout. Run `bun run configure -- --section vault-folders` to remap the capture pipeline to your own folder names.

To edit the file by hand instead, open `~/.config/vault-mcp/.env` and restart the service:

| Platform | Command |
|---|---|
| macOS | `launchctl kickstart -k gui/$UID/com.vault-mcp` |
| Linux | `systemctl --user restart vault-mcp` |
| Windows | `schtasks /End /TN vault-mcp && schtasks /Run /TN vault-mcp` |

## Development

```bash
bun run test                      # run test suite
bun run build                     # compile TypeScript → dist/
bun run build:bun                 # standalone executable → dist-bin/
bun run scripts/smoke-test.ts     # smoke test the built binary against a real vault
bun run lint                      # biome check
```

## Documentation

| Topic | Link |
|---|---|
| Installation options (manual, service) | [docs/installation.md](docs/installation.md) |
| Connecting MCP clients | [docs/clients.md](docs/clients.md) |
| Example prompts cheat-sheet | [docs/prompts.md](docs/prompts.md) |
| How hybrid search works | [docs/semantic-search.md](docs/semantic-search.md) |
| Full configuration reference | [docs/configuration.md](docs/configuration.md) |
| Full tool reference | [docs/tools.md](docs/tools.md) |
| Feature roadmap & status | [docs/roadmap.md](docs/roadmap.md) |

### Contributing

| Topic | Link |
|---|---|
| Internal module map & data flow | [docs/contributing/architecture.md](docs/contributing/architecture.md) |
| Architectural rules & patterns | [docs/contributing/design-standards.md](docs/contributing/design-standards.md) |
| Tooling, lint, test, CI standards | [docs/contributing/typescript-standards.md](docs/contributing/typescript-standards.md) |

## License

[MIT](LICENSE)
