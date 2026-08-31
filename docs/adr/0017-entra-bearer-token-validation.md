# 17. Validating Entra ID bearer tokens ourselves

**Status:** accepted
**Date:** 2026-08-28
**Follows:** [ADR 0016](0016-streamable-http-transport.md)

## Context

ADR 0016 shipped an HTTP endpoint that announces on every start that anyone who
can reach it can spend the operator's provider credits. Issue #37 closes that:
`/mcp` must refuse any request that does not carry a bearer token minted by the
configured Microsoft Entra ID tenant, for this server, with the right
permission.

`docs/research/remote-mcp-2026-08.md` §5.1 leaves the *deployment* question open
(Container Apps "Easy Auth" in front of us, or not). That is deliberately not
settled here. If the platform validates a token, we validate it again: the check
is cheap, and a server that is only safe because of where it happens to be
deployed is not safe.

## Decision

**Validation lives in `src/transport/`, in front of `handleMcpPost`, and is
configured entirely by environment.** Four variables, all unset meaning "off":

| Variable                       | Meaning                                             | Default                                              |
| ------------------------------ | --------------------------------------------------- | ---------------------------------------------------- |
| `IMAGINE_AUTH_TENANT_ID`       | The Entra tenant whose keys and `tid` we accept      | —                                                    |
| `IMAGINE_AUTH_ISSUER`          | Accepted `iss`                                       | `https://login.microsoftonline.com/<tenant>/v2.0`    |
| `IMAGINE_AUTH_AUDIENCE`        | Accepted `aud`, comma separated                      | — (required once auth is on)                          |
| `IMAGINE_AUTH_REQUIRED_SCOPE`  | Accepted `scp` entries or `roles` entries, any one   | `access_as_user`                                     |

**Off means byte-for-byte what it was.** With none of them set,
`authSettingsFromEnv` returns `null`, `startHttpServer` gets no `authenticate`,
and no request touches a line of this code. The local stdio and loopback stories
are untouched. **Half-configured is a startup error, not a silent fallback** —
failing open because a variable was misspelled is the one outcome that must be
impossible.

**No new dependency: verification is WebCrypto, in `src/transport/jwt.ts`.**
`jose` is the obvious alternative and hand-rolling JWT validation is the
classic way to ship an authentication bypass, so this needs justifying rather
than assuming. What we actually need is a strict subset: verify one RSA
signature over a compact JWS, against a JWKS we fetch ourselves, and compare a
handful of claims. Node 20 gives us `crypto.subtle.verify` and `fetch`, so the
library would contribute key import and a claim loop — perhaps eighty lines —
against a supply-chain surface on the credential path of the whole server and a
second decoder to keep current. The attacks a JWT library is famous for
preventing are closed here explicitly, and each one is a test:

- **`alg: none`** — the algorithm is looked up in a constant allowlist, and
  `none` is not in it. There is no code path in which a signature is not checked.
- **Algorithm confusion (HS256 signed with the public key as the secret)** — the
  allowlist contains only RSA algorithms, and the key is imported as RSA for the
  algorithm named by the allowlist entry, never by the token. An `HS256` header
  fails the lookup before any key material is touched.
- **Key substitution** — the key is chosen by `kid` from the tenant's published
  JWKS. A token with no `kid`, or one naming a key the tenant does not publish,
  is refused; embedded `jwk`/`jku`/`x5u` headers are never read.
- **`crit`** — a token declaring critical extensions is refused rather than
  having them ignored.
- **Sloppy decoding** — each segment must be base64url and the payload must be a
  JSON object.

If this grows a second token format, encrypted tokens, or EC and Ed keys, that
is the point to take `jose` instead; the seam is one module wide.

**The claim rules.** `iss` must equal the configured issuer exactly. `aud` must
match a configured audience **canonicalised as a resource** — lower-cased scheme
and host, trailing slash dropped, **path kept** — because Entra hands back the
Application ID URI and the operator may type it in a different shape, while the
path is exactly the part that must not be lost (research §3.3: Claude sends the
full MCP URL, path included, as the RFC 8707 `resource`). `tid`, when present,
must be the configured tenant. `exp` is required — a token that never expires is
refused — and `nbf` is honoured. **Clock skew is a constant 60 seconds**, applied
to both, small and explicit rather than configurable. Finally one of
`IMAGINE_AUTH_REQUIRED_SCOPE` must appear in `scp` (delegated, from a human) or
in `roles` (application, from an agent's service principal); the server does not
care which flow minted the token.

**Statuses follow RFC 6750, not convenience.** Missing token, unusable token,
bad signature, wrong issuer, wrong audience, wrong tenant, expired: **401** with
a `WWW-Authenticate: Bearer` challenge. Valid token without the permission:
**403 `insufficient_scope`** — the caller has authenticated and retrying with a
new token of the same shape will not help. The tenant's keys being unreachable is
**503**, not 401: the token is unproven, not bad, and a client must not be told
to go and get another one. Every failure is a transport status with a JSON-RPC
error body, never a tool-level error envelope — the client has to see the status
to know what to do.

**The challenge is a parameter, so issue #36 is an addition and not a change.**
`bearerChallenge` takes extra parameters and `startHttpServer` takes
`challengeParams`; #36 puts `resource_metadata` there and nothing else about
the 401 moves. A missing token gets a bare `Bearer` challenge with no `error`,
which is what the hosted Claude surfaces need to begin OAuth discovery.

**`/healthz` stays open.** Probes and load balancers are not callers, and the
document it returns is the version string.

**The validated caller crosses the seam as `RequestContext`.**
`HttpTransportOptions.createServer` now takes `{ caller }`, where `caller` is a
`CallerIdentity` — `callerId` (`tid:oid`, the ledger key), `subject`,
`objectId`, `tenantId`, `username`, `clientId` for agent tokens, `scopes`,
`roles`, and the whole verified `claims` set for anything not named. Issue #45
consumes exactly this and nothing in `src/mcp/` has to learn about HTTP to get
it. **Nothing here is logged**: not the token, not the claim set. `describeCaller`
exists so that the one thing that may be logged is an identifier.

**The JWKS cache respects rotation without trusting the caller.** Keys are
fetched from the `jwks_uri` in the tenant's OpenID configuration and cached for
ten minutes. A `kid` we have never seen is the rotation signal and triggers one
refresh — but no more often than once a minute, so a stream of tokens naming
invented key ids cannot be used to make this server hammer the tenant.

## Consequences

The banner flips: with auth configured, the block-capital unauthenticated
warning is replaced by the tenant, issuer, audience and required permission it
will enforce. An operator can see from one line of stderr which of the two modes
they are in.

`budget.max_usd_per_session` is still one shared bucket (ADR 0016), but the
identity needed to fix that now exists at the tool boundary. Per-caller budgets,
`caller_id` on every cost record and per-tool app roles are issue #45's, not
this one's.

A live smoke test against a real tenant is not something CI can do; the unit
tests mint their own RSA keys and serve their own JWKS through an injected
`fetch`, so no test touches the network. The live check belongs in
`docs/deploy/azure-wizard.md` with the rest of the tenant setup, including the
Application ID URI trap in research §3.3.
