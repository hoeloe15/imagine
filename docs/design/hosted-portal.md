# The hosted portal

**Status:** design, not built. Nothing here is an ADR yet; the decisions that
survive review become ADRs as each slice lands.
**Date:** 2026-09-04
**Supersedes in spirit:** PLAN.md §9 Phase 2 ("local mini-portal") and the
"local" framing of issues #15, #16, #17, #18, #19.
**Relates to:** #30, #31, #32, #45, #47, #55, and the direction confirmed on #33.

---

## 1. What this is, in one paragraph

Today the owner has an MCP endpoint running in his own Azure, behind a login,
that any AI client can call. What he does *not* have is a place to look at it or
change it. Adding an OpenRouter key means editing a Key Vault secret from a
terminal and redeploying. Seeing what a week of image generation cost means
reading a log file inside a container that is wiped on the next release. Finding
the picture he made on Tuesday is not possible at all.

The portal is that missing half: **one web page, at the same URL as the MCP
endpoint, behind the same login, where the owner can put a key in, set what he
is willing to spend, see what he spent, and look at what he made.**

Phase 2 was written as a page served by `npx imagine-mcp` on localhost. The
direction settled on #33 makes that the wrong shape: the toolbox is hosted, in
the owner's own Azure, reachable from every device. A localhost page cannot see
the hosted deployment's keys, budgets or gallery — those live in Key Vault and
Blob Storage, not on the laptop. So the portal moves to where the data is. The
local `imagine ui` idea is not being replaced by something better; it is being
recognised as a page that would have almost nothing to show.

---

## 2. The five design questions

### 2.1 Where the portal runs

**Recommendation: in the same container as the MCP server, as routes on the
existing `node:http` server, under `/portal`.** Not a second container app.

Issue #47 assumed the portal was phase-2 code being lifted into Azure, and
reasoned from least privilege: a separate app, a separate identity, read-only on
the blob container, because "the portal has no business writing images". That
reasoning is sound for a gallery. It inverts completely for the portal we
actually want, because **the portal's main job is to write a secret into Key
Vault** — it needs *more* privilege than the MCP server, not less. Splitting the
apps to give the portal less access, and then granting it the one permission the
MCP server does not have, is ceremony that buys nothing.

What one container buys:

- One managed identity, one Key Vault grant, one storage grant. Two apps means
  every grant, every environment variable and every WorkOS resource indicator
  exists twice and can drift.
