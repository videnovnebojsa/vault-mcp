# Changelog

All notable changes to this project will be documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.3] - 2026-06-08

### Fixed
- The Windows background service no longer flashes a console window on every login/restart. The Task Scheduler task ran `vault-mcp.exe` directly, and because the binary is a console app, Windows allocated a visible console window each time it started (the task's `Hidden` flag does not suppress console windows). `install.ps1` now stages a `launch-hidden.vbs` shim next to the binary and points the task at `wscript.exe "...\launch-hidden.vbs"`, which starts the server with a hidden window. A `-Configure` run on an existing install re-creates the task so it adopts the shim.
- The Windows installer now prints the correct `claude_desktop_config.json` path for the Microsoft Store (AppX) build of Claude Desktop, which stores its config under `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\` instead of `%APPDATA%\Claude\`. The installer probes both locations and shows whichever exists (or both, with guidance, if neither is found yet).
- The Windows installer escapes XML-special characters in the scheduled-task paths. A profile path may legitimately contain `&` (Windows allows it in account and folder names, e.g. `C:\Users\John & Jane\…`); interpolated raw into the Task Scheduler XML it produced malformed XML and a cryptic `schtasks /Create` parse failure. `$VBS_PATH` and `$CFG_DIR` now pass through `[System.Security.SecurityElement]::Escape()`.
- The `launch-hidden.vbs` shim is now written as UTF-16 LE (with BOM) rather than `-Encoding Default`. Under PowerShell Core, `Default` is BOM-less UTF-8, which Windows Script Host misreads as ANSI and mangles — corrupting exactly the non-ASCII profile paths (e.g. `C:\Users\René`) the encoding was meant to preserve. UTF-16 is supported by `wscript.exe` and behaves identically on Windows PowerShell 5.1 and PowerShell Core.

### Changed
- The Windows installer's "Connect Claude Desktop" output now explains the architecture: the background service runs the HTTP server (`vault-mcp.exe`, no args), while Claude Desktop spawns `vault-mcp.exe bridge` on demand as a stdio↔HTTP proxy to that server — not a second server. Documented the same in `docs/installation.md` and `docs/clients.md`.

### Security
- Overrode the transitive `hono` dependency (pulled in via `@modelcontextprotocol/sdk › @hono/node-server`) to `^4.12.21` to clear four moderate advisories — IPv6 deny-rule bypass, Set-Cookie injection, JWT scheme acceptance, and mount-prefix routing. Resolves to `4.12.24`; compatible with `@hono/node-server`'s `^4` peer range.

[0.2.3]: https://github.com/videnovnebojsa/vault-mcp/compare/v0.2.2...v0.2.3

## [0.2.2] - 2026-06-03

### Fixed
- Windows installer (`install.ps1`) now prints Claude Desktop connection instructions. It previously emitted only the HTTP `.mcp.json` snippet — correct for Claude Code, but misleading for Claude Desktop, which connects over stdio rather than HTTP. The installer now also shows the stdio bridge config (`command` + `args: ["bridge"]` + `VAULT_MCP_URL`), matching `install.sh`, with the Windows binary path's backslashes escaped so the emitted JSON is valid.

[0.2.2]: https://github.com/videnovnebojsa/vault-mcp/compare/v0.2.1...v0.2.2

## [0.2.1] - 2026-06-03

### Fixed
- Windows installer (`install.ps1`) no longer aborts on a first install. `schtasks /Query` writes to stderr when the scheduled task does not yet exist, which under `$ErrorActionPreference='Stop'` surfaced as a terminating `NativeCommandError` and killed the script before the background service was registered. All `schtasks` calls now route through a wrapper that observes the exit code (seeded to a non-zero sentinel first, so a failure to launch is never misread as success) instead of throwing.
- The background-service task now registers successfully. The generated Task Scheduler XML was missing required elements (`RegistrationInfo`, `Principals`, and the `Actions` context) and used a restart interval below the enforced 1-minute minimum, so `schtasks /Create` rejected it on every machine that reached this step. On failure the installer now surfaces `schtasks`' own error message.

### Added
- `install.ps1` gains `-LocalBin <path>` and `-NoService` flags (mirroring `install.sh`) so it can run unattended, plus CI jobs that lint the script with PSScriptAnalyzer and run it end-to-end on a Windows runner — the regression guard that surfaced the task-registration failures above.

[0.2.1]: https://github.com/videnovnebojsa/vault-mcp/compare/v0.2.0...v0.2.1

## [0.2.0] - 2026-06-02

### Changed
- The HTTP MCP transport now runs in **stateless** mode. Each `POST /mcp` is served by a fresh `StreamableHTTPServerTransport` (no `sessionIdGenerator`) paired with a warmed `McpServer` borrowed from a bounded pool, so no `mcp-session-id` is issued or required and a stale id from a reconnecting client is ignored. This eliminates `404 "Session not found"` — a client can no longer fail mid-conversation after an idle gap or a server restart, which previously caused the Claude Desktop bridge to exit and drop an in-flight tool call. Applies to every local client (bridge, Claude Code, Codex). Rationale in [ADR-0003](docs/adr/0003-stateless-http-sessions.md).
- Concurrency is now bounded by `MCP_MAX_CONCURRENT_REQUESTS` (default 100), returning `429 "Too Many Requests"` when the in-flight server pool is exhausted — this replaces the old per-session cap.
- `DELETE /mcp` now returns `200` (no session to tear down); `GET` still returns `405` (ADR-0001).
- `/health` no longer reports a `sessions` field (there are no sessions to count).

### Removed
- `MCP_MAX_SESSIONS` and `MCP_SESSION_IDLE_MS` configuration — there is no session map to bound or evict in stateless mode.

[0.2.0]: https://github.com/videnovnebojsa/vault-mcp/compare/v0.1.4...v0.2.0

## [0.1.4] - 2026-06-02

### Fixed
- Claude Desktop bridge no longer wedges on the standalone GET SSE stream. The server is request/response-only (it never sends server-initiated messages), so `/mcp` now accepts only `POST` and `DELETE`; all other methods — including the optional `GET` SSE stream — return `405` with an `Allow` header. The MCP SDK client treats `405` as the canonical "no SSE at GET" signal and stops cleanly, eliminating the idle-timeout → `409` reconnect race → permanent reconnection-exhaustion loop that previously left the bridge a zombie and spammed logs. Rationale recorded in [ADR-0001](docs/adr/0001-decline-standalone-get-sse-stream.md).
- `405` method rejections are now observable via a structured log line and the `http_mcp_method_not_allowed` metric.

[0.1.4]: https://github.com/videnovnebojsa/vault-mcp/compare/v0.1.3...v0.1.4

## [0.1.3] - 2026-05-30

### Fixed
- Release workflow: two-phase build/publish so a release is created once with all assets attached — compatible with GitHub release immutability (previous per-asset `gh release upload --clobber` modified a published release and was rejected)
- De-flake PERF-01 backup race that intermittently blocked pre-push

[0.1.3]: https://github.com/videnovnebojsa/vault-mcp/compare/v0.1.2...v0.1.3

## [0.1.2] - 2026-05-29

### Added
- `vault-mcp bridge` subcommand — enables Claude Desktop integration via stdio without extra dependencies

### Fixed
- `curl | sh` install hang: use per-read `/dev/tty` redirect instead of `exec` so the script continues reading from the pipe
- Install prompts now actionable ("Enter vault path", "Default: X") with tip to rerun `--configure` for skipped fields
- Install output now includes ready-to-paste Claude Desktop config snippet

[0.1.2]: https://github.com/videnovnebojsa/vault-mcp/compare/v0.1.1...v0.1.2

## [0.1.1] - 2026-05-29

### Fixed
- Remove invalid pattern input from shellcheck CI job; pin artifact action SHAs
- Resolve 34 issues across security, API contracts, error handling, architecture, QA, and performance (VERIFICATION.md audit)
- Apply deep review findings from c1 sprint
- Bump actions/checkout to v5 for Node.js 24 compatibility

[0.1.1]: https://github.com/videnovnebojsa/vault-mcp/compare/v0.1.0...v0.1.1

## [0.1.0] - 2026-05-27

### Added
- Production-grade MCP server for Obsidian vaults over HTTP and stdio bridge
- Hybrid search (FTS5 keyword + vector semantic + fused) via `vault_search`
- Capture pipeline with inbox routing and auto-classification
- Backlink-aware note operations (`vault_read_note`, `vault_move_note`, `vault_delete_note`)
- Interactive setup script (`bun run configure`) with section menu and diff preview
- Configurable vault folder names via `VAULT_FOLDER_*` environment variables
- Cross-platform standalone binaries for Linux x64, macOS arm64, macOS x64, Windows x64
- Release workflow that builds and smoke-tests binaries on all four platforms
- OpenTelemetry tracing with `wrapHandler` as single error/span boundary
- WAL mode SQLite for embeddings store with covering indexes
- 973-test suite with 80% line/function coverage gate

### Security
- Audit log with newline-stripped inputs
- Gitleaks pre-commit gate
- OpenSSF Scorecard workflow
- CodeQL analysis workflow

### Infrastructure
- Lefthook pre-commit (biome + gitleaks) and pre-push (typecheck + tests) hooks
- GitHub Actions CI on push/PR with full test and typecheck
- Issue templates, CODEOWNERS, CONTRIBUTING, CODE_OF_CONDUCT, and SECURITY docs

[0.1.0]: https://github.com/videnovnebojsa/vault-mcp/releases/tag/v0.1.0
