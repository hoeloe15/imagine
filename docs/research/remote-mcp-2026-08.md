# Remote MCP: transport, clients, Azure hosting, and what multi-user costs us

Research for Phase 3 (issues #20–#24) and the far-horizon vision (#33). Written
2026-08-27. Every claim below carries its source and the date that source was
published or last updated; where a source is a blog post or a community write-up
rather than a spec or vendor doc, it is labelled as such.

**The headline finding: the protocol moved under us.** The current MCP revision
is `2026-07-28`, and it removed sessions, removed the `initialize` handshake, and
removed the GET/SSE stream. The TypeScript SDK simultaneously reorganised into a
v2 package family. Neither of these is a detail we can defer to implementation
time — both change what "add an HTTP transport" means. See
[§1](#1-the-transport) and [§2](#2-the-sdk).

---

## 1. The transport

### 1.1 Which revision is current

| Revision     | State                                  |
| ------------ | -------------------------------------- |
| `2026-07-28` | **Current**                            |
| `2025-11-25` | Final (handshake era)                  |
| `2025-06-18` | Final (handshake era)                  |
| `2025-03-26` | Final — introduced Streamable HTTP     |
| `2024-11-05` | Final — HTTP+SSE, deprecated           |

Source: [MCP: Versioning](https://modelcontextprotocol.io/specification/versioning)
(current as of 2026-08-27). The spec calls `2025-11-25` and earlier the
"initialization-based versions" and `2026-07-28` the modern era; they are
different enough that the spec ships a compatibility matrix rather than a
migration note.

### 1.2 What Streamable HTTP looks like in `2026-07-28`

Source:
[Transports: Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
and the
[Key Changes changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog).

- **One endpoint, POST only.** A single path (e.g. `/mcp`) that accepts POST.
  GET and DELETE on that path should now answer `405 Method Not Allowed`.
- **No sessions.** `Mcp-Session-Id` is gone from the protocol. A server that
  receives one must ignore it and must not mint or echo one. Servers needing
  cross-call state use "explicit, server-minted handles passed as ordinary tool
  arguments" — i.e. state becomes a tool argument, not transport furniture.
- **No handshake.** `initialize` / `notifications/initialized` are removed. Every
  request carries `io.modelcontextprotocol/protocolVersion`,
  `clientCapabilities` and (SHOULD) `clientInfo` in `params._meta`.
- **New mandatory RPC `server/discover`** — advertises supported protocol
  versions, capabilities and identity in one call.
- **Required headers on every POST**: `MCP-Protocol-Version`, `Mcp-Method`, and
  `Mcp-Name` for `tools/call` / `resources/read` / `prompts/get`. The server
  MUST reject a header that disagrees with the body with `400` and JSON-RPC
  error `-32020` (`HeaderMismatch`). This is deliberate: it lets a gateway route
  or rate-limit on `Mcp-Name` without parsing the body, and forbids the two
  sources of truth from diverging.
- **No resumability.** `Last-Event-ID` and SSE event IDs are gone. A broken
  stream loses the in-flight request; the client re-issues it with a new id.
- **Cancellation is the disconnect.** Closing the SSE response stream *is* the
  cancellation signal on HTTP.
- **`ttlMs` and `cacheScope` are now required** on `tools/list`, `prompts/list`,
  `resources/list`, `resources/read`, `resources/templates/list` results.
- **Security requirements that apply to us directly:** the server MUST validate
  the `Origin` header (403 on an invalid one) to block DNS rebinding; when
  running locally it SHOULD bind to 127.0.0.1 rather than 0.0.0.0; and it SHOULD
  authenticate all connections.
- Also deprecated in this revision: Roots, Sampling, Logging, and OAuth Dynamic
  Client Registration (in favour of Client ID Metadata Documents). We use none
  of those today, which is lucky.

### 1.3 Stateless vs stateful, for us

The question mostly evaporates: at `2026-07-28` the *protocol* is stateless and
there is no session to be stateful about. What remains is our own process state,
and there are exactly two pieces:

1. **The cost ledger.** `src/core/budget.ts` mints a `sessionId` per
   `CostLedger` (`randomUUID()`), writes it on every JSONL line, and enforces
   `max_usd_per_session` against one process. Over HTTP, "one process" is a
   container replica serving everybody — a per-process session budget becomes a
   meaningless shared bucket, and it silently gets weaker as we scale out.
2. **Provider adapters and config**, which are effectively immutable after
   startup and are safe to share across requests.

So the HTTP server can be a plain stateless request handler, which is also what
Microsoft recommends for Container Apps ("Prefer stateless MCP servers to avoid
session-hijacking risks",
[Secure MCP servers on Azure Container Apps](https://learn.microsoft.com/en-us/azure/container-apps/mcp-authentication),
updated 2026-05-08). The one thing that must change is the meaning of "session"
in the budget — see [§4](#4-what-multi-user-does-to-our-single-user-assumptions).

### 1.4 What is uncertain here

- **Whether we should serve `2026-07-28` at all yet, or only the handshake era.**
  The spec is a month old. Claude's own connector documentation (below) still
  links to `2025-11-25` throughout, which suggests the hosted Claude surfaces
  are not yet speaking the modern era. Serving both is possible but doubles the
  surface. My reading: implement the handshake era first because that is what
  clients demonstrably speak today, and structure the HTTP layer so the modern
  era is a second handler, not a rewrite. This is a judgement call on moving
  ground and should be revisited when the issue is picked up.
- The Azure Container Apps CORS guidance still tells you to allow the
  `Mcp-Session-Id` header, which no longer exists in the current revision. The
  vendor docs lag the spec.

---

## 2. The SDK

The repo depends on `@modelcontextprotocol/sdk: ^1.20.0`; `1.30.0` is what is
actually installed in `node_modules` today.

**v2 exists and is the stable line released alongside `2026-07-28`.** It retires
the monolithic `@modelcontextprotocol/sdk` package in favour of
`@modelcontextprotocol/server`, `@modelcontextprotocol/client`, plus thin
adapters `@modelcontextprotocol/node`, `-express`, `-hono`, `-fastify`, and
`@modelcontextprotocol/server-legacy` for legacy auth. Source:
[Supporting protocol revision 2026-07-28](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28)
(TS SDK docs, fetched 2026-08-27) and the announcement
[Beta SDKs for the 2026-07-28 MCP Spec Release Candidate](https://blog.modelcontextprotocol.io/posts/sdk-betas-2026-07-28/).

Two facts that matter for planning:

- **v2 does not speak `2026-07-28` by default.** Per the migration doc, "Nothing
  in v2 puts a 2026-07-28 byte on the wire by default" — a hand-constructed
  `Server`/`McpServer` keeps speaking the 2025-era protocol. Modern-era serving
  is an explicit opt-in: `createMcpHandler(factory)` for HTTP,
  `serveStdio(() => buildServer())` for stdio.
- **v1.x still exists and still works.** The v1 docs are still published
  alongside v2. `StreamableHTTPServerTransport` in v1 implements the
  handshake-era Streamable HTTP, including the `sessionIdGenerator: undefined`
  stateless mode that Microsoft's guidance names by name.

**Implication for the issue breakdown.** Adding HTTP is *not* only "wire up a
second transport". There is a real fork:

- **(a) Stay on v1 `StreamableHTTPServerTransport` in stateless mode.** Smallest
  diff, speaks what clients speak today, no dependency churn. Cost: we are on a
  package line that the ecosystem is migrating off.
- **(b) Migrate to v2 first, then add HTTP via `createMcpHandler`.** Larger,
  touches the composition root and `src/mcp/`, but lands us where the SDK is
  going and gives modern-era support as a config flag.

I recommend (a) for the transport issue and a separate, explicitly-scoped v2
migration issue, so that a client-compatibility problem and a dependency
migration never end up in the same pull request. Both are filed.

---

## 3. How Claude clients connect to a remote MCP server today

The authoritative page is
[Authentication for connectors](https://claude.com/docs/connectors/building/authentication)
(Anthropic, fetched 2026-08-27), which is explicit that "the same infrastructure
backs Claude.ai, Claude Desktop, Claude mobile, Claude Code, and Cowork".

### 3.1 Supported auth types

| Type                    | What it is                                                  | Availability                       |
| ----------------------- | ----------------------------------------------------------- | ---------------------------------- |
| `oauth_dcr`             | OAuth 2.0 + Dynamic Client Registration (RFC 7591)          | Out of the box                     |
| `oauth_cimd`            | OAuth 2.0 + Client ID Metadata Document                     | Out of the box                     |
| `oauth_anthropic_creds` | Anthropic holds your pre-registered client id/secret        | By arrangement (`mcp-review@`)     |
| `custom_connection`     | URL/credentials supplied at connection time                 | By arrangement                     |
| `static_headers`        | Fixed API key / bearer token entered by an org admin        | **Beta**                           |
| `none`                  | Authless                                                    | Supported                          |

Notes that bear directly on our design:

- **Claude Code takes a static bearer header directly.**
  `claude mcp add --transport http imagine https://…/mcp --header "Authorization: Bearer <token>"`
  ([Connect Claude Code to tools via MCP](https://code.claude.com/docs/en/mcp),
  fetched 2026-08-27). It also supports full OAuth (`/mcp`, `claude mcp login`),
  pre-configured `--client-id`/`--client-secret`, and a `headersHelper` hook in
  `.mcp.json` that shells out to a script for short-lived tokens. That last one
  is the cheapest possible bridge to Entra: a script that runs
  `az account get-access-token` and prints the header.
- **The hosted surfaces (claude.ai, Desktop, mobile) need real OAuth**, or the
  `static_headers` beta, which is *organisation-wide and entered by an admin* —
  not per user.
- **Machine-to-machine `client_credentials` is explicitly not supported.** Every
  connection requires user consent.
- Redirect URIs: `https://claude.ai/api/mcp/auth_callback` for the hosted
  surfaces; Claude Code uses an RFC 8252 loopback on an ephemeral port and
  declares `http://localhost/callback` and `http://127.0.0.1/callback` in its
  CIMD, so the authorization server must match those port-agnostically.

### 3.2 The discovery handshake the server must implement

From the same page plus
[Troubleshooting connectors](https://claude.com/docs/connectors/building/troubleshooting):

1. Unauthenticated request → **`401`** (not a tool error, not a 200) with
   `WWW-Authenticate: Bearer resource_metadata="https://…/.well-known/oauth-protected-resource"`.
   Claude does *not* honour `WWW-Authenticate` on a 200.
2. That document's `resource` field must match the MCP server URL **exactly as
   the user typed it**, path included.
3. `authorization_servers[0]` is the issuer Claude will use; it does not fall
   back to later entries.
4. The authorization server must serve RFC 8414 *or* OpenID Connect Discovery
   metadata, advertise `code_challenge_methods_supported: ["S256"]`, and be
   reachable from Anthropic's egress range `160.79.104.0/21`.
5. Claude sends the RFC 8707 `resource` parameter set to the canonical MCP
   server URL on both the authorization and token requests, and the server must
   validate the token audience.

Latency budget: **10 s** for discovery/registration/token endpoints, **30 s** for
refresh. Slower than that is an intermittent connection failure.

### 3.3 The Entra ID gotcha, in Anthropic's own words

> If your authorization server is Microsoft Entra ID, you must also register the
> MCP server URL as an Application ID URI on your Entra app registration, or the
> token request fails with `AADSTS9010010`.

Because Claude sends the **full MCP server URL including the path** as the RFC
8707 `resource`, the default `api://{client-id}` identifier URI is not enough.
The fix (from the troubleshooting page) is to add
`https://<app>.<region>.azurecontainerapps.io/mcp` as an additional Application
ID URI under **Expose an API**, exactly, no trailing slash — and, if the token
audience is validated by platform auth, add both the app id and the `api://` URI
to **Allowed token audiences**.

This is a concrete, testable requirement and the single most likely thing to
break the demo. It is called out in the Entra auth issue and in the runbook.

### 3.4 The DCR problem with Entra

Entra ID does not offer the RFC 7591 registration endpoint that
`oauth_dcr` wants in the shape Claude wants it (community reporting, e.g.
[obot.ai on MCP DCR with Entra](https://obot.ai/blog/mcp-dynamic-client-registration-entra/)
— blog, not a vendor doc — and Microsoft's own DCR page is scoped to M365
Copilot plugins, not general Entra apps). Practically this leaves three routes
for the hosted Claude surfaces:

- **Pre-registered client credentials.** For a *custom* connector, the user
  adding it can supply an OAuth Client ID (and secret) in Advanced settings.
  Anthropic's own guidance says this "is a good option when you want a stable
  OAuth client per organization". **This is our path.** It costs the operator
  one extra paste and needs nothing DCR-shaped from Entra.
- `oauth_anthropic_creds`, which requires emailing Anthropic — not appropriate
  for a self-hosted, per-tenant deployment.
- Fronting Entra with something that does speak DCR (API Management, or an
  auth gateway). Real, but it is a whole extra component and a whole extra bill.

**Uncertain:** whether Entra has shipped CIMD support (`client_id_metadata_document_supported`)
since. I found no primary source confirming it either way. If it has, that is
strictly the better path and the Entra issue should switch to it. Worth
re-checking at implementation time with a live tenant.

---

## 4. What multi-user does to our single-user assumptions

Three assumptions in the current code are load-bearing on "one user, one
machine, one process". Two of them break the moment a second person points a
client at the deployment.

### 4.1 `session_id` in the ledger

`src/core/budget.ts` mints one `sessionId` per `CostLedger`, i.e. per process,
and `budget.max_usd_per_session` is enforced against that. Over HTTP:

- Per-process is now per-replica-serving-everyone. The "$5 session cap" becomes a
  shared bucket that empties faster the more colleagues use it, and behaves
  differently depending on how many replicas are running. That is not a budget,
  it is a race.
- `max_usd_per_day` is recomputed from the cost log, so it survives — but it is
  a *tenant-wide* daily cap, not a per-person one, and the log itself is on
  container-local disk unless it moves.

What the deployment needs: a caller identity (the `oid`/`sub` claim from the
validated Entra token) threaded into the ledger, `session_id` becoming
`user_id` + a per-request correlation id, budgets evaluable per identity, and
the ledger persisted somewhere shared. Vision issue #33 already anticipates this
("a `user_id` is one field away"). It is one field in the record and a real
decision in the enforcement path.

### 4.2 Output paths

`output.dir` is a filesystem path and `path` in the tool result is a local
absolute path. On a container it is ephemeral and, worse, shared: two users
generating similar prompts collide in the same directory, and the returned path
is meaningless to the caller anyway. Epic #24 (Blob) forces the abstraction; the
multi-user part is that the prefix must be per-identity and the returned URL
must not be guessable across users. A container-wide SAS over one flat container
would let anyone with a URL read anyone's image.

### 4.3 Config from `~/.imagine`

`loadConfig` merges bundled defaults, `~/.imagine/config.json`, then
`./config.json`, and resolves keys from `.env` files in `~/.imagine/`, the config
directory and cwd. In a container there is no meaningful `$HOME` and no user to
own it: config becomes image-baked plus environment, and keys come from Key Vault
via managed identity (epic #22). The `api_key_env` indirection survives intact —
Key Vault references in Container Apps surface as environment variables, so
`api_key_env` keeps naming a variable and nothing in the config vocabulary has to
change. That is a nice payoff from ADR 0004.

The honest framing for #33: per-user isolation of ledger and output is not a
Phase 3 requirement (a single tenant of trusted colleagues can share a budget),
but it is the difference between "deployed" and "a service". Phase 3 should make
the *seams* right — identity available at the tool boundary, output sink
abstract, budget keyed by something — without building the metering.

---

## 5. Where to host it on Azure

Microsoft now publishes explicit MCP hosting guidance. The comparison doc
([Choose an Azure service for your MCP server](https://learn.microsoft.com/en-us/azure/container-apps/mcp-choosing-azure-service),
updated 2026-06-02) lists five options and answers our question directly:

> **Not sure where to start?** Begin with Azure Container Apps (standalone),
> which is the most flexible default.

| Option                  | Fit for us                                                                      |
| ----------------------- | ------------------------------------------------------------------------------- |
| **Container Apps (standalone)** | **Recommended.** Any language, streamable HTTP, scale-to-zero, managed identity, built-in Entra auth, and it hosts the Phase 2 portal in the same environment. |
| App Service             | Viable. No Dockerfile needed, and its Easy Auth can serve PRM (below). But no scale-to-zero, and we would host the portal separately. |
| Azure Functions         | The MCP extension binds *function triggers* to MCP tools — we would rewrite the tool layer against `app.mcpTool`, abandoning `src/mcp/`. Wrong shape for a router that already exists. |
| Container Apps sessions | Platform-defined tools only (shell/Python sandbox). Not applicable. |
| AKS                     | Overkill.                                                                        |

Sources: the comparison doc above and
[Host MCP servers on Azure Container Apps](https://learn.microsoft.com/en-us/azure/container-apps/mcp-overview)
(updated 2026-03-25).

**Container Apps has no MCP-specific awareness** — the overview doc says so
plainly. Ingress `transport` should be `auto` or `http`; there is no MCP
transport value. Practical guidance from the same docs:

- Set **min replicas 1** for interactive MCP clients; scale-to-zero cold start is
  visible in a tool call.
- Put health probes on a **separate path** (`/healthz`), not on `/mcp` — MCP
  endpoints answer JSON-RPC POSTs and return errors for plain GET probes. (And
  at `2026-07-28`, a GET on `/mcp` must be a 405.)
- CORS only matters for browser-based clients; the desktop Claude clients are not
  browsers. The portal is, but it is same-origin-ish and a separate app.

### 5.1 Entra auth on the endpoint: two ways, and why I lean one way

**Option A — Container Apps built-in auth ("Easy Auth").** Register an Entra app,
`az containerapp auth microsoft update`, then
`az containerapp auth update --unauthenticated-client-action Return401`. The
platform validates the bearer token before the request reaches the container.
Documented step by step in
[Secure MCP servers on Azure Container Apps](https://learn.microsoft.com/en-us/azure/container-apps/mcp-authentication)
(updated 2026-05-08), and the doc shows exactly the VS Code `mcp.json` shape with
a pasted bearer token.

**Option B — validate the token in our own HTTP layer** (JWKS from the tenant's
`openid-configuration`, check `aud`, `iss`, `tid`, and a required scope or app
role), and serve our own `/.well-known/oauth-protected-resource`.

The deciding factor is the discovery handshake in §3.2. Easy Auth's 401 has to
carry `WWW-Authenticate: Bearer resource_metadata=…` or the hosted Claude
surfaces cannot begin OAuth. **App Service** has a documented setting for this —
`WEBSITE_AUTH_PRM_DEFAULT_WITH_SCOPES`, set to
`api://<app-id>/user_impersonation`, which turns on the
`/.well-known/oauth-protected-resource` endpoint and puts the scope in the
challenge
([Secure MCP servers with Microsoft Entra authentication — App Service](https://learn.microsoft.com/en-us/azure/app-service/configure-authentication-mcp-server-vscode),
updated 2026-04-27). **I could not find a primary source confirming the same
setting works on Container Apps.** Container Apps documents itself as using "the
same authentication and authorization system as Azure App Service" with
differences, and the Container Apps MCP auth doc shows only a pasted bearer
token from `az account get-access-token` — never an OAuth discovery flow. That
gap is exactly where the hosted-Claude story lives.

So: **use Easy Auth for token validation, and serve PRM from our own code**
(a static JSON route we control, which the spec requires of us anyway —
"MCP servers MUST implement OAuth 2.0 Protected Resource Metadata"). If Easy
Auth turns out to swallow the unauthenticated request before our route can
answer, the `/.well-known/*` paths must be excluded from auth, or we fall back to
Option B entirely. **This is the single biggest unknown in Phase 3 and it should
be settled with a spike against a real container app before the Bicep is
written.** It is filed as its own issue.

### 5.2 azd

`azd` is the right envelope: `azure.yaml` + `infra/*.bicep`, one
`azd up`. Microsoft's own Functions MCP quickstart is `azd init --template …` →
`azd up`, which is the shape the owner asked for. Resources needed: Container
Apps environment + two container apps (mcp, portal), Azure Container Registry,
Key Vault, Storage account + blob container, Log Analytics, a user-assigned
managed identity with `Key Vault Secrets User` and
`Storage Blob Data Contributor`, and the Entra app registration. **App
registration is the part `azd` handles worst** — it generally needs either a
`azd` hook running Graph/`az ad` commands or a documented manual step. Epic #20
says "no manual portal steps"; that is achievable with a preprovision hook, and
it needs the operator to have permission to create app registrations in the
tenant. Flagged in the runbook.

---

## 6. Summary of what is uncertain or moving

1. **Which protocol era to serve.** `2026-07-28` is current but a month old, and
   Anthropic's connector docs still reference `2025-11-25`. Recommend
   handshake-era first, modern era behind a flag. Revisit at pickup.
2. **SDK v1 vs v2.** v1 works and is still documented; v2 is where things are
   going and is a real migration. Kept as a separate issue on purpose.
3. **PRM on Container Apps Easy Auth.** No primary source. Spike it.
4. **Entra + CIMD.** Unknown whether Entra advertises
   `client_id_metadata_document_supported`. If it does, it beats pre-registered
   credentials.
5. **`static_headers` is beta** on the hosted Claude surfaces and is org-wide.
   Fine for Claude Code today; not a foundation.
6. **Vendor docs lag the spec** (the Container Apps CORS guidance still names
   `Mcp-Session-Id`). Trust modelcontextprotocol.io over Learn on protocol
   questions, and Learn over everything on Azure questions.

## Sources

- [MCP: Versioning](https://modelcontextprotocol.io/specification/versioning)
- [MCP 2026-07-28: Transports — Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
- [MCP 2026-07-28: Key Changes](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- [MCP 2026-07-28: Authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
- [MCP TypeScript SDK v2 — Supporting protocol revision 2026-07-28](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28)
- [MCP blog: Beta SDKs for the 2026-07-28 spec release candidate](https://blog.modelcontextprotocol.io/posts/sdk-betas-2026-07-28/)
- [Anthropic: Authentication for connectors](https://claude.com/docs/connectors/building/authentication)
- [Anthropic: Troubleshooting connectors](https://claude.com/docs/connectors/building/troubleshooting)
- [Anthropic: Connect Claude Code to tools via MCP](https://code.claude.com/docs/en/mcp)
- [Microsoft Learn: Host MCP servers on Azure Container Apps](https://learn.microsoft.com/en-us/azure/container-apps/mcp-overview) (2026-03-25)
- [Microsoft Learn: Secure MCP servers on Azure Container Apps](https://learn.microsoft.com/en-us/azure/container-apps/mcp-authentication) (2026-05-08)
- [Microsoft Learn: Choose an Azure service for your MCP server](https://learn.microsoft.com/en-us/azure/container-apps/mcp-choosing-azure-service) (2026-06-02)
- [Microsoft Learn: Secure MCP servers with Microsoft Entra authentication (App Service)](https://learn.microsoft.com/en-us/azure/app-service/configure-authentication-mcp-server-vscode) (2026-04-27)
- [Microsoft Learn: Build a custom remote MCP server using Azure Functions](https://learn.microsoft.com/en-us/azure/azure-functions/scenario-custom-remote-mcp-server) (2026-07-03)
- [obot.ai: MCP OAuth Dynamic Client Registration with Entra](https://obot.ai/blog/mcp-dynamic-client-registration-entra/) — blog, corroborating only
