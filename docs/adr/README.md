# Architecture Decision Records

This directory holds Architecture Decision Records (ADRs): short documents capturing a
significant architectural choice, the context that forced it, and the consequences we accept.

Each record is immutable once accepted — to revisit a decision, add a new ADR that supersedes
the old one (and update the old one's status to `Superseded by ADR-NNNN`).

| ADR | Title | Status |
| --- | --- | --- |
| [0001](0001-decline-standalone-get-sse-stream.md) | Decline the standalone GET SSE stream (return 405 on `GET /mcp`) | Accepted |

## Format

Records follow a lightweight [MADR](https://adr.github.io/madr/)-style template: **Status**,
**Context**, **Decision**, **Consequences**, **Alternatives considered**, and (where useful)
**Prior art**. Keep them concise — an ADR explains *why*, not *how*; the code and tests show how.
