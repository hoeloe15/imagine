# 26. Runtime provider secrets from Key Vault

**Status:** accepted
**Date:** 2026-09-04
**Follows:** [ADR 0004](0004-config-loading-and-key-resolution.md),
[ADR 0020](0020-the-azd-template.md),
[ADR 0022](0022-hosted-config-and-managed-identity.md),
[ADR 0024](0024-output-sinks-and-renderable-urls.md)

## Context

Putting an OpenRouter key on a running deployment took three steps and a
redeploy:

```powershell
az keyvault secret set --vault-name $vault --name openrouter-api-key --value "<key>"
azd env set IMAGINE_OPENROUTER_SECRET_IN_VAULT true
azd up
```

Two things made that necessary, and both are ours.

The first is in the template. A Container Apps secret whose value is a Key Vault
*reference* is resolved by the platform when a revision is created, and a
reference to a secret that does not exist yet fails the revision — taking the
deployment with it. So the template only declares the reference once the
operator says the secret is there, which is what the `*_SECRET_IN_VAULT` flags
are for (ADR 0020). Change the secret afterwards and nothing happens until the
next revision.

The second is in the server. `composition.ts` called `resolveApiKey` **once, at
startup**, and handed each adapter a key *string*. Even a changed environment
variable would not have been noticed.

The consequence is a product problem, not only an operational one: the portal
this is a slice of (#15, #16) has a form for a provider key, and a form whose
result requires the person to run `azd up` afterwards is not a form.

## Decision

**The server reads provider secrets from Key Vault at request time, through its
managed identity, on a short cache, falling back to the environment.** The Key
Vault reference and the `*_SECRET_IN_VAULT` flags stay supported, and become the
route for an operator who does not want a portal.

### The seam

```ts
type SecretResolution = { value: string; source: "vault" | "env" } | null;

interface SecretResolver {
  resolve(providerId: string): Promise<SecretResolution>;
  lookup(providerId: string): Promise<SecretLookup>; // the same, plus names
  hasSource(providerId: string): boolean;
  invalidate(providerId?: string): void;
}
```

Adapters are constructed with an `ApiKeySource` — `has()` and `get()` — instead
of a key string. A plain string is still accepted and normalised, so every test
and every direct construction keeps working byte for byte.

**Without a vault the resolver reads the environment and nothing else**, which is
exactly today's behaviour on a developer machine. This is the same trick ADR 0024
used for the output sink: the local path is the one with no new machinery in it,
so every existing test stays honest rather than being rewritten around a mock.

`isConfigured()` changes meaning, and it is worth saying out loud: it now
answers *"is a source configured for me"*, not *"was a value present at
startup"*. On a laptop those are the same sentence. Hosted they are not — a
vault is a source before anyone has put a key in it, so the provider is worth
routing to and the resulting failure names the secret to set rather than
pretending the provider does not exist.

### Reading the vault

One GET, `{vault}/secrets/{name}?api-version=7.4`, with a managed-identity
bearer token for `https://vault.azure.net/.default`.

This is the third instance of the pattern ADR 0022 and ADR 0024 established, and
the argument comes out the same way for the same reasons: hand-rolled `fetch`
rather than `@azure/keyvault-secrets`, a cached token, shared in-flight
requests, failures never cached, and no secret or token value in any message,
error or log line. The whole protocol is one request and one JSON field.

`IMAGINE_KEY_VAULT_URL` arrives from the template — a value the deployment
generates rather than one a person types, the same narrow exception ADR 0024
made for the blob variables. The vault is used only when that variable is set
*and* a managed identity exists to read it with; either missing means
environment-only.

A **404 is `null`, not an error**. "No key has been set yet" is the ordinary
state of a fresh deployment, and turning it into a failure would make every
`list_capabilities` on an empty vault look broken.

### Caching, and the honest bound

60 seconds for a value that was found, 15 for a "there is no such secret",
shared in-flight requests, and failures never cached — a transient outage falls
back to the last known value, and then to the environment, rather than looking
like a deleted key.

With `maxReplicas: 3` a write on one replica does not invalidate another's
cache. So the promise is **"ready within a minute", not "instantly"**, and the
portal should say that sentence rather than pretend. The writing replica
invalidates its own cache immediately (`invalidate`), which is why the
`list_capabilities` an owner runs straight after saving usually already agrees.

Dropping to `maxReplicas: 1` would remove the ambiguity entirely at a cost
nobody would notice on a single-owner toolbox. Not taken here, because it trades
availability for a second of freshness; noted so the next person does not have
to rediscover the option.

### Config: names only, still

ADR 0004's rule is unchanged — **the config holds names, never values** — and the
extension is one optional field:

```jsonc
"providers": {
  "openrouter": {
    "api_key_env": "OPENROUTER_API_KEY",
    "api_key_secret": "openrouter-api-key" // optional
  }
}
```

Absent, with a vault configured, the secret name is **derived from
`api_key_env`**: lower-cased, underscores to hyphens. `OPENROUTER_API_KEY`
becomes `openrouter-api-key`, which is exactly the name `infra/resources.bicep`
already writes — so a deployed installation needs no config change at all, and
the field exists only for a vault that names things differently.

Resolution order is **vault, then environment**. The vault is the thing a person
can change without a deploy; the environment is what the deploy baked in.

`api_key_secret` is validated against Key Vault's own name rule,
`^[A-Za-z0-9-]{1,127}$`, for the reason `api_key_env` has a regex: a pasted key
becomes a validation error naming the field rather than a secret in a config
file. It is not a perfect sieve and does not claim to be — a key made only of
letters, digits and hyphens is a legal secret name — but underscores, dots,
slashes and anything over 127 characters are caught.

### What `list_capabilities` reports

- `key_source: "vault" | "env" | null` per provider. Never the value, never a
  fragment of it, not even a length.
- `missing` keeps naming environment variables and gains the vault secret when a
  vault is configured: `["OPENROUTER_API_KEY", "vault secret openrouter-api-key"]`.
- `credentials()` is now async and asks the resolver instead of reading
  `env[variable]`, so the tool reports the truth the router would act on.

### Bicep

`IMAGINE_KEY_VAULT_URL` is set on the container **always**, with or without a
secret in the vault, and the container's managed identity gets **Key Vault
Secrets Officer** on top of Secrets User.

Officer is read, write and delete of every secret in the vault, because **Azure
has no write-only secret role** — there is no narrower built-in one that lets
the portal save a key. The mitigations are that the vault holds only this
application's secrets, that the write path sits behind the portal login and the
subject allowlist, and that every write leaves an audit line. Worth revisiting
the day the vault holds anything else.

## Consequences

- A key set with `az keyvault secret set` is used by the next `generate_image`
  within a minute, on a running deployment, with no `azd up`.
- The `*_SECRET_IN_VAULT` flags are no longer needed for the server to *see* a
  key. They still work, still map the secret onto an ordinary environment
  variable, and still only refresh on a revision restart. The docs now present
  them as the env-reference route rather than the only route.
- Local mode is unchanged, in behaviour and in its tests.
- A vault outage degrades to the environment with a `note`, not to a silent
  "the key was deleted".
- The container identity can now delete every secret in its own vault. That is a
  real widening of blast radius and the reason it is written down here.
