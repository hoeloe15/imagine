# 28. The hosted portal: a browser login and a key form, in the same process

**Status:** accepted
**Date:** 2026-09-04
**Follows:** [ADR 0021](0021-protected-resource-metadata-and-no-platform-auth.md),
[ADR 0023](0023-oidc-issuer-mode.md),
[ADR 0025](0025-membership-allowlist.md),
[ADR 0026](0026-runtime-provider-secrets-from-key-vault.md)
**Closes:** issues #60, #61, #64
**Design:** `docs/design/hosted-portal.md` §2.2, §2.3, §2.5

## Context

ADR 0026 made a provider key readable from Key Vault at request time, so a key
set with `az keyvault secret set` is live within a minute. That removed the
redeploy. It did not remove the terminal: setting a key still means an Azure CLI,
a vault name and a machine you trust. The owner asked for the other half — a page
he can open on a phone, sign in to, and paste a key into.

That page cannot be the `imagine ui` of PLAN.md §9. A localhost page cannot see
the hosted deployment's Key Vault, and the data it would show lives in Azure. So
the portal goes where the data is.

The thing that makes this a decision rather than a feature is what the page does:
**it writes a secret.** Everything below follows from taking that seriously.

## Decision

### One process, one identity, one URL

The portal is a family of routes on the existing `node:http` server, under
`/portal`, in the same container. Not a second container app.

Issue #47 reasoned from least privilege towards a split. That reasoning is right
for a gallery and inverts here: the portal's main job is to *write* to Key Vault,
so it needs **more** privilege than the MCP server, not less. Splitting the apps
to give the portal less access and then granting it the one permission the MCP
server lacks is ceremony that buys nothing. One managed identity, one vault
grant, one FQDN, no CORS — and a key saved in the browser is usable by the same
process that serves tools, which is what makes "it just works now" observable in
one place.

The cost, named rather than hidden: the endpoint that serves tools now also
parses cookies and renders HTML, and there is no privilege separation between
"reads images" and "writes secrets". Accepted for a single-owner toolbox.

**The escape hatch is real and it is cheap.** Everything portal-shaped lives in
`src/portal/` behind one factory taking the same core dependencies the MCP server
gets, and `src/transport/http.ts` knows only a `PathHandler` — which paths are
someone else's, and how to hand a request over. A second container app is a
second `Containerfile`, a second service in `azure.yaml`, a second Bicep block
and a different composition root calling the same factory. A day of
infrastructure work, which is the same test ADR 0016 applied to the transports.

### The two doors never meet

- `/mcp` reads `Authorization` and **ignores cookies entirely.**
- `/portal/*` reads the session cookie and **ignores `Authorization` entirely.**

The separation is at the route table, not inside a handler, so a browser session
can never make a tool call cross-site and a leaked bearer token can never write a
secret. Both ask the same authoriser — the allowlist of ADR 0025 — whether
the person behind the credential is welcome, so one list governs both doors.

`/mcp` is byte-for-byte what it was: the portal is consulted after `/healthz` and
the metadata document and before the MCP path check, and it claims only `/portal`
and `/portal/…`.

### The login is authorization-code with PKCE, and no client secret

Verified against vendor documentation on 2026-09-04:

| Step | What |
|---|---|
| Authorize | `GET /user_management/authorize` with `client_id`, `redirect_uri`, `response_type=code`, `provider=authkit`, `state`, `code_challenge`, `code_challenge_method=S256` |
| Exchange | `POST /user_management/authenticate` with `grant_type=authorization_code`, `client_id`, `code`, `code_verifier`. **`client_secret` is optional**, and `code_verifier` is required in its absence |
| Back | `{ user, access_token, refresh_token, organization_id }` — no `id_token` |

