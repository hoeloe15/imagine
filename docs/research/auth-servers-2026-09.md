# Auth servers in front of imagine: what makes "paste the URL" work, and what it costs

**Researched 2026-09-04.** Every number below was read off a vendor's own page on
that date; anything I could not confirm from a primary source is marked
**[unverified]**. Follows `docs/research/remote-mcp-2026-08.md` §3, issues #56 and
#48, and ADRs 0017 / 0021.

## 0. The five-line answer

1. **WorkOS AuthKit** is the recommendation for every stage we can currently see:
   1,000,000 monthly active users free, CIMD *and* DCR as dashboard toggles, and
   "Microsoft" is a free social provider, so people keep signing in with their
   Microsoft account without buying an SSO connection.
2. **Waiting for Entra is not viable.** Entra has no DCR and no CIMD, and
   Microsoft has announced neither; Agent ID is about Microsoft's own agents, not
   about third-party chat clients registering themselves.
3. **Do not build it ourselves.** The MCP TypeScript SDK gives us a proxy shell,
   not an authorization server — we would still own consent, storage, token
   issuance, rotation and revocation, forever.
4. **Cost stays at zero** for a personal toolbox, a small team, and well past the
   first paying customers; the first real bill is an Enterprise SSO connection
   (~$125/mo) if a customer insists on locked-down tenant SSO.
5. **What changes in imagine is small**: the tenant-derived OIDC discovery URL
   and the Entra-specific `tid` check have to become configuration rather than
   assumptions. Nothing else in ADR 0017 moves.

## 1. Free tiers, side by side

