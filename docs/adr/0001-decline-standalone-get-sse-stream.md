# ADR-0001 — Decline the standalone GET SSE stream (return 405 on `GET /mcp`)

- **Status:** Accepted
- **Date:** 2026-06-01
- **Deciders:** vault-mcp maintainers
- **Implemented by:** commit `22c279c` (`fix/disable-unused-get-sse-stream`)
- **Affects:** `src/http.ts` (the `/mcp` route), the Claude Desktop stdio bridge
  (`bin/stdio-bridge.ts`, `src/bridge/`)

## Context

vault-mcp runs an always-on HTTP server bound to loopback (default `127.0.0.1:3782`) so a
single process can own the SQLite index, the file watcher, and multiple simultaneous clients.
Claude Desktop speaks only stdio, so it connects through a thin stdio↔HTTP bridge
(`bin/stdio-bridge.ts`) built on the MCP SDK's `StreamableHTTPClientTransport`.

The MCP Streamable HTTP transport defines two channels:

1. **POST `/mcp`** — request/response (the response may itself be SSE-streamed). This carries
   all tool calls, reads, and their replies.
2. **A standalone GET `/mcp` SSE stream** — a long-lived connection the client opens to receive
   *unsolicited, server-initiated* messages (e.g. `notifications/tools/list_changed`). Per the
   spec this stream is **optional**.

The SDK client opens that standalone GET stream automatically. In production it entered a
permanent failure loop, visible in `~/Library/Logs/Claude/mcp-server-vault.log`:

1. With no server→client traffic, the idle GET stream times out client-side
   (`SSE stream disconnected: TimeoutError` / `TypeError: terminated`) — **3,517 occurrences**.
2. The client immediately re-opens GET `/mcp`, but the SDK server transport still has the prior
   stream registered and returns **`409 Conflict: Only one SSE stream is allowed per session`** —
   a teardown race the client loses — **11 occurrences**.
3. After `maxRetries: 2`, the SDK emits `Maximum reconnection attempts (2) exceeded` and gives
   up forever — **11 occurrences**.
4. The bridge's `upstream.onerror` is intentionally log-only, so the bridge never exits, Claude
   Desktop never respawns it, and the server→client channel stays dead until the app restarts —
   while the log fills with ~10k stream-close lines.

A code audit of `src/` established the decisive fact: **the vault server never sends any
server-initiated message.** Tools and resources register once at startup; resources
(`vault://config`, `vault://stats`) are pull-only with no subscriptions; logging stays internal
(`src/utils/logger.ts`, never forwarded to the client); the file watcher updates the index
silently; `listChanged: true` is an unexercised SDK default. The standalone GET stream therefore
carries **zero useful traffic** yet is the sole source of the entire failure class.

## Decision

**Accept only `POST` (request/response) and `DELETE` (session teardown) on `/mcp`; return
`405 Method Not Allowed` for every other method** (with `Allow: POST, DELETE`). For `GET`
specifically this declares that the server offers no standalone SSE stream; the same guard also
covers `PUT`/`PATCH`/etc., matching the advertised method contract.

This is the spec-sanctioned signal: a Streamable HTTP server MUST either answer GET with
`text/event-stream` **or** return `405`. The SDK client treats `405` as the canonical "no SSE at
GET" case and stops cleanly **without** opening or reconnecting the stream
(`@modelcontextprotocol/sdk` client: `if (response.status === 405) return;`). GET never reaches
`transport.handleRequest`, so the server transport never registers a standalone stream. `GET`
returns a stream-specific message ("server does not offer a GET SSE stream"); other methods get a
generic "Method Not Allowed".

We deliberately rejected the alternative of *patching resilience around* the stream (see below);
the stream is unused, so the correct fix is to design it out, not to armor it.

Two implementation details:

- The guard runs **after** the API-key check, so an unauthenticated request still yields `401`
  (not `405`) when `MCP_API_KEY` is set.
- Each rejection is **observable** server-side — a structured `httpLogger.info("declined
  unsupported method", …)` plus a `http_mcp_method_not_allowed` metric — so unexpected client
  probing is visible without reading raw logs. (This is server-side visibility of the 405; the
  *bridge-side* transport-error gap noted under Follow-up remains separate.)