**The client secret is refused by default, for a reason.** WorkOS has no
per-application client secret: the `client_secret` parameter of the token
endpoint *is the environment's API key* (`sk_…`), the credential that administers
users and organisations. Holding a WorkOS admin credential in a container in
order to log one person in is a much bigger thing to hold than an OpenRouter key.
So the portal sends PKCE and nothing else, and falls back to a secret only when
one has been deliberately placed in the vault as `workos-client-secret` — read at
request time by the managed identity, never a deployment parameter, never in a
revision. **This is the chicken-and-egg with exactly one egg**: the portal's own
login credential is the one credential that cannot be entered through the portal.

The three URLs are defaults, not constants (`IMAGINE_PORTAL_AUTHORIZE_URL` and
friends). Nothing in `src/` is WorkOS-only, which is ADR 0023's rule kept.

### Two ways the returned identity is trusted, and both are stated

The exchange returns a JWT. When that token is one the MCP endpoint's own
`Authenticator` accepts — same issuer, same JWKS, same audience rules — it is
validated that way, and there is exactly one set of rules about who this server
trusts.

When it is not (the authorization server's own session token, minted for its API
rather than for this resource), the identity is taken from the `user` object in
the same response. **The trust argument is different and worth writing down:**
that response is the body of a server-to-server HTTPS POST to the token endpoint,
authenticated by a `code_verifier` only this process generated, for a `code`
bound to it. A browser cannot forge it and cannot see it. What is lost is the
signature check — this path trusts TLS and the code exchange rather than a public
key. The allowlist is applied to the result either way.

### The session is a signature, not a session store

One cookie holding `callerId`, `subject`, `email`, `sid` and `exp`, with an
HMAC-SHA256 over them. Nothing inside is secret, so this is a signature: a
tampered cookie fails the check and the visitor logs in again, rather than
decrypting into something the server then believes.

`HttpOnly; Secure; SameSite=Lax; Path=/portal; Max-Age=8h`. `Lax` rather than
`Strict` because the OAuth callback is a top-level cross-site navigation and
`Strict` would drop the cookie on the way back in.

**Stateless on purpose.** The container app runs up to three replicas with no
shared session store; an in-memory session map would log people out at random.
**No refresh in this slice**: sessions expire and you sign in again. Keeping a
refresh token means storing one per user somewhere durable, which is a later
conversation.

The signing key is `IMAGINE_PORTAL_SESSION_SECRET` when set, and **random per
process** otherwise — which means a new revision or a different replica asks for
a fresh login. That is the honest default: safe, and it costs a login rather than
requiring an operator to invent a key before the page works at all.

### What the page will not do

1. **Exist without a login.** With no `IMAGINE_AUTH_*` configured the portal
   routes are not routes — a plain `404` and a startup warning, the way ADR 0021
   makes the metadata document not exist when auth is off. No localhost-only
   convenience mode.
2. **Echo a secret.** The key field is write-only. Presence, source (`vault` /
   `env`) and the *name* of the vault secret; no last-four, no length, no masked
   preview. No route returns a value in any shape, no error message or log line
   contains one, and `Cache-Control: no-store` is on every response.
3. **Change anything on a `GET`.** Every write is a `POST` carrying a per-session
   CSRF token compared in constant time, behind an `Origin` / `Sec-Fetch-Site`
   check. The login leg binds `state` to a short-lived signed cookie and rejects a
   callback whose `state` does not match.
4. **Issue a cookie over plain HTTP**, unless the host is loopback — which is
   what keeps it testable and runnable on a developer machine.
5. **Load anything.** A strict `Content-Security-Policy` with no inline script,
   no inline style and no external origin. Server-rendered HTML and one
   stylesheet served from its own route, so the header is true rather than
   aspirational.
6. **Redirect anywhere it was told to.** The post-login destination is the
   portal's own path, never a URL from the query string.

### Every write leaves an audit line, and the destination is a stopgap

`caller_id`, the action (`secret.set` / `secret.clear`), the target's *name*, the
timestamp and the outcome. It goes to standard error, which hosted is the
container log stream shipped to Log Analytics and therefore survives the revision
that empties the filesystem, and to `audit.jsonl` beside the cost log where there
is one.

