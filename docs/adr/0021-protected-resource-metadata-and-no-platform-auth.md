# 21. Protected-resource metadata, served by us, and no platform auth

**Status:** accepted
**Date:** 2026-09-03
**Follows:** [ADR 0016](0016-streamable-http-transport.md),
[ADR 0017](0017-entra-bearer-token-validation.md),
[ADR 0020](0020-the-azd-template.md)
**Closes:** issues #36 and #38

## Context

ADR 0017 shipped a `/mcp` that refuses an unauthenticated request with a `401`
and a bare `WWW-Authenticate: Bearer` challenge. That is correct and it is not
enough. A `401` with nothing in it tells a client only that it is unwelcome, not
where to go — so claude.ai, Claude Desktop and Claude mobile cannot begin OAuth
and report the useless "Couldn't reach the MCP server". The MCP authorization
spec says an MCP server **must** implement OAuth 2.0 Protected Resource Metadata
(RFC 9728), and Anthropic's connector documentation says what happens when it
does not (`docs/research/remote-mcp-2026-08.md` §3.2).

Two questions were open, filed as two issues, and they turn out to be one
decision:

- **#36.** Serve the metadata document and point the challenge at it.
- **#38.** A timeboxed spike: can Container Apps built-in authentication ("Easy
  Auth") take part in that handshake instead?

## Decision

### The discovery handshake lives in `src/transport/`

`src/transport/protected-resource.ts` builds the RFC 9728 document and the two
URLs around it; `src/transport/http.ts` serves it and points the challenge at it.

**Two paths, both serving the same document.** RFC 9728 puts the well-known
segment *before* the resource's own path, so an endpoint at `https://host/mcp`
publishes at `https://host/.well-known/oauth-protected-resource/mcp`. The
clients probe that spelling first, and it is the one the challenge names. The
bare `/.well-known/oauth-protected-resource` is served as well, because it costs
one array entry and a client that asks for it is not wrong.

**Both paths are unauthenticated, and they are matched before the origin check
and before the token check.** This is the whole point of the document: a client
that cannot read it while unauthenticated has no way to become authenticated.
`/healthz` stays open for the same practical reason it always was.

**`resource` is configuration, never the `Host` header.** Behind Container Apps
ingress — or any proxy — the host a request arrives with is the platform's
internal one, and a `Host` header is attacker-controlled besides. The value must
be the URL the user types into their client, path included, because Claude sends
exactly that string as the RFC 8707 `resource` on the authorization and token
requests. Three sources, in order:

| Variable                    | Meaning                                                        |
| --------------------------- | -------------------------------------------------------------- |
| `IMAGINE_MCP_RESOURCE_URI`  | The endpoint URL whole, for a proxy that rewrites the path      |
| `IMAGINE_PUBLIC_URL`        | The public origin; `/mcp` is appended                           |
| *(fallback)*                | The first `IMAGINE_AUTH_AUDIENCE` entry that is an http(s) URL  |

The fallback is not a guess: ADR 0017 already requires the endpoint URL itself
to be an accepted audience, and the azd template puts it first in the list. It
means a deployment that followed the runbook publishes correct metadata without
learning a new variable. Whatever the source, the value is canonicalised the
same way an audience is — lower-cased scheme and host, no default port, no
query, no fragment, no trailing slash, **path kept** — so that the document, the
challenge and the audience check cannot disagree about what this server is
called.

**The document says only what is true.** `resource`, one entry in
`authorization_servers` (the tenant's v2.0 issuer, which serves OpenID Connect
discovery at its own well-known path), `scopes_supported` from
`IMAGINE_AUTH_REQUIRED_SCOPE`, `bearer_methods_supported: ["header"]`, and a
`resource_name`. One authorization server, because Claude uses the first entry
and does not fall back to later ones — a second entry would be decoration that
looks like a fallback.

**The pointer rides on the `401` and on nothing else.** ADR 0017 left
`challengeParams` as the hook for this, and it is filled in with
`resource_metadata` and `scope`. A `403 insufficient_scope` keeps its RFC 6750
challenge but gets no pointer: that caller is already authenticated and another
login will not help. A `503` gets none either: the tenant's keys being
unreachable is our problem, and sending the client through a consent screen to
discover that would be a lie. This mirrors the one implementation we have that
demonstrably works with real clients.