## Consequences

**Positive**

- The entire failure class is gone at the root: no idle GET timeouts, no 409 reconnect race, no
  reconnection exhaustion, no zombie bridge, no idle liveness churn, no log spam.
- No brittle machinery: no parsing of SDK error strings, no race-tuned reconnection delays.
- The server now *honestly declares* its design — request/response only.
- Genuine upstream death (server restart, network loss) is still handled by the bridge's existing
  principled paths: `upstream.onclose` → close, and `network-unreachable`/`session-lost` on the
  next POST → close → Claude Desktop respawns. During idle there is correctly nothing to detect.
- POST request/response (incl. SSE-streamed responses) and DELETE session teardown are unaffected.

**Negative / trade-offs**

- **The server can no longer push notifications to clients.** This matches today's behavior (it
  never did), but it forecloses `tools/list_changed`, resource subscriptions, and MCP logging
  until this ADR is superseded. If such a feature is added, the GET stream must be re-enabled and
  implemented as a first-class capability (with keep-alive and a real reconnection story).
- **A non-compliant client could mishandle `405`.** Some clients incorrectly treat the
  spec-compliant `405` as a hard connection failure (e.g. amazon-q-developer-cli #3182). Our
  SDK-based bridge handles it correctly (verified), so this is not a risk for the Claude Desktop
  path, but it is a caveat for any future third-party consumer of this server.

## Alternatives considered

1. **Self-heal via error-string detection** — close the bridge when the SDK emits
   `Maximum reconnection attempts exceeded`. Rejected: depends on matching an SDK-internal error
   message (breaks silently on SDK wording changes) and is untestable with the mocked transport.
   It also only compensates for a stream we don't need.
2. **Tune `reconnectionOptions`** (longer delays / more retries) to win the 409 teardown race.
   Rejected: a timing heuristic / magic delay that still fails under load, GC pause, or a slow
   host — and again armors an unused stream.
3. **Make the server stdio-native** and let Claude Desktop spawn it directly (no HTTP, no bridge).
   Rejected: loses the always-on shared server (single index, file watcher, concurrent clients),
   which is the reason the HTTP architecture exists.
4. **Use Claude Desktop's native remote MCP (Custom Connectors).** Not applicable to a local-only
   server: custom connectors connect from **Anthropic's cloud**, which cannot reach a `127.0.0.1`
   port. Adopting them would require exposing the server publicly via a tunnel + OAuth — a larger,
   internet-facing change orthogonal to this bug.

## Prior art

This is a well-known footgun across the MCP ecosystem, and `405` is the standard resolution:

- The bridge pattern itself is universal — `mcp-remote`, [`sparfenyuk/mcp-proxy`](https://github.com/sparfenyuk/mcp-proxy),
  and [`supercorp-ai/supergateway`](https://github.com/supercorp-ai/supergateway) all translate
  stdio↔HTTP for stdio-only clients like Claude Desktop.
- [MCP spec — Transports](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports):
  GET MUST return `text/event-stream` **or** `405`.
- [FastMCP #3179 — *Stateless HTTP servers should return 405 for GET SSE streams*](https://github.com/PrefectHQ/fastmcp/issues/3179):
  FastMCP returns `405` for GET automatically when `stateless_http=True` (plus a proposed
  `enable_sse_stream=False`). Our manual guard is the equivalent of that toggle.
- [microsoft/agent-framework #5317](https://github.com/microsoft/agent-framework/issues/5317) and
  [openclaw #72757](https://github.com/openclaw/openclaw/issues/72757): the same standalone-GET-SSE
  failure on POST-only servers.
- [amazon-q-developer-cli #3182](https://github.com/aws/amazon-q-developer-cli/issues/3182): the
  client-side `405` mishandling caveat noted above.

## Follow-up

The bridge process logs to Claude Desktop's file, outside the server's `metrics`/`/health`, which
is *why this went undetected for weeks*. Surfacing bridge transport-error counts into the
observability layer is tracked separately (vault inbox TODO: "Surface stdio-bridge transport
errors into observability").
