# Connecting MCP Clients

vault-mcp runs an always-on HTTP server (default `http://127.0.0.1:3782`). Any number of MCP clients can connect simultaneously.

---

## Claude Code

Add to `.mcp.json` in your project root (or `~/.claude/mcp.json` for global config):

```json
{
  "mcpServers": {
    "vault": {
      "type": "http",
      "url": "http://127.0.0.1:3782/mcp"
    }
  }
}
```

If you set `MCP_API_KEY`, add it as a header:

```json
{
  "mcpServers": {
    "vault": {
      "type": "http",
      "url": "http://127.0.0.1:3782/mcp",
      "headers": { "Authorization": "Bearer your-token" }
    }
  }
}
```

---

## Claude Desktop

Claude Desktop uses stdio (not HTTP), so connect it via the included stdio bridge. The bridge is a lightweight process that translates between stdio JSON-RPC and the HTTP server.

> The server is request/response-only and declines the optional standalone GET SSE stream (returns `405` on `GET /mcp`). See [ADR-0001](adr/0001-decline-standalone-get-sse-stream.md) for the rationale.

**Step 1** - make sure the vault-mcp HTTP server is running (see [installation.md](installation.md)).

**Step 2** - add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "vault": {
      "command": "bun",
      "args": ["/absolute/path/to/vault-mcp/bin/stdio-bridge.ts"],
      "env": {
        "VAULT_MCP_URL": "http://127.0.0.1:3782/mcp"
      }
    }
  }
}
```

With an API key:

```json
{
  "mcpServers": {
    "vault": {
      "command": "bun",
      "args": ["/absolute/path/to/vault-mcp/bin/stdio-bridge.ts"],
      "env": {
        "VAULT_MCP_URL": "http://127.0.0.1:3782/mcp",
        "MCP_API_KEY": "your-token"
      }
    }
  }
}
```

`claude_desktop_config.json` locations:
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows (classic build)**: `%APPDATA%\Claude\claude_desktop_config.json`
- **Windows (Microsoft Store build)**: `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude_desktop_config.json`

The Microsoft Store (AppX) build of Claude Desktop redirects its config into the package
container, so the classic `%APPDATA%\Claude` path will not exist. `install.ps1` detects
which build you have and prints the correct path.

---

## Using Claude Code and Claude Desktop simultaneously

Both clients connect to the same HTTP server and share the same vault index. No extra configuration is needed - just start the server once and configure each client to point to it.

---

## Security

By default the server binds to `127.0.0.1` (loopback only). To expose it on a network interface, set `MCP_HOST=0.0.0.0` and set a strong `MCP_API_KEY`:

```bash
MCP_HOST=0.0.0.0 MCP_API_KEY=your-secret-token bun run start
```

All requests to `/mcp` will require the `Authorization: Bearer your-secret-token` header. The `/health` and `/ready` endpoints are unauthenticated.

---

## Multi-vault

If you have more than one vault, name them in `VAULT_PATHS` (semicolon-separated `name:path` pairs):

```bash
OBSIDIAN_VAULT_PATH=~/vaults/personal \
VAULT_PATHS=work:~/vaults/work;archive:~/vaults/archive \
bun run start
```

The default vault (accessed when no `vault` parameter is passed to a tool) is the one at `OBSIDIAN_VAULT_PATH`. Named vaults are addressed by passing `vault: "work"` or `vault: "archive"` in any tool call. Use `vault_list_vaults` to see all configured vaults.
