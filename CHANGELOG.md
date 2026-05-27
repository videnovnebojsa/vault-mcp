# Changelog

All notable changes to this project will be documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-05-27

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
