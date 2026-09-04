# 23. Issuer mode: WorkOS AuthKit in front of Microsoft login

**Status:** accepted
**Date:** 2026-09-04
**Follows:** [ADR 0017](0017-entra-bearer-token-validation.md),
[ADR 0021](0021-protected-resource-metadata-and-no-platform-auth.md)
**Closes:** issue #56

## Context

Adding the deployed endpoint to Mistral Le Chat, claude.ai or Cowork by URL
alone stops at *"this connector does not support Dynamic Client Registration"*.
That is not a bug in our server and it is not a bug in the client: Entra ID
publishes no `registration_endpoint` and supports no Client ID Metadata
Documents, so a chat client has nothing to register itself against. Every hosted
client therefore needs a hand-made OAuth client app registration with that
client's redirect URI and a secret the operator pastes in. That works for one
person and does not survive "share the URL with your team".

`docs/research/auth-servers-2026-09.md` (2026-09-04) went through the
alternatives and recommends **WorkOS AuthKit** as the authorization server in
front: dynamic client registration and CIMD are dashboard toggles, Microsoft is
a *free social provider* rather than a metered enterprise SSO connection, and
the free tier runs to a million monthly active users. Waiting for Entra is not a
plan, and writing our own authorization server is a different order of magnitude
from the token verification ADR 0017 justified hand-writing.

## Decision

**We add an OIDC *issuer mode*, not a WorkOS integration.** Nothing in
`src/` names WorkOS. The mode is chosen by configuration and works for any
authorization server that publishes a discovery document and signs RSA JWTs.

**`IMAGINE_AUTH_ISSUER` is the switch; `IMAGINE_AUTH_TENANT_ID` becomes
optional.** One of the two must be set once authentication is on, and that is
still a startup error rather than a silent fallback. With a tenant, everything
is exactly as it was — the discovery URL, the issuer default, the `access_as_user`
scope default, the `tid` check. With an issuer and no tenant:

- **Discovery is derived from the issuer**, and both well-known documents are
  tried in order: `/.well-known/oauth-authorization-server` (RFC 8414, the one
  WorkOS documents) and then `/.well-known/openid-configuration`. Only the
  `jwks_uri` is read out of whichever answers, exactly as before.
  `IMAGINE_AUTH_METADATA_URL` replaces the derivation outright.
- **The `tid` check is skipped, not defaulted.** A token from a WorkOS instance
  carries no `tid`; defaulting the setting to the deployment's own tenant would
  turn a check nobody can pass into a wall. The rule is now "check `tid` only
  when a tenant is configured", and the azd template deliberately does not fill
  a tenant in when the issuer is set.
- **No scope is required by default.** AuthKit's metadata advertises
  `["email", "offline_access", "openid", "profile"]` and its documentation
  describes no custom scopes, so an `access_as_user` default would make every
  login fail at the authorization request. In issuer mode an empty
  `IMAGINE_AUTH_REQUIRED_SCOPE` means *no scope check*: the authorization
  decision is "the issuer let this person in and minted a token for this exact
  resource". Configure a scope and it is enforced there just as in Entra mode.

**`callerId` falls back to `iss` + `sub`.** It stays `tid:oid` whenever a tenant
is known. With neither `tid` nor a configured tenant it becomes
`<issuer>:<sub>`, which is the pair OIDC guarantees to be stable, and which is
what issue #45's cost ledger will key on. `CallerIdentity` also gained `email`
and `name`, read from the standard OIDC claims when present, because a federated
Microsoft login arrives as a WorkOS user and the Entra `oid` is simply not there
any more.

**The protected-resource document needed no new logic.** ADR 0021 already
publishes `auth.issuer` as the single `authorization_servers` entry, so in
issuer mode that entry is the AuthKit domain and the client discovers DCR/CIMD
there. The one change is that `scopes_supported` and the `scope` parameter of
the `401` challenge are **omitted** when no scope is required, rather than
published as an empty list — advertising nothing is honest; advertising
`""` is a client bug waiting to happen.

**The audience rule does not move.** WorkOS honours RFC 8707 resource
indicators: *"Access tokens will be issued with an `aud` claim that matches the
requested `resource`"*, which is the full MCP URL the client typed. The azd
template already puts `https://<fqdn>/mcp` first in `IMAGINE_AUTH_AUDIENCE`, so
the deployed default is already right. The operator's part is to add that exact
URL as a **Resource Indicator** in the WorkOS dashboard; without it AuthKit
falls back to an environment-scoped audience and every call is a `401`.
`IMAGINE_AUTH_AUDIENCE` can now also be set as an azd variable to replace the
computed list outright.

**What stays Entra-only.** The `tid` check, the Entra hook and its app
registration, `api://<client-id>` and bare-client-id audiences, the Azure CLI
token route in the runbook, and the `access_as_user` default. Entra mode is
byte-for-byte what it was, and the tests assert that: the same settings object,
the same single discovery URL, the same `tid:oid` caller id.

## Consequences

The operator gains a second, differently-shaped setup: a WorkOS account, two
dashboard toggles, one Resource Indicator and Microsoft enabled as a social
provider, in exchange for connectors that can be added by URL alone.
`docs/deploy/azure-wizard.md` §6e is that checklist; `docs/hosting.md` documents
the mode for anyone not on Azure at all.

Federated login changes who the caller *is*. With Microsoft as a WorkOS social
provider, any Microsoft account can sign in unless membership is restricted in
AuthKit — tenant restriction is no longer something the token proves. Anyone
who needs it must enforce it in AuthKit (an organization membership rule, or a
paid Enterprise SSO connection at about $125/mo) rather than assuming the `tid`
check is still doing it. The banner says which mode it is in, and in issuer mode
says in as many words that the tenant claim is not checked and that no scope is
required.

**Verified from vendor documentation on 2026-09-04**: the issuer form
`https://<project>.authkit.app`; the JWKS endpoint `<issuer>/oauth2/jwks`; the
RFC 8414 metadata document at `<issuer>/.well-known/oauth-authorization-server`
with `scopes_supported: ["email", "offline_access", "openid", "profile"]` and a
`registration_endpoint`; `token_endpoint_auth_methods_supported` including
`none`; DCR and CIMD as toggles under **Connect → Configuration**; Resource
Indicators configured in the dashboard, with `aud` matching the requested
`resource` and an environment-scoped default when none is registered.

**Not verified, and the design accommodates rather than assumes it**: whether an
AuthKit domain also serves `/.well-known/openid-configuration` (hence trying
both paths); whether MCP access tokens carry a `scope`/`scp` claim at all (hence
no required scope by default); and the exact claim names for the federated
Microsoft user's email and name (hence reading the standard `email` and `name`
claims, and tolerating their absence). Nobody has yet completed a hosted-client
connector login against a live deployment in this mode; the server half is
covered by tests against a fake issuer with generated keys.
