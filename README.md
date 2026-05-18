# vault-mcp

MCP server that gives your agent direct, always-on access to your Obsidian vault - no plugin, no Obsidian process required.

## Why vault-mcp?

**The Local REST API plugin has a data-loss bug and requires Obsidian to stay open.** vault-mcp reads the vault directly from the filesystem, so it works whether Obsidian is running or not.

**Most vault tools serve one client at a time.** vault-mcp runs an always-on HTTP server, so Claude Code and Claude Desktop can both connect to the same vault index simultaneously.

**Keyword-only search misses concepts. Pure semantic search misses exact terms.** vault-mcp fuses FTS5 keyword ranking with vector embeddings into a single hybrid query, tunable per call.

**No Python.** Pure TypeScript, runs on Bun. No conda, no venv, no pip.

## Features

**Search**
- Hybrid FTS5 + vector embeddings with tunable alpha blend
- Tag, type, and date filters; paginated results
- Semantic connection finder — surfaces related notes that aren't linked to each other

**Vault operations**
- Read note, read section, read note with all its linked notes in one call
- Write, update frontmatter, move (with automatic `[[wikilink]]` rewrite across the vault), soft-delete to `.trash/`
- Batch operations — move/delete/update multiple notes in one call

**Knowledge workflows**
- Capture pipeline — classify and file free-form text into the right folder
- Inbox triage — auto-classify and move notes above a confidence threshold
- Periodic notes — open or create daily, weekly, and monthly notes

**Infrastructure**
- Multi-vault — name and switch between multiple vaults in the same server instance
- stdio bridge — connect Claude Desktop to the always-on HTTP server
- Automatic SQLite backup with configurable retention
- OpenTelemetry spans per tool call; webhook alert notifications
- `/health` and `/ready` endpoints for service probes

## Quick Start

Requires [Bun](https://bun.sh) 1.3+ and an Obsidian vault.

```bash
git clone https://github.com/videnovnebojsa/vault-mcp
cd vault-mcp
bun install && bun run build
OBSIDIAN_VAULT_PATH=~/Documents/obsidian bun run start

# run tests
bun run test

# Binary build scripts (standalone binary, no runtime required)
bun run build:bun

# Smoke test the built binary
bun run scripts/smoke-test.ts
```

**Claude Code** — add to `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "vault": { "type": "http", "url": "http://127.0.0.1:3782/mcp" }
  }
}
```

**Claude Desktop** — add to `claude_desktop_config.json`:

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

Health check: `curl http://localhost:3782/health`

## Documentation

| Topic | Link |
|---|---|
| Installation options (binary, service, Node) | [docs/installation.md](docs/installation.md) |
| Connecting MCP clients | [docs/clients.md](docs/clients.md) |
| Full tool reference | [docs/tools.md](docs/tools.md) |
| Configuration reference | [docs/CONFIGURATION.md](docs/CONFIGURATION.md) |
| Architecture | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| Binary build scripts | [docs/installation.md](docs/installation.md) |

## License

MIT
