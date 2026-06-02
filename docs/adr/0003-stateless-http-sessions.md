# ADR-0003 — Run the HTTP transport in stateless mode (no MCP sessions)

- **Status:** Accepted
- **Date:** 2026-06-02
- **Deciders:** vault-mcp maintainers
- **Affects:** `src/http.ts` (the `/mcp` route, session lifecycle, `/health`), the
  `MCP_MAX_SESSIONS` / `MCP_SESSION_IDLE_MS` configuration (removed) and the new
  `MCP_MAX_CONCURRENT_REQUESTS` bound
- **Related:** completes the direction of [ADR-0001](0001-decline-standalone-get-sse-stream.md)

## Context

vault-mcp runs an always-on HTTP server on loopback. Clients connect either directly
(Claude Code via `http://127.0.0.1:3782/mcp`) or through the stdio↔HTTP bridge (Claude
Desktop). Until now the server issued an MCP **session** per client — a `StreamableHTTPServerTransport`
with `sessionIdGenerator: randomUUID`, tracked in an in-memory `Map`, bounded by
`MCP_MAX_SESSIONS` and evicted after `MCP_SESSION_IDLE_MS` (30 min).

That session layer caused a production incident: Claude Desktop read a note at night and, in
the **same conversation** the next day, failed to write one — the server returned
`404 "Session not found"` and the bridge treated it as fatal (`process.exit(0)`), losing the
in-flight write. The vault was healthy throughout.

The session was lost for one of two unavoidable reasons:

1. **Idle eviction** — the conversation idled past the 30-minute timeout, so the cleanup
   interval evicted it.
2. **Server restart** — sessions live only in memory, and the server is restarted by launchd
   (`KeepAlive`) and on every redeploy, which wipes the whole map.

Neither is fixable by tuning: a session can never survive a process restart. A code audit also
established that **vault-mcp keeps no per-session state** — the vault repository, SQLite search
index, and file watcher are a shared singleton booted once and injected into every request
(`createServer({ vaultManager: boot.vaultManager })`). A session isolated nothing. It was the
sole source of three symptoms: the `404` write failure, a session leak (`/health` reported
~10,600 live sessions), and idle-eviction reconnect churn. ADR-0001 already disabled the only
session-dependent feature (the server→client SSE stream), leaving sessions vestigial.

We verified against `@modelcontextprotocol/sdk@1.29.0` that stateless mode is safe here:

- With no `sessionIdGenerator`, `validateSession()` returns immediately — a `tools/call` with no
  session id is accepted, so the `404` path is unreachable
  (`server/webStandardStreamableHttp.js`).
- The protocol layer dispatches requests by method name with no "initialize first" gate
  (`shared/protocol.js`), so a fresh per-request server serves tool calls correctly.
- The SDK's own `simpleStatelessStreamableHttp.js` example matches vault-mcp's existing shape
  (POST-only, `405` on GET). The one rule: a stateless transport must not be reused across
  requests (it throws), so we build a fresh one per request.

## Decision

**Run the HTTP transport in stateless mode.** Each `POST /mcp` always builds a fresh
`StreamableHTTPServerTransport` (no `sessionIdGenerator`) — the SDK forbids reusing a transport
across requests. The `McpServer`, however, is drawn from a bounded **pool** of warmed instances
rather than reconstructed per request: a request borrows an idle server (or creates one, up to
the pool bound), connects the fresh transport, handles the one request, then closes the transport
and the server and returns the server to the pool. The server's tool/resource registrations
survive `close()` (which only detaches the transport), so a reused server skips re-registration.
The `mcp-session-id` header is neither issued nor read; a stale id from a reconnecting client is
ignored. `DELETE /mcp` returns `200` (nothing to tear down). The API-key check and the ADR-0001
`405` guard are unchanged.

The pool is bounded by `MCP_MAX_CONCURRENT_REQUESTS` (default 100): once that many servers are
live and none are idle, further concurrent requests get `429 "Too Many Requests"`. This bound
doubles as the concurrency / shed-load cap that the removed `MCP_MAX_SESSIONS` used to provide.

Removed: the in-memory session `Map`, the 5-minute idle-eviction interval, the `MCP_MAX_SESSIONS`
(429) and `MCP_SESSION_IDLE_MS` knobs, the `mcp-session-id` validation/lookup (`400`/`404`),
the per-session helpers, and the `sessions` field on `/health`.

## Consequences

**Positive**

- The `404 "Session not found"` failure class is gone for **every** local client (bridge,
  Claude Code, Codex), including across idle gaps and server restarts. The reported bug cannot
  recur.
- No session leak and no eviction churn — there is nothing to accumulate or reap.
- The bridge becomes a genuinely dumb, stateless pipe (no change required there).
- The server now honestly reflects its design: shared state, independent request/response.

**Negative / trade-offs**

- **No server→client push.** Stateless forecloses notifications / `tools/list_changed` /
  resource subscriptions — but vault-mcp already declined these in ADR-0001, so nothing is lost
  until that ADR is superseded.
- **Server pooling instead of per-request construction.** Rebuilding the `McpServer` (21
  tool/resource registrations) on every request was avoidable repeated work, so servers are
  pooled and reused across requests rather than reconstructed. This relies on the SDK
  (`@modelcontextprotocol/sdk@1.29.0`) allowing a server to be re-`connect()`ed after `close()` —
  `Protocol.close()` only detaches the transport and clears `_transport`, leaving registrations
  intact — which is pinned by a real-SDK reuse test (`src/http.test.ts`, `[PERF-01]`). The pool
  adds the small `acquire`/`release` bookkeeping in `src/http.ts`; a future SDK that made `close()`
  destructive would break reuse and is the thing that test guards against.
- **Brief server-restart window.** While the server *process* is down (sub-second, during a
  launchd restart), an in-flight request still fails with a connection error. This is far
  narrower than session loss and is tracked as a possible bridge-side retry follow-up.

## Alternatives considered

1. **Bridge-side transparent re-handshake + replay** — keep sessions, but have the bridge
   detect `404`, silently re-initialize a new upstream session, and replay the failed request.
   Rejected: a large stateful machine (handshake caching, response suppression, a recovery
   mutex) to *survive* a problem we can *delete*, and it does nothing for the direct-HTTP
   clients.
2. **Longer idle TTL / persistent session store** — rejected: a longer TTL only delays
   eviction and still dies on restart; a persistent store cannot serialize live transport and
   server objects, and would not address the leak.

## Relationship to other ADRs

- **Completes ADR-0001.** That ADR made the server POST/DELETE-only because it never pushes to
  clients; stateless mode is the natural endpoint of that same reasoning.

The bridge's transport-error classifier (`session-lost` on a 404) is left intact as
defense-in-depth — it simply stops firing in practice now that the server never 404s a session.
