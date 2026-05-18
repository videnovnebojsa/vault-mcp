# Security Policy

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Use GitHub's private vulnerability reporting:
**Settings → Security → Advisories → Report a vulnerability**

### What to include

- A description of the vulnerability and its potential impact
- Steps to reproduce (proof of concept if possible)
- Affected versions
- Any suggested mitigations

### Response timeline

- **Acknowledgement**: within 72 hours
- **Status update**: within 7 days
- **Patch release**: within 30 days for confirmed issues

### Scope

This policy covers the vault-mcp server code in this repository. It does **not** cover:
- The contents of your Obsidian vault (your data, not our code)
- Third-party MCP clients connecting to this server
- Infrastructure or deployment configurations outside this repo

### Out of scope

- Vulnerabilities in dependencies (report to the upstream project; open a GitHub Advisory here if it requires a workaround in this code)
- Issues that require physical access to the machine running the server
- Social engineering attacks

## Supported versions

Only the latest release receives security patches. Pin to a specific release tag for stability.