- One URL. The owner types `https://<host>/portal`; his AI client types
  `https://<host>/mcp`. No second FQDN to remember, no CORS, no cross-origin
  anything (#47 was already trying to avoid that).
- **A secret written through the portal is usable by the MCP server in the same
  process.** With two containers, the portal writes to the vault and the MCP
  container finds out whenever its cache expires — which is fine, but it means
  the "it just works now" moment is never observable in one place, and the
  demo of slice 1 becomes "wait a bit".
- Zero new Bicep resources. Slice 1's whole infrastructure change is one role
  assignment and two environment variables.

What one container costs, honestly:

- The MCP endpoint's process now also parses cookies and serves HTML. A bug in
  the portal is a bug in the same process that serves tools. This is mitigated
  by keeping the portal in `src/portal/` behind one factory that takes the same
  core dependencies, and by the route table in `src/transport/http.ts` deciding
  which handler sees a request — a portal handler never sees `/mcp` and vice
  versa.
- No privilege separation between "reads images" and "writes secrets". Accepted
  for a single-owner toolbox; named as the thing that would justify the split.
- Browser traffic and tool traffic scale together. At this volume that is not a
  sentence anyone will ever have to think about again.

**The escape hatch, so this is not a one-way door.** Everything portal-shaped
lives in `src/portal/` and is constructed by one function that takes the core
dependencies as arguments. Splitting it into a second container app later is:
a second `Containerfile`, a second service in `azure.yaml`, a second Bicep
block, and a different composition root calling the same factory. It is a day of
infrastructure work, not a rewrite — which is the same test ADR 0016 applied to
the transports. If the day comes that the portal wants a different identity, or
a different scale profile, or a public page next to a private one, that is when
to pay for it.

**#47 is not wrong, it is early.** It should be re-scoped to "the split, if and
when we want it", with the trigger written down, rather than closed.

### 2.2 Login for a browser

The MCP endpoint validates bearer tokens (ADR 0017, ADR 0023). A browser has no
bearer token; it needs an OAuth authorization-code round trip, a cookie, and
CSRF protection. Both live on the same WorkOS AuthKit environment.

**Recommendation: the authorization-code flow with PKCE against the same AuthKit
environment, a pre-registered first-party client, and a stateless signed session
cookie.**

*Verified against WorkOS documentation on 2026-09-04:*

| Step | What it is |
|---|---|
| Authorize | `GET https://api.workos.com/user_management/authorize` with `client_id`, `redirect_uri`, `response_type=code`, `state`, and `code_challenge` + `code_challenge_method=S256` |
| Exchange | `POST https://api.workos.com/user_management/authenticate` with `grant_type=authorization_code`, `client_id`, `code`, and `code_verifier` and/or `client_secret` |
| Back | `{ user, access_token (JWT), refresh_token, organization_id, ... }`. No separate `id_token`; the access token carries the identity |
| Keys | `https://<project>.authkit.app/oauth2/jwks`, issuer `https://<project>.authkit.app` |
| Logout | `GET https://api.workos.com/user_management/sessions/logout?session_id=<sid>&return_to=<url>` |
| Dashboard | `client_id` and API key under **Developer → API Keys**; redirect and logout URIs under **Redirects** |

**The uncomfortable fact about the client secret.** In WorkOS there is no
per-application client secret. The `client_secret` parameter of the token
exchange *is the environment's API key* (`sk_...`) — the same credential that
can administer users and organisations. Putting it in the container means the
container holds a WorkOS admin credential in order to log one person in. That is
a much bigger thing to hold than an OpenRouter key.

So the recommendation is deliberately ordered:

1. **Register the portal as a public client and use PKCE with no secret at
   all.** WorkOS documents PKCE as the flow for clients that "make API calls in
   public", and ADR 0023 already recorded that AuthKit's metadata advertises
   `token_endpoint_auth_methods_supported` including `none`. If a public client
   can complete `authenticate` with only `code_verifier`, the portal needs no
   WorkOS credential beyond a public client id, and this whole problem
   evaporates. **This is the first thing to test in slice 1**, because it decides
   whether the vault holds an admin key or nothing.
2. **If a secret is required**, it goes into Key Vault as `workos-client-secret`
   and reaches the container the way every other secret will after §2.3 — read
   at runtime by the managed identity, never as a build-time flag. The owner
   bootstraps it once with `az keyvault secret set`, because the portal's own
   login credential is precisely the one credential that cannot be entered
   through the portal. That is a chicken-and-egg with exactly one egg.

**Session handling.** WorkOS documents session cookies only through its
framework SDKs (the Next.js SDK's `WORKOS_COOKIE_PASSWORD`, ≥32 characters,
sealing an encrypted cookie). There is no documented framework-agnostic recipe,
and this repo has two runtime dependencies and a standing preference for
hand-rolled HTTP over large SDK trees (ADR 0022, ADR 0024). The shape that fits:

- The callback verifies the returned `access_token` with the **same JWKS and the
  same verifier the MCP endpoint already uses** (`src/transport/jwt.ts`), then
  throws the WorkOS tokens away.
- It sets **one cookie** containing `caller_id`, `email`, `sid`, `exp`, and an
  HMAC over them, signed with a key derived from a secret the deployment holds.
  Nothing in the cookie is secret, so this is a signature, not encryption, and a
  tampered cookie fails the check rather than decrypting to something wrong.
- Attributes: `HttpOnly; Secure; SameSite=Lax; Path=/portal; Max-Age=<8h>`.
  `Lax` rather than `Strict` because the OAuth callback is a top-level
  cross-site navigation and `Strict` would drop the cookie on the way back in.
- Stateless on purpose: the container app runs up to three replicas and there is
  no shared session store. An in-memory session map would log people out at
  random.
- Sessions expire rather than refresh, in slice 1. The refresh token is not
  kept. Eight hours and a re-login is the right trade for a personal toolbox;
  keeping a refresh token means storing one per user somewhere durable, which is
  a slice-3 conversation at the earliest.

**How it coexists with the MCP DCR/CIMD flow.** Cleanly, and the reason is worth
stating: one AuthKit environment has **one issuer and one JWKS**, and a
DCR-registered chat client and a hand-registered web app differ only in
`client_id`, redirect URIs and the `aud` they request. So:

- `/mcp` accepts `Authorization: Bearer` and **ignores cookies entirely.**
- `/portal` accepts the session cookie and **ignores `Authorization` entirely.**
- Neither path can be driven by the other. A browser session can never make a
  tool call cross-site, and a leaked bearer token cannot write a secret.
- Both verify against the same issuer, so there is one `SigningKeys` cache and
  one set of rules about who this server trusts.
- The portal registers its own resource indicator (`https://<host>/portal`) so
  its tokens carry an `aud` that is not the MCP endpoint's — a portal token is
  not a tool token even for the moment the portal holds it.

**A finding that is bigger than the portal.** ADR 0023 already noted it and it
becomes urgent the moment a page can write secrets: with Microsoft enabled as a
*social* provider, **any Microsoft account in the world can complete this
login.** The `tid` check is skipped in issuer mode by design, and nothing else
is restricting membership. Today that means anyone who finds the URL can call
`generate_image` on the owner's OpenRouter credit. After slice 1 it would mean
anyone who finds the URL can *replace the key*. Membership restriction is
therefore not a slice-2 nicety, it is **a precondition for slice 1**, in either
of two forms: an AuthKit organization-membership rule (dashboard, free), or an
allowlist of subjects in the server. Recommendation: do both — the dashboard
rule as the real gate, and `IMAGINE_ALLOWED_SUBJECTS` in the server as the
belt-and-braces check that also protects `/mcp`, because a server that is only
safe because of a dashboard toggle is the thing ADR 0021 already refused to
accept.

### 2.3 Provider keys without a redeploy

Today an OpenRouter key becomes usable only through a two-pass dance: write the
secret into Key Vault, set `IMAGINE_OPENROUTER_SECRET_IN_VAULT=true`, run
`azd up` so that Bicep adds a Key Vault *reference* to the container app's secret
list and an environment variable pointing at it. The value is resolved by the
platform at revision-creation time. Change the secret and nothing happens until
the next revision.

**Recommendation: the server reads provider secrets from Key Vault at request
time, through the managed identity, on a short cache, and falls back to the
environment.** The Key Vault reference and the `*_SECRET_IN_VAULT` flags stay
supported and become the "I do not want a portal" route.

**The seam.** `resolveApiKey` currently returns a `string | null` read out of a
frozen environment, and `composition.ts` calls it **once at startup** to hand
each adapter a key string. That is the thing that has to change, and it is the
only structural change:

```ts
type SecretResolution = { value: string; source: "vault" | "env" } | null;
interface SecretResolver {
  resolve(providerId: string): Promise<SecretResolution>;
}
```

Adapters take `getApiKey: () => Promise<string | null>` instead of
`apiKey: string | null`, and `isConfigured()` comes to mean "there is a source
configured for this provider" rather than "a value was present at startup".
Local mode passes a resolver that only reads the environment, which is
byte-for-byte today's behaviour — the same trick ADR 0024 used for the sink, so
every existing test stays honest.

**Reading from the vault.** One GET:
`{vault}/secrets/{name}?api-version=7.4` with a managed-identity bearer token
for `https://vault.azure.net`. This is the third instance of the pattern ADR
0022 and ADR 0024 established (one HTTP call, no `@azure/*` SDK, a cached token,
shared in-flight requests, failures never cached), and the argument comes out
the same way for the same reasons. The vault URL arrives as
`IMAGINE_KEY_VAULT_URL`, a value the deployment generates rather than a person
types — the same narrow exception ADR 0024 made for the blob variables.

**Caching, and the honest bound.** A resolved secret is cached for 60 seconds;
a "not found" for 15. With `maxReplicas: 3`, a write on one replica does not
invalidate another's cache, so the truthful promise is **"ready within a
minute", not "ready instantly"**. Two ways to make it feel instant: the writing
replica invalidates its own cache immediately, so the `list_capabilities` the
owner runs right after saving usually hits the replica that just wrote; and for
a single-owner toolbox, `maxReplicas: 1` removes the ambiguity entirely at the
cost of nothing anyone will notice. Recommendation: invalidate locally, keep the
60-second TTL, and say the sentence out loud in the portal ("visible to the
server within a minute") rather than pretending.

**The config extension.** ADR 0004's rule stands unchanged: **config holds names,
never values.** The minimal extension is one optional field:

```jsonc
"providers": {
  "openrouter": {
    "enabled": true,
    "api_key_env": "OPENROUTER_API_KEY",
    "api_key_secret": "openrouter-api-key"   // NEW, optional
  }
}
```

`api_key_secret` names a Key Vault secret. When it is absent and a vault is
configured, the name is **derived by convention from `api_key_env`**:
lower-cased, underscores to hyphens — `OPENROUTER_API_KEY` becomes
`openrouter-api-key`, which is *exactly the name `infra/resources.bicep` already
uses*. So the deployed case needs no config change at all, and the explicit
field exists only for an operator whose vault names things differently.
Resolution order per provider: `api_key_secret` (or the derived name) in the
vault, then `api_key_env` in the environment. Vault first, because the vault is
the thing a person can change without a deploy, and the environment is what the
deploy baked in.

Validation: `api_key_secret` gets a Key Vault secret-name regex
(`^[A-Za-z0-9-]{1,127}$`), so a pasted key is a validation error naming the
field — the same protection `api_key_env` already has, for the same reason.

**What `list_capabilities` should report.** The existing shape barely moves. Per
provider, in addition to `status`:

- `key_source: "vault" | "env" | null` — where the credential came from. Never
  the value, never a fragment of it, not even a length.
- `missing` keeps naming environment variables, and gains the vault secret name
  when a vault is configured, so the answer is actionable in both worlds:
  `missing: ["OPENROUTER_API_KEY", "vault secret openrouter-api-key"]`.
- A `note` on a `not_configured` provider pointing at the portal:
  "Set it at https://<host>/portal without redeploying."

`credentials()` in `list-capabilities.ts` becomes async and asks the resolver
instead of reading `env[variable]` directly, so the tool reports the same truth
the router would act on. That is the actual acceptance test for slice 1: put the
key in through the browser, call `list_capabilities` from a chat client, see
`openrouter: ready` and `key_source: "vault"`, with no `azd up` in between.

**Writing.** The portal PUTs `{vault}/secrets/{name}?api-version=7.4` with the
same identity. That needs **Key Vault Secrets Officer** on the *managed
identity* — a second role assignment in Bicep; the GUID
`b86a8fe4-44ce-4948-aee5-eccb2c155cd7` is already a variable in
`resources.bicep`, currently assigned only to the operator's own principal.
There is no narrower built-in role: Azure has no write-only secret role, so
Officer means read, write and delete of every secret in the vault. The
mitigations are that the vault holds only this application's secrets, that the
write path sits behind the portal login plus the membership check of §2.2, and
that every write leaves an audit line (§2.5).

### 2.4 The data the portal shows

The cost ledger and the manifest are JSONL files on the container filesystem.
That filesystem is emptied on every revision, so hosted, both are effectively
write-only. ADR 0024 named this as a real gap and deferred it to #45; the
gallery (#17) and the spend view (#19) cannot exist until it is fixed.

**Recommendation: keep JSONL as the local default, and put the hosted store in
Azure Table Storage — in the storage account the blob sink already
provisions — behind the same kind of seam ADR 0024 used for images.**

Two tables (or one with a row-type discriminator), keyed for the queries the
portal actually makes:

| | `PartitionKey` | `RowKey` |
|---|---|---|
| Ledger | `<caller_id>` | `<inverted timestamp>-<short id>` |
| Manifest | `<caller_id>` | `<inverted timestamp>-<short id>` |

An inverted timestamp (`9999999999999 - epochMillis`) makes a plain range query
return newest-first, which is what a gallery and a spend view both open with.
Partitioning by caller is #45's per-user separation, delivered by the key rather
than by a filter anyone could forget.

Why Table:

- **The ledger's existing shape maps to it one-to-one.** A `CostRecord` is flat
  and entirely scalar — `timestamp`, `day`, `session_id`, `provider`, `model`,
  `cost_usd`, `cost_source`, `billed`, `failure_reason`, `prompt`, `image_path`.
  Table entities are flat and scalar. There is no nesting to flatten, no schema
  to design, and old JSONL lines convert with a loop. `ManifestRecord` is the
  same story.
- **No locking, no coordination, three replicas welcome.** Every write is an
  independent entity insert.
- **Keyless.** Same managed identity, one more role (Storage Table Data
  Contributor), same story as the blob sink.
- **Cheap and boring.** Pennies a month; no server to run; no migration to
  regret.

Why not the alternatives:

- **Append-only blobs** are the closest thing to what exists — Azure's Append
  Blob keeps the JSONL bytes exactly, each line an atomic block, and the
  identity already has the role. It is the runner-up and it would work. It loses
  on reads: every gallery page and every budget total means downloading the
  whole log and filtering in memory, and the 50,000-block limit per blob forces
  a rotation scheme. That is a design; Table is a lookup.
- **SQLite on a mounted Azure Files share** gives real queries and is the option
  PLAN.md floated. It is the one to actually avoid: SQLite over SMB with more
  than one writer is a documented route to a corrupted database, and this app
  runs up to three replicas. Pinning to one replica to make a database safe is
  the tail wagging the dog.

**Free-text prompt search (#18)** is a client-side filter over the fetched page
in this design, because Table has no text index. At the volume of a personal
toolbox — thousands of rows, one owner — that is a few milliseconds and it is
honestly the same thing grepping a JSONL file was. If it ever stops being
enough, the answer is a real database and a migration from a table scan, which
is a normal afternoon; it is not a migration from a corrupted file, which is not.

**Scope note:** slice 1 needs none of this. The store is slice 3's work, and
saying so is what keeps slice 1 to two weeks instead of two months.

### 2.5 Security posture

A page that writes secrets has to earn it. What must be true, all of it, before
slice 1 ships:

1. **Authentication is not optional for the portal.** If no `IMAGINE_AUTH_*` is
   configured, the portal routes do not exist — a plain 404, the way ADR 0021
   made the protected-resource document not exist when auth is off. There is no
   "it is only on localhost" convenience mode, because the deployed default must
   not depend on anyone remembering to turn something on.
2. **Membership is checked, not assumed.** §2.2: an AuthKit organization rule
   *and* a server-side subject allowlist. Someone who is not on the list gets a
   403 that says so, not a login loop.
3. **HTTPS only.** Container Apps ingress already sets `allowInsecure: false`.
   Cookies are `Secure; HttpOnly; SameSite=Lax; Path=/portal`. The server refuses
   to issue a session cookie over plain HTTP unless the host is loopback (which
   is how it stays testable). `Strict-Transport-Security` on portal responses.
4. **CSRF, in two layers.** The login leg binds the `state` parameter to a
   short-lived nonce cookie and rejects a callback whose `state` does not match.
   Every state-changing action is a `POST` carrying a per-session CSRF token in a
   hidden field, compared in constant time; `GET` never changes anything. A
   second gate checks `Origin` / `Sec-Fetch-Site` on every POST.
5. **No secret is ever echoed back.** The key field is write-only. The page shows
   presence, source (`vault` / `env`), who set it and when — never the value, no
   last-four, no length, no masked preview. No portal route returns a secret
   value in any shape, and the resolver never puts a value into an error message
   or a log line. `Cache-Control: no-store` on every portal response.
6. **Every write leaves an audit line**, with `caller_id`, the action
   (`secret.set`, `secret.clear`, `budget.set`, …), the target *name*, the
   timestamp and the outcome. It goes to the same durable store as the cost
   records with a `type` field, so there is one place to look at "who changed
   what". Until slice 3 that store is the container's log stream, which is
   shipped to Log Analytics and therefore survives the revision — which is
   enough for slice 1 and is written down as a stopgap, not sold as a design.
7. **A strict Content-Security-Policy** with no inline script and no external
   origins. The portal is server-rendered HTML with a stylesheet; it needs no
   framework and no CDN, and saying so in a header is free.
8. **No open redirect.** The post-login destination is validated to be a path
   under `/portal` on this host, never a URL taken from the query string.
9. **The portal never proxies to `/mcp`.** If the portal ever needs to generate
   an image, it calls the core router in-process like the MCP tools do.

---

## 3. The target architecture, in words

One container app, one managed identity, one process, one Node HTTP server. The
route table in `src/transport/http.ts` gains a third family of paths beside
`/mcp` and `/healthz`:

```
                       Container App (one identity)
  ┌──────────────────────────────────────────────────────────────┐
  │  node:http  —  src/transport/http.ts route table             │
  │                                                              │
  │  /.well-known/…   RFC 9728 metadata     (no auth, ADR 0021)  │
  │  /healthz         liveness              (no auth)            │
  │  /mcp             bearer token only  ──┐                     │
  │  /portal/*        session cookie only ─┤                     │
  │  /portal/auth/*   OAuth callback ──────┤                     │
  └────────────────────────────────────────┼─────────────────────┘
                                           │
                    ┌──────────────────────▼───────────────────┐
                    │  core: router, config, ledger, output     │
                    │  + NEW: SecretResolver, SettingsWriter    │
                    └───┬───────────────┬──────────────┬────────┘
                        │               │              │
                 Key Vault        Blob Storage   Table Storage
              (provider keys,     (images,        (ledger, manifest,
               read + write)       ADR 0024)       audit — slice 3)
                        └───── all reached with the one managed identity ─────┘

  WorkOS AuthKit  ── one issuer, one JWKS ──┬── DCR/CIMD clients → /mcp
                                            └── first-party client → /portal
```

Two new modules and one changed one:

- `src/core/secrets.ts` — read and write Key Vault over the managed identity;
  the `SecretResolver` the adapters consume; the cache.
- `src/portal/` — session cookie, OAuth leg, CSRF, the route handlers, and the
  HTML. Constructed by one factory taking the same core dependencies the MCP
  server gets, so the second-container split stays a day's work.
- `src/composition.ts` — hands adapters a key *resolver* instead of a key
  *string*.

Everything else — the router, the adapters, the knowledge, the output writer —
does not know the portal exists.

---

## 4. The roadmap, in slices

Each slice is shippable and observable on its own. The order is chosen so the
thing the owner asked for first is the thing that lands first.

### Slice 1 — Log in, paste the OpenRouter key, and it works

**Issues: #57 (membership allowlist — the precondition), #58 (runtime provider
secrets from Key Vault), #60 (portal browser login + session), #61 (the provider
key form). In that order.**

**The moment it delivers:** the owner opens `https://<host>/portal` on his
phone, signs in with Microsoft, pastes an OpenRouter key, and then asks Claude
to `list_capabilities` — which answers `openrouter: ready`. No terminal, no
`azd up`.

**Bicep**
- Key Vault Secrets Officer on the *managed identity* (a second assignment of a
  role GUID already in the file).
- `IMAGINE_KEY_VAULT_URL` on the container, from `keyVault.properties.vaultUri`.
- `IMAGINE_PORTAL_ENABLED`, and the portal's WorkOS `client_id` (public, a plain
  parameter). A `workos-client-secret` vault secret and its flag **only if**
  the public-client-plus-PKCE route turns out not to work.
- `IMAGINE_ALLOWED_SUBJECTS` (comma-separated), enforced on `/portal` and
  `/mcp` both.
- Nothing else. No new resource is created.

**Code**
- `src/core/secrets.ts`: Key Vault get/set over managed identity, 60s/15s cache,
  shared in-flight, local invalidation on write.
- `resolveApiKey` → `SecretResolver`; adapters take `getApiKey()`; `isConfigured()`
  means "a source is configured".
- `api_key_secret` in the config schema, with the convention default derived from
  `api_key_env`, and the name-shaped regex that keeps values out.
- `list_capabilities`: `key_source`, vault names in `missing`, the portal note.
- `src/portal/`: OAuth code + PKCE leg, signed session cookie, CSRF, membership
  check, one page listing providers with a write-only key field, a save POST, and
  an audit log line.
- `src/transport/http.ts`: the route family, and the rule that `/mcp` ignores
  cookies and `/portal` ignores `Authorization`.

**Owner actions** — see §5.

**Done when:** a key entered in the browser is used by the next `generate_image`
from a chat client, within a minute, with no deployment; `list_capabilities`
says where the key came from; no route anywhere returns the value; the audit line
names the caller.

### Slice 2 — Budgets and preferences

**The moment it delivers:** "this PowerPoint may cost one euro" is something the
owner sets on a web page instead of in a JSON file he cannot reach.

Covers #30 (preferences), #31 (per-job budgets) and the settings half of #16.

**Bicep** — nothing.

**Code**
- A portal-writable settings overlay. It is *not* a secret, so it does not
  belong in Key Vault: one JSON document in the storage account (or the Table,
  if slice 3 has already landed), read through the same short cache.
- One new precedence layer, at the **top** of the chain, above
  `IMAGINE_CONFIG_JSON`. ADR 0022's own argument leads there: the most deliberate
  and most recent statement wins, and a value typed into the portal today is both.
  The portal must show which deployment values it is overriding, so the override
  is never invisible.
- `budget.max_usd_per_job` and the `job` argument on `generate_image` (#31).
- A `preferences` section (#30), with the router honouring per-use-case overrides
  after `provider_hint` and before ranking.
- The same `SettingsWriter` module the portal and, later, the `configure` tool
  both call — one write path, one validation, one audit line.

**Owner actions** — none beyond using it.

**Done when:** a budget set in the portal refuses the next over-budget generation
from a chat client, and `list_capabilities` reports the new limit.

### Slice 3 — Where the money went, and what came out

**The moment it delivers:** the gallery and the spend view — the two things
Phase 2 was originally about, now with data that survives a deployment.

Covers #17, #18, #19, and the durable-store half of #45.

**Bicep**
- Azure Table Storage in the existing account (the account itself only exists
  when the blob sink is on, so this slice makes the blob sink effectively
  required hosted — worth stating plainly rather than discovering).
- Storage Table Data Contributor on the identity.

**Code**
- `LedgerStore` / `ManifestStore` seams, local JSONL as the default, Table as the
  hosted implementation — the ADR 0024 pattern, third time.
- `caller_id` on every record; `session_id` becomes a per-request correlation id
  (#45). Old JSONL lines without `caller_id` must still parse.
- A one-off import of whatever JSONL survives, so history is not thrown away.
- Portal: gallery (thumbnail grid, prompt, model, cost, dimensions, the blob
  link), filters, spend by day / model / provider / job, and the honest
  comparison #19 asks for.
- Thumbnails: generate on demand with a blob-side cache, rather than on write.
  PLAN.md open question 4 resolves toward "lazy", because most generated images
  are never looked at twice and the first-scroll stutter is one small image.

**Owner actions** — turn the blob sink on if it is not already.

**Done when:** an image generated last week is findable by part of its prompt
after a redeploy, and the month's spend adds up.

### Slice 4 — `/setup`, through the same door

**The moment it delivers:** "set up imagine" as a conversation, in any client,
writing the same settings the portal writes.

Covers #55, and the `remember_preference` half of #30.

**Bicep** — nothing.

**Code**
- An MCP `setup` prompt and a `configure` tool that call the **same
  `SettingsWriter`** slice 2 built. The only difference between the two doors is
  where the caller identity comes from: a bearer token for the tool, a cookie for
  the portal. Same validation, same precedence, same audit line, same refusal to
  accept a key value in a config field.
- The one thing the conversational path must *not* do is accept a secret as a
  tool argument — a key pasted into a chat is a key in a transcript. `/setup`
  collects everything else and then hands the owner a link to the portal for the
  key itself. That is a feature, and the portal existing is what makes it
  possible to say it.

**Owner actions** — none.

**Done when:** a fresh deployment can be configured end to end by conversation
plus one visit to the portal, and both paths leave the same audit trail.

---

## 5. What the owner has to do himself

Nothing on this list can be automated, and all of it is one-time.

**In the WorkOS dashboard** (<https://dashboard.workos.com>, in the same
environment §6e of the deploy runbook already uses):

1. **Add the portal's redirect URI** under **Redirects**:
   `https://<your-fqdn>/portal/auth/callback` — the exact string, because WorkOS
   matches it exactly. Add the logout return URI `https://<your-fqdn>/portal`
   in the same place.
2. **Decide the portal's client.** First try the environment's existing
   `client_id` (**Developer → API Keys**) as a public client with PKCE. If the
   token exchange refuses without a `client_secret`, the secret is the
   environment's **API key** (`sk_...`) from that same page — and it is an
   administrative credential, so it goes straight into Key Vault and nowhere
   else. Do not put it in an `azd env` variable.
3. **Restrict who may sign in.** Add an organization and a membership rule so
   that only the owner's account can complete the login. Without this, any
   Microsoft account on the internet can reach the endpoint, and after slice 1
   that means reaching the key form. This is the single most important item on
   the page.
4. **Add `https://<your-fqdn>/portal` as a Resource Indicator**, alongside the
   `/mcp` one that already exists, so the portal's token has its own audience.

**In Azure, once:**

5. If a client secret turned out to be needed:
   `az keyvault secret set --vault-name <kv> --name workos-client-secret --value <sk_...>`,
   then one `azd up`. This is the last two-pass secret in the system; every
   provider key after it goes in through the browser.
6. `azd env set IMAGINE_ALLOWED_SUBJECTS <your WorkOS user id>` before the first
   portal deploy, and confirm it is set before sharing the URL with anyone.

**Not needed:** an Entra app registration for the portal, a second container
app, a second domain, a certificate, or any change to how chat clients connect.

---

## 6. Open questions

1. **Can the portal be a public PKCE client with no WorkOS secret?** Decides
   whether the container holds an admin credential. First thing to test in slice
   1; everything else in §2.2 works either way.
2. **Does AuthKit's organization-membership rule actually block a login**, or
   only annotate the token? If it only annotates, the server-side allowlist is
   the whole gate and has to be right.
3. **What is the WorkOS user id to put in the allowlist**, and is `sub` stable
   across a re-login through the Microsoft social provider? ADR 0023 already flags
   that the Entra `oid` is not present.
4. **`maxReplicas: 1` for the personal toolbox?** It makes the cache story exact
   and costs nothing at this volume. Decide with slice 1 rather than inheriting
   the current 3 by accident.
5. **Do the JSONL cost logs from before the Table store exist anywhere worth
   importing?** Hosted, probably not — the container has been wiped. Locally, yes.