**That destination is a stopgap and is written down as one.** When the durable
store lands, these records move there with a `type` field beside the cost
records, so there is one place to answer "who changed what".

### Amendment, 2026-09-04: testing that a key actually works (issue #64)

Saving a key proved only that it was stored. Whether it *works* first showed up
on a paid generation, which is the wrong place to learn it. So the card carries a
**Test key** button — **Test access** where a managed identity is the credential
— behind `POST /portal/verify/<provider>` with exactly the checks the key form is
behind: session, `Origin`/`Sec-Fetch-Site`, and the same per-session CSRF token.

Three things about it are decisions rather than details:

1. **The adapter answers, not the portal.** `ImageProvider` gains an optional
   `verify()`; without one, `core/verification.ts` calls `listModels()`, which is
   a free `GET` for every adapter that has one. So the portal knows nothing about
   any provider, exactly as `/mcp` does not.
2. **The sentence shown is derived, never quoted.** It is built from the HTTP
   status and the `FailureReason` the adapter already maps to — `401` is
   "invalid key", `402` is "no credits" — and never from the provider's response
   body, because a body can echo back what was sent and the sentence is both
   rendered and written to disk. `ImagineError` therefore carries the status
   alongside the reason: a `401` and a `402` are both `auth_failed`, and only one
   of them is a bad key.
3. **Azure is verified honestly, or not called verified.** Azure publishes no
   listing of image deployments, so the check reads the resource's model list. In
   `api_key` mode a `200` is the resource accepting the key and a `401`/`403` is
   it refusing; anything else is reported as having proven nothing rather than as
   a failure. In `entra` mode it means the identity obtained a token for the
   scope a generation would use, and where the resource offers no listing the
   line says outright that this **proves the identity, not the deployment**.
   Three states, not two: verified, rejected, and "the check found nothing out",
   which is amber because an unreachable endpoint says nothing about a key.

The outcome per provider is kept in `verifications.json` beside the cost log —
**the same stopgap as the audit file, and it moves to the durable store with it**
(#45/#17) — and `list_capabilities` reports it as `last_verified`, so a chat
client can say "stored and verified three minutes ago". Every test leaves an
audit line (`provider.verify`) with the caller, the provider and the outcome.

### Bicep adds two strings and no resource

`IMAGINE_PORTAL_ENABLED` and `IMAGINE_PORTAL_WORKOS_CLIENT_ID` pass through from
the azd environment as plain strings, and `IMAGINE_PUBLIC_URL` is filled in from
the container app's own FQDN. Key Vault Secrets Officer on the managed identity
already exists from ADR 0026. Two new outputs — `PORTAL_URL` and
`PORTAL_REDIRECT_URI` — exist because those are the exact strings the operator
must register at the issuer, and a string that must match character for character
should be copied, not retyped.

## Consequences

The owner gains a page and four dashboard registrations: a redirect URI, a logout
return URI, a resource indicator, and a decision about the client. Setting an
OpenRouter key stops being a terminal task. `/setup` (#55) can now honestly
collect everything *except* the key and hand over a link, because a key pasted
into a chat is a key in a transcript.

The endpoint that serves tools now also serves HTML to browsers, and a bug in the
portal is a bug in that process. The mitigation is the seam, not a promise: the
portal is one factory, one directory and one `PathHandler`, and `/mcp`'s tests
pass untouched.

**Not verified against a live authorization server.** Nobody has yet completed a
browser login against a deployed instance. Three things in particular are covered
by tests against fakes rather than by observation: whether the public-client PKCE
exchange really does complete without a `client_secret` for a hand-registered
first-party client; the exact shape of the `authenticate` response, and therefore
which of the two trust paths above actually runs; and whether an AuthKit
organization membership rule blocks a login or only annotates the token — if it
only annotates, `IMAGINE_ALLOWED_SUBJECTS` is the whole gate and has to be right.
The design accommodates all three rather than assuming any of them.
