# 25. A membership allowlist in the server

**Status:** accepted
**Date:** 2026-09-04
**Follows:** [ADR 0017](0017-entra-bearer-token-validation.md),
[ADR 0021](0021-protected-resource-metadata-and-no-platform-auth.md),
[ADR 0023](0023-oidc-issuer-mode.md)
**Closes:** issue #57

## Context

ADR 0023 put WorkOS AuthKit in front of the endpoint so that hosted chat clients
can register themselves, and kept Microsoft as the way people log in — as a
*social* provider, because the enterprise connection is a paid product. That
solved the connector problem and quietly changed who the caller can be.

In Entra mode the `tid` claim answered "is this person from my organisation?".
In issuer mode there is no `tid` at all, and ADR 0023 skips the check rather than
defaulting it. Nothing else in the server restricts membership. So **any
Microsoft account in the world can complete the login** and call
`generate_image` on the owner's OpenRouter credit. The hosted portal
(`docs/design/hosted-portal.md` §2.5) makes it sharper still: once a web page can
write a provider key into Key Vault, "anyone who finds the URL" means "anyone who
finds the URL can replace the key".

AuthKit can restrict this from its own dashboard, with an organization and a
membership rule. That is worth doing and it is not enough on its own. It is also
not certain that it *blocks* the login rather than only annotating the token —
an open question the design records — and even if it does, it is a toggle in
somebody else's web application that nobody in this repository can test.

## Decision

**The server keeps its own allowlist, checked after the token is verified.**
`IMAGINE_ALLOWED_SUBJECTS` is a comma-separated list of the identities this
deployment will serve. Unset means no allowlist, which is byte-for-byte what
every deployment did before this existed.

This is ADR 0021's argument applied one layer up. That ADR refused to let
platform authentication be the gate, on the principle that a server which is only
safe because of where it is deployed is not safe. A server that is only safe
because of a dashboard toggle someone remembered to flick fails the same test.
Both gates, deliberately: the dashboard rule stops the login before a token
exists, and the allowlist is the one this repository can test and this repository
can be held to.

**It is a separate question from authentication, and a separate seam.**
`Authenticator` asks whether the credential is genuine; `Authoriser` asks whether
this person is welcome. The second takes a `CallerIdentity` and returns a
decision, with no bearer token in its signature — which is what lets the portal
call exactly the same function with an identity it read from a session cookie.
The transport calls it after the token check, so `/mcp` is covered today and
`/portal` is covered by construction rather than by someone remembering.

**Entries match the stable subject, and `email:` entries match the email claim.**
`sub` is what OIDC guarantees to be stable and what `callerId` is built from, so
it is the identifier the check is really about; both spellings are accepted,
the bare subject and the whole caller id. But a WorkOS user id is a string nobody
recognises, and the owner setting this up has an email address in his head and no
token in his hand. So `email:someone@example.com` is matched, case-insensitively,
against the verified `email` claim.

That convenience is only as good as the issuer's email verification, and it is
written down as such: WorkOS verifies the address for social logins, which is why
it is offered at all, and an operator who would rather not depend on that lists
subjects. The prefix keeps the two kinds of entry from bleeding into each other —
a bare address never matches a subject, and an `email:` entry never matches one.

**A refusal is `403` with a plain body and no `WWW-Authenticate` at all.** The
token was valid, so `invalid_token` would be a lie and a `401` would send the
client back to a login that will succeed and change nothing — a loop the design
explicitly rules out. ADR 0021 already withheld the `resource_metadata` pointer
from a `403 insufficient_scope`, because that caller is authenticated and another
login will not help. This goes one step further and withholds the challenge as
well: `insufficient_scope` at least names a scope that a differently-shaped token
could carry, whereas here there is no credential the caller could go and get.
The body names the identifier to add, so the refusal is actionable by the person
reading it — which is also the easiest way for the owner to discover his own
subject.

**Half-configured is a startup error.** An allowlist with authentication off has
no verified identity to compare against; it would be a security setting that
silently does nothing, which is worse than no setting at all. So is a variable
that is set but lists nobody, which would refuse every caller including the
owner. Both refuse to start, in the same spirit as `authSettingsFromEnv` refusing
a tenant with no audience.

**The banner reports the state and not the contents.** One line: whether an
allowlist is in force and how many entries it has. A refusal writes one line
naming the rejected caller id — never the token, and the entries themselves are
never printed anywhere.

## Consequences

One new variable, and one behaviour table in `docs/hosting.md` and §6g of the
runbook. Nothing changes for a deployment that does not set it, which is what
keeps every existing test honest and Entra mode exactly as ADR 0023 left it.

The portal (issues #60, #61) inherits the check rather than reimplementing it:
its session handler calls the same `Authoriser` with the identity from the
cookie. That was the reason to make it a seam on `CallerIdentity` rather than an
`if` inside the token path, and it is the thing to hold the portal work to.

The infrastructure half — passing `IMAGINE_ALLOWED_SUBJECTS` through Bicep to the
container app — belongs to the azd template and is tracked with the rest of the
slice-1 infrastructure work.

**What is not settled.** Whether AuthKit's organization-membership rule blocks a
login or only annotates the token is still unverified; if it only annotates, this
allowlist is the whole gate. And nobody has yet confirmed against a live
deployment that the WorkOS `sub` for a federated Microsoft login survives a
re-login unchanged — the reason `email:` exists as a second way to say the same
thing, and the reason the runbook tells the owner to check the banner and the
first refusal rather than assume.
