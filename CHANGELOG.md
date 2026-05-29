# Changelog

All notable changes to this project will be documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