**Auth off means none of this exists.** With no `IMAGINE_AUTH_*` set there is no
document, no route (the well-known paths are a plain `404`) and no challenge —
the local and LAN stories are untouched, which is what keeps a developer machine
from growing a login screen.

### Easy Auth stays off, permanently, and #36 is why

**Decision: authentication for the MCP endpoint is in-app, and the azd template
configures no platform authentication.** ADR 0020 left this provisional pending
the #38 spike. It is now settled, and settled in the direction ADR 0020 already
guessed.

The spike asked whether Easy Auth *can* serve the handshake. The better question
is whether it should be allowed to, and once #36 exists the answer is no on
grounds that do not depend on the platform's behaviour at all:

1. **The obligation is the MCP server's.** The spec requires the *resource
   server* to publish this document. Serving it is ours whether or not something
   in front of us would also do it.
2. **We already validate the token ourselves** (ADR 0017), on the principle that
   a server which is only safe because of where it is deployed is not safe.
   Given that, platform validation adds a second place to be misconfigured and
   removes nothing.
3. **The same image must run in four places** — a laptop, a LAN box, a Docker
   host, Container Apps. Auth that lives in the platform is auth that vanishes
   in three of them, and a discovery handshake that only exists in production is
   a handshake nobody can test.
4. **`Return401` is actively incompatible.** In that mode the platform answers
   the unauthenticated request itself, in a shape nobody has documented for
   Container Apps, and it stands in front of `/.well-known/*` — the one route
   that must answer while the caller has no token. A path-exclusion mechanism
   for Container Apps auth is not documented either. That is two undocumented
   behaviours on the critical path of the connection story.
5. **The one documented lever is App Service's.**
   `WEBSITE_AUTH_PRM_DEFAULT_WITH_SCOPES` is an App Service setting; Container
   Apps says it uses "the same system with some differences" and its own MCP
   auth article shows only a bearer token pasted from `az account
   get-access-token` — never a discovery flow (research §5.1). Building on an
   undocumented spillover is how you get a deployment that breaks on a platform
   update nobody announced.

**What was and was not verified.** The four capture-the-headers questions in #38
were not run against a live container app, and this ADR does not claim they
were. They no longer gate anything: every one of them asks how well Easy Auth
performs a job we have decided it will not be given. The evidence this decision
does rest on is the research note's §3.2 and §5.1 (Anthropic's connector and
troubleshooting documentation, Microsoft's Container Apps and App Service auth
documentation), RFC 9728, and a working Entra-authenticated MCP server in
another codebase whose 401-plus-`resource_metadata` flow and path-suffixed
well-known route this implementation deliberately mirrors.

**What would reopen it.** Two things, and only these:

- Microsoft documenting, for Container Apps specifically, both a
  protected-resource-metadata setting and a path exclusion for `/.well-known/*`.
  Even then the in-app route stays, because of point 1; the platform would at
  most become a second, redundant gate.
- An operator requirement for pre-authentication at the edge — a tenant that
  will not expose an endpoint that terminates its own auth. The compatible shape
  is Easy Auth in **`AllowAnonymous`**, with our layer still producing the 401
  and still serving the metadata. `Return401` is never the answer.

## Consequences

`curl -i https://host/mcp` with no token now answers `401` with
`WWW-Authenticate: Bearer resource_metadata="https://host/.well-known/oauth-protected-resource/mcp", scope="access_as_user"`,
and that URL answers `200` with a document whose `resource` is `https://host/mcp`
exactly. The runbook's step 7b, written as blocked on #36 and #38, is now a
check that can pass, and the caveat under it is gone.

The banner gained two lines when auth is on — the resource and the metadata URL
— and a block-capital warning when auth is on but no public URL could be
derived, because metadata that cannot be published is a connection failure the
operator should hear about at startup rather than from Claude.

The azd template is unchanged and remains correct: it configures no platform
auth, and its `IMAGINE_AUTH_AUDIENCE` already carries the MCP URL first, which
is what the fallback reads. Setting `IMAGINE_MCP_RESOURCE_URI` explicitly from
the template's `mcpResourceUri` would remove the last piece of inference and is
a one-line follow-up on the infrastructure issue, not a correction.

What this does **not** do is make the hosted Claude surfaces work end to end.
Discovery now succeeds; the remaining obstacle is Entra's lack of RFC 7591
dynamic client registration (research §3.4), which is a client-registration
problem and a separate issue. Nothing here changes that, and nothing here is
wasted on it either: the same document is what a pre-registered client and a
CIMD client would read.
