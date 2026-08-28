# 16. The streamable HTTP transport

**Status:** accepted
**Date:** 2026-08-28
**Follows:** [ADR 0002](0002-low-level-mcp-server-in-the-scaffold.md),
[ADR 0010](0010-mcp-server-and-the-generate-image-tool.md)

## Context

Until now `src/index.ts` built a server and handed it a `StdioServerTransport`.
Reaching the server over a LAN, a tunnel or Azure Container Apps needs a second
transport (issue #35). `docs/research/remote-mcp-2026-08.md` §1–§2 settles the
two questions that would otherwise be decided by accident: which protocol era to
serve, and which SDK line to serve it from.

## Decision

**Serve the handshake era on SDK v1, not the modern era.** The current protocol
revision is `2026-07-28`, which removes sessions, the `initialize` handshake and
the GET stream. Anthropic's own connector documentation still references
`2025-11-25` throughout, so the handshake era is what Claude clients
demonstrably speak today (research §1.4). The installed
`@modelcontextprotocol/sdk@1.30.0` implements exactly that era through
`StreamableHTTPServerTransport`. Modern-era serving is issue #46; the route
table in `src/transport/http.ts` is written so it arrives as a second handler
beside `handleMcpPost`, and a comment at the top of the file says so.

**No web framework.** The SDK's `StreamableHTTPServerTransport.handleRequest`
takes a Node `IncomingMessage`/`ServerResponse` pair directly, so
`node:http.createServer` is enough — the SDK does the JSON-RPC, the SSE framing
and the body parsing. Express and Hono adapters exist, are already inside the
SDK's own dependency tree, and would buy us nothing here: the whole surface is
two paths and one method. **No new production dependency was added.**

**Stateless, with a fresh `McpServer` per POST.** `sessionIdGenerator` is
`undefined`, so no `Mcp-Session-Id` is minted, echoed or validated. Each POST
gets its own transport and its own server instance, both closed when the
response closes. Stateless is the current spec's model, and Microsoft names it
explicitly for Container Apps hosting ("prefer stateless MCP servers to avoid
session-hijacking risks", research §1.3).

**The dependencies behind those servers are built once, at startup.** Config,
curated knowledge, provider adapters and the cost ledger are immutable after
startup and are shared across requests; rebuilding them per request would
re-read config and re-open the cost log on every call. This is why `src/index.ts`
calls `buildDependencies()` once and passes `() => createServer(deps)` to the
transport, rather than calling `createImagineServer()` per request. The
composition root itself is unchanged.

Note what this makes untrue: `budget.max_usd_per_session` is now one bucket
shared by everyone talking to the process, not one user's session. That is a
known consequence, out of scope here, and dealt with by the caller-identity work
(research §4.1).

**The switch is `--http` or `IMAGINE_TRANSPORT=http`, and stdio is the default.**
With neither, `src/index.ts` does exactly what it did before. Host, port and
allowed origins come from `IMAGINE_HTTP_HOST` (default `127.0.0.1`),
`IMAGINE_HTTP_PORT` (default `3000`) and `IMAGINE_HTTP_ALLOWED_ORIGINS` (default
empty), because a container is configured by environment and not by argv.

**`/mcp` accepts POST only; a GET or DELETE answers `405` with an `Allow`
header.** The SDK's own HTTP client treats a 405 on GET as "this server offers
no SSE stream" and carries on, so refusing is compatible as well as correct — and
it is what `2026-07-28` will require. Health probing lives on **`/healthz`**,
never on `/mcp`: MCP endpoints answer JSON-RPC POSTs, and a plain GET probe
against one is an error by design.

**Origin validation is ours, not the SDK's.** The SDK has
`allowedOrigins`/`enableDnsRebindingProtection` options, but they are marked
deprecated in favour of external middleware, and they sit inside the transport —
after we have already built a server for the request. We validate before that.
The policy: a request with **no `Origin`** is allowed (it is not a browser —
Claude Code, Claude Desktop and the SDK client send none); a **same-origin**
request is allowed; a **loopback origin** on any port is allowed; anything on the
explicit allow-list is allowed; everything else gets `403`. Loopback is allowed
because the attack this closes is DNS rebinding — a page on an attacker-controlled
hostname re-resolved to `127.0.0.1` — and such a page carries the attacker's
origin, never a loopback one. A page actually served from loopback is already
local code.

**Bind `127.0.0.1` by default.** Binding wide is an explicit `IMAGINE_HTTP_HOST`
opt-in, and doing so prints an extra line saying the endpoint is reachable from
the network.

**The endpoint is unauthenticated, and it says so on every start.** There is no
auth in this transport at all; that is issues #36/#37. Rather than ship a quiet
open endpoint, the startup banner on stderr states in block capitals that anyone
who can reach it can spend the operator's provider credits, and the README
repeats it. An unauthenticated endpoint that announces itself is a deliberate
intermediate state; an unauthenticated endpoint that does not is a trap.

## Consequences

`node dist/index.js --http` serves MCP at `http://127.0.0.1:3000/mcp`, and
`claude mcp add --transport http imagine http://127.0.0.1:3000/mcp` connects to
it. The stdio path is byte-for-byte what it was, and its tests were not touched.

`src/mcp/` and `src/composition.ts` learned nothing about HTTP; `src/index.ts`
and the new `src/transport/http.ts` hold all of it. The seam that makes the Azure
work possible — a request handler that does not care where the process runs — now
exists, so #36/#37 add a check in front of `handleMcpPost` rather than a new
server.

Sitting on SDK v1 is a deliberate deferral, not an oversight: v2 is where the
ecosystem is going and the migration is filed separately, so a client
compatibility problem and a dependency migration never share a pull request.