| Vendor | Free tier (exact) | First paid tier | Source (fetched 2026-09-04) |
| --- | --- | --- | --- |
| **WorkOS AuthKit** | **First 1M MAU** free | $2,500/mo per additional 1M MAU | [workos.com/pricing](https://workos.com/pricing) |
| **Clerk** | **50,000 MRU/app**, 100 orgs, **0** enterprise connections | Pro **$25/mo** ($20 annual), $0.02/MRU over 50k | [clerk.com/pricing](https://clerk.com/pricing) |
| **Entra External ID** | **First 50,000 MAU** free | per-MAU price not published — calculator/sales only **[unverified]** | [microsoft.com/security/pricing/microsoft-entra-external-id](https://www.microsoft.com/en-us/security/pricing/microsoft-entra-external-id/) |
| **Auth0 (Okta)** | **25,000 MAU**, **1** enterprise connection | B2C Essentials from **$35/mo**; B2B from **$150/mo** | [auth0.com/pricing](https://auth0.com/pricing) |
| **Stytch** | **10,000 MAU + agents**, **5** SSO/SCIM connections, 1,000 M2M tokens | pay-as-you-go: $125 per extra SSO connection | [stytch.com/pricing](https://stytch.com/pricing) |
| **Descope** | **7,500 MAU**, 10 active tenants, **3** SSO connections | Pro **$249/mo** | [descope.com/pricing](https://www.descope.com/pricing) |
| **Scalekit** | ~7,500 MAU + 3 SSO connections **[unverified — two pricing surfaces, see §6]** | Growth $249/mo | [scalekit.com/pricing](https://www.scalekit.com/pricing) |
| **Keycloak** | Free software (Apache 2.0); you pay hosting | ~2 GB container + a Postgres — call it €20–40/mo on Azure | [keycloak.org/server/containers](https://www.keycloak.org/server/containers) |
| **Cloudflare workers-oauth-provider** | Workers free: 100k req/day; KV free: 100k reads / 1k writes per day | Workers Paid **$5/mo** (needed in practice for KV write volume) | [developers.cloudflare.com/workers/platform/pricing](https://developers.cloudflare.com/workers/platform/pricing/) |

**The trap in this table is not MAU, it is connections.** Auth0, Stytch, Descope,
Scalekit and Clerk all treat "log in with your company's Microsoft account" as an
*Enterprise SSO connection* and meter it. Clerk is the sharpest: zero connections
on free, and $75/mo for the second one on top of Pro. WorkOS is the only vendor
here where the ordinary Microsoft sign-in is a **free social provider**
([workos.com/docs/user-management/social-login](https://workos.com/docs/user-management/social-login),
fetched 2026-09-04) sitting outside the $125/mo Enterprise SSO product.

## 2. Client registration support

| Vendor | DCR (RFC 7591) | CIMD | Entra federation | Notes |
| --- | --- | --- | --- | --- |
| WorkOS | opt-in toggle | **opt-in toggle, shipped** | free as Microsoft social; $125/mo as Enterprise SSO | [docs](https://workos.com/docs/authkit/mcp) |
| Auth0 | off by default, opt-in | shipped, but **admin-mediated**: an admin pastes the CIMD URL and approves | Enterprise Connection (1 free, then $100/mo each) | [CIMD doc](https://auth0.com/docs/get-started/auth0-overview/create-applications/register-applications-with-cimd) |
| Stytch | opt-in toggle | **beta**, opt-in (changelog 2025-10-17) | SSO connection (5 free) | [MCP doc](https://stytch.com/docs/connected-apps/guides/remote-mcp-servers) |
| Cloudflare | opt-in (`clientRegistrationEndpoint`) | **opt-in, most mature implementation found** — tracks `draft-ietf-oauth-client-id-metadata-document-00` | you wire it yourself in Worker code | [CHANGELOG](https://github.com/cloudflare/workers-oauth-provider/blob/main/CHANGELOG.md) |
| Keycloak | yes, but anonymous registration **disabled by default** (no whitelisted hosts) | **experimental**, behind `--features=cimd`, "may introduce breaking changes" | free (identity brokering, core OSS) | [MCP doc](https://www.keycloak.org/securing-apps/mcp-authz-server), issues [#45106](https://github.com/keycloak/keycloak/issues/45106), #49730, #50362 |
| Descope | yes, default-on status **[unverified]** | claimed in docs, no changelog depth found | SAML/OIDC; tier gating **[unverified]** | [docs.descope.com/mcp](https://docs.descope.com/mcp) |
| Scalekit | supported, toggleable | supported, marketed prominently | Entra SAML, within SSO connection quota | [docs](https://docs.scalekit.com/guides/mcp/oauth/) |
| Clerk | yes | yes | **paid add-on**, Pro + $75/mo after the first | [MCP guide](https://clerk.com/docs/expressjs/guides/ai/mcp/build-mcp-server) |
| **Entra ID** | **no** | **no** | n/a (it *is* Entra) | see §3 |

**Cloudflare's catch, and it is a big one:** `workers-oauth-provider` issues
**opaque tokens**, stored only as hashes, with **no JWKS endpoint**. A resource
server cannot validate them offline — it has to call back into the Worker. That
is incompatible with everything ADR 0017 built, so Cloudflare is out unless we
move the MCP server itself onto Workers.

**Keycloak's catch:** its own MCP page says it fully supports MCP revision
2025-03-26 and later revisions only "Partially Supported without Resource
Indicators for OAuth 2.0" — and RFC 8707 resource indicators are precisely what
Claude sends and what ADR 0017 validates. Issue #50362 records Claude Desktop
being rejected by Keycloak's CIMD flow. Not ready.

## 3. Microsoft Entra ID: nothing has changed, and nothing is announced

- **No DCR.** Entra publishes no `registration_endpoint`. The only Microsoft DCR
  documentation is scoped to M365 Copilot plugins, a different product
  ([learn.microsoft.com](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/plugin-authentication-dynamic-client-registration)).
  This is absence of evidence, not a "never" from Microsoft — but there is no
  2026 announcement, changelog entry or roadmap item saying otherwise.
- **No CIMD.** No Microsoft source found. A well-regarded community analysis
  ([merill/mcp-entra-design](https://github.com/merill/mcp-entra-design)) states
  flatly that Entra supports neither and calls it deliberate; its "what might
  change" section says explicitly that none of it is announced. That is a blog,
  not a vendor commitment.
- **Entra Agent ID is GA** (Microsoft Learn, `ms.date: 2026-05-01`) but it is
  about giving *our own* agents enterprise identities — conditional access,
  governance, workload federation. Nothing in it lets a third-party chat client
  register itself as a public OAuth client. It does not solve #56. Pricing is
  reportedly $15/user/mo standalone or bundled in M365 E7 **[unverified — I could
  not reach a Microsoft pricing page for it]**.
- **What Microsoft *does* document** is exactly what we already do: Entra as
  authorization server with **pre-authorized, hand-registered clients**
  ([Building MCP servers with Entra ID and pre-authorized clients](https://techcommunity.microsoft.com/blog/azuredevcommunityblog/building-mcp-servers-with-entra-id-and-pre-authorized-clients/4508453)).
  That is the ceiling of the current design, and it is a per-client, per-tenant
  manual step.

**Conclusion: option 2 in issue #56 — "wait for Entra CIMD" — is not a plan.**

## 4. What the clients actually need

The current MCP revision is **2026-07-28**
([spec versioning](https://modelcontextprotocol.io/specification/versioning)).
CIMD landed in the 2025-11-25 revision (SEP-991) and 2026-07-28 carries the
deprecation forward: *"Dynamic Client Registration is deprecated. New
implementations should use Client ID Metadata Documents instead."* The client
preference order is pre-registered credentials → CIMD → DCR → prompt the user.

| Client | DCR | CIMD | Pre-registered id/secret | Source |
| --- | --- | --- | --- | --- |
| claude.ai / Desktop / mobile / **Cowork** | out of the box | **shipped** (`oauth_cimd`), chosen only if the AS advertises `client_id_metadata_document_supported: true` **and** `none` in `token_endpoint_auth_methods_supported` | yes, org-scoped, admin-supplied | [claude.com/docs/connectors/building/authentication](https://claude.com/docs/connectors/building/authentication) |
| Claude Code | automatic | **shipped** — identifies itself with its own CIMD at `https://claude.ai/oauth/claude-code-client-metadata` | `--client-id` / `--client-secret` | [code.claude.com/docs/en/mcp](https://code.claude.com/docs/en/mcp) |
| Mistral Le Chat | **yes** — "OAuth 2.1 (with dynamic client registration)" | not mentioned **[unverified — docs.mistral.ai blocked our fetch; only a search summary]** | not documented | [docs.mistral.ai MCP connectors](https://docs.mistral.ai/le-chat/knowledge-integrations/connectors/mcp-connectors) |
| ChatGPT connectors / dev mode | supported "when configured" | **shipped and recommended**; ChatGPT's own client id is `https://chatgpt.com/oauth/client.json` (changelog 2026-08-21) | yes | [developers.openai.com/api/docs/mcp](https://developers.openai.com/api/docs/mcp) |
| Codex CLI/Desktop | OAuth 2.1 + PKCE via RFC 8414 for HTTP servers | **[unverified]** — no authoritative OpenAI doc found | unclear **[unverified]** | GitHub issues only |

**The operative fact:** every client that matters does DCR, and the ones that
matter most also do CIMD. An authorization server that switches both on satisfies
all of them at once. The Mistral error in #48 was never a Mistral problem — it was
Entra having nothing to register against.

## 5. Building it ourselves: what the SDK actually gives us

Installed here: `@modelcontextprotocol/sdk` **1.30.0** (npm `latest`, 2026-09-04).
It ships `server/auth/` with `mcpAuthRouter`, handlers for
`authorize`/`token`/`register`/`revoke`/`metadata`, and one provider:
`ProxyOAuthServerProvider`. The `main` branch is **v2** (implementing the
2026-07-28 spec) but is **not published to npm** — no 2.x version exists on the
registry; in v2 the auth handlers have moved under an
`@modelcontextprotocol/server-legacy` namespace, and the v2 docs emphasise
client-side auth and token verification rather than provider helpers. Building on
them means building on something being deprecated.

What the 1.x helpers are is a **router plus an interface we implement**:

```
OAuthServerProvider: clientsStore, authorize, challengeForAuthorizationCode,
  exchangeAuthorizationCode, exchangeRefreshToken, verifyAccessToken, revokeToken?
```

`ProxyOAuthServerProvider` forwards those to an upstream server; it does not
create clients, so it inherits Entra's lack of DCR. To fix #56 ourselves we would
have to write the parts the SDK deliberately leaves empty: a client registry
(with CIMD fetching, caching, and SSRF defence), a consent screen, authorization
code and refresh token storage with rotation and revocation, PKCE, and token
signing with a published JWKS. Plus `express`, which this repo does not currently
depend on — `src/transport/http.ts` is plain Node `http`.

That is a security-critical, permanently-maintained product sitting on the
credential path of every call. ADR 0017 justified hand-writing *token
verification* — eighty lines with a closed threat list. Hand-writing an
*authorization server* is a different order of magnitude, and the same reasoning
that justified the first says no to the second.

## 6. Uncertainty, stated plainly

- **Mistral CIMD support is genuinely unknown.** Their docs page refused our
  fetch; the search summary mentions DCR only. Since WorkOS can run DCR and CIMD
  simultaneously, this does not change the recommendation.
- **Scalekit's pricing could not be pinned down**: their site shows an AgentKit
  tool-call pricing page (free 5,000 calls/mo, Growth $99/mo) that is a *different
  product* from the B2B auth product, and the auth numbers came from blog
  citations, not a clean pricing-page read. Do not quote Scalekit numbers.
- **Entra External ID's per-MAU price above 50,000** is not published.
- **Auth0's "from $35/mo" MAU band** (reportedly 500 MAU) is third-party sourced.
- **Descope's Entra tier gating** and **Clerk's token shape (JWT vs opaque)**
  were not confirmable from primary docs. Both are only ranked, not chosen.
- Vendor CIMD material generally cites the **2025-11-25** revision, not
  2026-07-28. That is consistent — CIMD was introduced in 2025-11-25 — but no
  vendor page explicitly claims 2026-07-28 conformance.

## 7. Recommendation

### (a) Personal toolbox, shared with a handful of people
**WorkOS AuthKit, free.** Enable both the CIMD and the DCR toggles. Add
"Microsoft" as a social provider so the people we share it with still click
"sign in with Microsoft". Cost: **€0**, and it stays €0 to a million users.
Runner-up: Clerk (50,000 MRU free) if we ever want their UI components — but its
Entra story is a paid add-on, which defeats the point here.

### (b) A small team
**Still WorkOS, still free.** The only thing that would push us to pay is a team
that requires *tenant-restricted* enterprise SSO — Microsoft social login lets
any Microsoft account through, so tenant restriction has to be enforced either by
an AuthKit organization membership rule or by buying one Enterprise SSO
connection at **$125/mo**. Worth deciding deliberately rather than discovering.
Keycloak is the free-forever alternative if that $125 ever offends, but its CIMD
is experimental and its resource-indicator support is partial, so not today.

### (c) The future paid multi-tenant product (#33)
**WorkOS, and it is the strongest fit of the three.** 1M free MAU means auth is
not a cost line until the product is genuinely large, Enterprise SSO is there
when a customer demands it and is priced per customer rather than per user, and
organizations/RBAC are built in. Auth0 is the credible enterprise alternative,
but 25,000 free MAU and $100/mo per enterprise connection make it structurally
more expensive at exactly the scale where it would matter. Revisit if we ever
move the server onto Cloudflare Workers, where the bundled provider becomes
attractive despite opaque tokens.

**Do not** pick Cloudflare (opaque tokens break ADR 0017's whole design),
Keycloak (experimental CIMD, partial resource indicators, and an operational
burden), or self-built (see §5).

## 8. What changes in imagine

Almost nothing at the protocol level — ADR 0021 already derives
`authorization_servers` from `auth.issuer`, so a non-Entra issuer flows through
the protected-resource document unchanged. Three things in `src/transport/auth.ts`
are Entra assumptions that have to become configuration:

1. **`metadataUrl` is computed, not configured.** Today it is hardcoded as
   `https://login.microsoftonline.com/<tenant>/v2.0/.well-known/openid-configuration`.
   It needs its own variable — say `IMAGINE_AUTH_METADATA_URL` — defaulting to the
   Entra shape when a tenant is set. WorkOS would get
   `https://<authkit-domain>/.well-known/oauth-authorization-server`, and the JWKS
   is discovered from it exactly as now (`https://<authkit-domain>/oauth2/jwks`).
2. **`IMAGINE_AUTH_TENANT_ID` must stop being mandatory.** `authSettingsFromEnv`
   currently throws unless a tenant is set. With a non-Entra issuer there is no
   tenant, and the **`tid` check must be skipped rather than defaulted** — it is
   already conditional on the claim being present, so the change is in the config
   validation, not the claim loop. Half-configured must still be a startup error.
3. **`callerId` cannot assume `tid:oid`.** It falls back to
   `settings.tenantId` when `tid` is absent, which would be `undefined` on a
   WorkOS token. It needs to key off `iss` + `sub` when there is no tenant — and
   issue #45's cost ledger depends on that key being stable.

Two things stay exactly as they are and are worth stating: the **audience rule**
(WorkOS honours RFC 8707 `resource` and puts it in `aud`, so the canonicalised
full-MCP-URL comparison keeps working — and the Application ID URI trap from
research §3.3 simply disappears), and the **required-scope rule**, where WorkOS
scopes land in `scp` just as Entra's do.

One new operational fact: the login is *federated*, so the user's Microsoft
identity arrives as a WorkOS user, not as an Entra `oid`. Anything downstream
that wants the Microsoft object id has to read it from a WorkOS profile claim
instead — worth checking before #45 hardens the ledger key.
