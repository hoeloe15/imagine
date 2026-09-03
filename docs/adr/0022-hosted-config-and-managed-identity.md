# 22. Hosted configuration and managed identity

**Status:** accepted
**Date:** 2026-09-03
**Follows:** [ADR 0004](0004-config-loading-and-key-resolution.md),
[ADR 0014](0014-azure-openai-adapter.md),
[ADR 0017](0017-entra-bearer-token-validation.md),
[ADR 0020](0020-the-azd-template.md)

## Context

The first real `azd up` found two things missing at once (issues #53 and #54).

The container has no `~/.imagine/config.json` and no writable place to put one,
and the environment could only ever carry *key values* — `api_key_env` names a
variable, and that is all. OpenRouter survives that because `DEFAULT_CONFIG`
enables it on one variable, but Azure OpenAI needs an endpoint, a deployment
mapping and an auth mode, none of which the environment could express. So the
hosted server could not route to Azure OpenAI at all.

And the auth mode it would have to be given is the interesting one. ADR 0014 put
the `getAccessToken` seam in the adapter and deliberately left it empty, wired to
a token provider that refuses and names issue #23. Container Apps gives the app a
user-assigned managed identity; using it means no Azure OpenAI key exists
anywhere, which is a strictly better story than a key in Key Vault.

## Decision

### `IMAGINE_CONFIG_JSON` carries a config fragment, validated as a file is

One environment variable holds the text of a `config.json`. It is parsed by
`parseFragment` — the same function the files go through — so it gets
`configFileSchema` in strict, default-free form, and then the merged result gets
`configSchema` and its cross-field rules. Nothing about the vocabulary moved and
no second description of the config shape exists.

The alternatives were a Container Apps volume or secret mounted as a file, and
first-class environment variables per Azure field (`IMAGINE_AZURE_ENDPOINT` and
friends). The mount needs storage the template does not otherwise have and turns
a config edit into an infrastructure change. Per-field variables are a second
config vocabulary that has to grow a new name for every field anyone adds, and
they would have to invent their own merge and their own validation. Reusing the
fragment path costs about fifteen lines and stays correct by construction.

**Precedence: last, above every file.** Least to most specific the chain is now
bundled defaults, `~/.imagine/config.json`, `./config.json`,
`IMAGINE_CONFIG_JSON` — including above an explicit `--config` file, which
otherwise replaces discovery entirely. The reasoning is that everything below it
is a file that happens to be *on the machine*, while this variable is set by
whoever *starts the process*, which is both later and more deliberate. In the
hosted case there are no files at all, so any other position would work equally
well there; the position matters for the mixed case — an operator running the
image locally, or a container that ships a baked-in config — and in every one of
those the answer wanted is "what the deployment said wins". The same argument
puts it above `--config`: an operator who sets both meant the variable to be an
override of the file, since setting a variable to be silently ignored is not a
thing anyone intends.

**It is read from the resolved environment**, `.env` files overlaid by the real
environment, which is the same `env` `resolveApiKey` reads keys from. One notion
of "the environment" rather than two.

**Empty or whitespace means absent, not empty config.** The Bicep parameter
defaults to `''` and azd substitutes an empty string when the operator has not
set it, so "set but empty" must be the same as unset or the default template
would fail every deployment.

**It still cannot carry a key value.** `api_key_env` matches an
environment-variable-name regex (ADR 0004), so a pasted key is a validation
error naming the field, and it is the same error whether the fragment came from
a file or from this variable. The variable therefore holds no secrets and is a
plain (non-`@secure()`) Bicep parameter and an ordinary container environment
variable.

**Errors name it.** `parseFragment` takes an origin label rather than a path, so
a bad fragment says `IMAGINE_CONFIG_JSON is not valid JSON: …` or
`IMAGINE_CONFIG_JSON is not valid:` followed by the field. `LoadedConfig` grows
`origins` — the file sources plus this label — because `sources` is documented as
files and is what `.env` discovery derives directories from; the merged-config
error and the "provider is disabled" message now name `origins` instead, so the
variable appears alongside the files that contributed with it.

### The managed identity token provider is hand-rolled, not `@azure/identity`

ADR 0017 set the bar for hand-rolling on a credential path and this is measured
against it, with the opposite conclusion available: `@azure/identity` is the
obvious choice and `DefaultAzureCredential` is one line.

What is actually needed here is one HTTP GET. Container Apps (and App Service)
inject `IDENTITY_ENDPOINT` and `IDENTITY_HEADER`; a `GET
$IDENTITY_ENDPOINT?api-version=2019-08-01&resource=<resource>&client_id=<id>`
with an `X-IDENTITY-HEADER` header returns `{ access_token, expires_on }`. There
is no signature to verify, no key material to import, no token to *validate* —
this code **consumes** a token from a trusted local endpoint rather than
deciding whether to trust one, which is the asymmetry that makes ADR 0017's
comparison come out differently in the same direction. The classic hand-rolled-
crypto failure modes have no analogue here: there is nothing to get wrong that
a library would get right.

Against that, `@azure/identity` is a large transitive tree (`@azure/core-*`,
`@azure/msal-node`) on a package that currently has exactly two runtime
dependencies, pulled in to reach one endpoint that the platform documents as a
stable contract. `DefaultAzureCredential` also probes several sources in order,
which is a feature for a general-purpose tool and a liability in a server: on a
developer machine it would silently pick up an `az login` identity and make
local behaviour differ from hosted behaviour for reasons the config does not
show.

If this ever needs workload identity federation, certificate credentials, or
non-Azure clouds with different endpoints, that is the point to take
`@azure/identity`; the seam is one module wide and `AccessTokenProvider` is one
function type.

**Only the `IDENTITY_ENDPOINT` flavour, not IMDS.** The bare IMDS endpoint
(`169.254.169.254`) has no environment-variable signal, so supporting it would
make "is there an identity here?" a network probe against a link-local address
that hangs until it times out on any machine that is not an Azure VM — exactly
the local-dev experience this is trying to keep clean. Detection is positive and
free: both variables set, or no identity. A VM host can add it later.

**Caching, with slack and no thundering herd.** A token is cached until five
minutes before `expires_on` and then re-fetched, so a call never races the
clock. `expires_on` is accepted as epoch seconds in a number or a string and as
a parseable date, because hosts have sent all three; a response without one falls
back to ten minutes rather than being cached forever. Concurrent callers share
one in-flight request, and a failed request is never cached, so the next call
retries rather than inheriting a poisoned entry. An unreachable endpoint is
`auth_failed` with `retryable: true`; every other failure is `auth_failed` and
not retryable. No token value is ever put in a message.

**The composition root chooses by environment, and says so when it cannot.**
With `providers.azure.auth: "entra"` and a managed identity present, the real
provider is wired. With `auth: "entra"` and no identity, the adapter is still
wired — with a provider that rejects, naming `IDENTITY_ENDPOINT`,
`IDENTITY_HEADER` and the `api_key` alternative. That keeps ADR 0014's choice
intact: the config *is* complete, so reporting the provider unconfigured would
not tell the operator which field to look at.

**`AZURE_CLIENT_ID` is set by the template.** With a user-assigned identity the
token request has to say which identity it means, and that variable is the
convention every Azure SDK already uses for it.

### Bicep: an existing-resource reference and a scoped role assignment

The Foundry account the app talks to is not part of this template — it is the
customer's, it usually predates the deployment, and it commonly lives in another
resource group or another subscription. So `foundryResourceId` is taken as a
plain string parameter, the id is split into subscription / resource group /
name, and a small module (`infra/foundry-role.bicep`) is deployed at
`resourceGroup(<sub>, <rg>)` scope, where an `existing` reference to the account
can actually be the `scope:` of a role assignment. Empty means skipped, exactly
as `principalId` is in ADR 0020.

**The role is Cognitive Services OpenAI User,
`5e0bd9bd-7b93-4f28-af87-19fc36ad61bd`.** That GUID was read from the live
tenant with
`az role definition list --name "Cognitive Services OpenAI User" --query "[].name" -o tsv`,
not from memory, because this repo shipped an invented role GUID this week
(commit 911edea). Data-plane inference is all the app needs; it never manages
deployments, so Contributor and OpenAI Contributor are both more than the job.

## Consequences

A hosted deployment can now run Azure OpenAI with no Azure OpenAI key existing
anywhere: `IMAGINE_CONFIG_JSON` carries the endpoint, the deployment mapping and
`"auth": "entra"`, the identity mints the token, and the role assignment lets it
in. `IMAGINE_AZURE_OPENAI_SECRET_IN_VAULT` stays as the api-key route for anyone
who wants it.

Local development is unchanged and deliberately does *not* get Entra: with no
managed identity the answer is a message telling the operator to use `api_key`,
not a fallback to `az login` that would make local and hosted behave differently.

Role assignment propagation is eventually consistent, so a first `azd up` can in
principle produce a container that is running before its role has taken effect;
the container app depends on the role assignment, which covers ordering but not
Azure's own replication delay. A first call that fails with 403 and succeeds a
minute later is that, and it is in the runbook rather than engineered around.

None of this has been run against a live subscription either. `az bicep build`
passes, the token provider is covered by unit tests with an injected `fetch`,
and the list of things to check on first real execution is at the bottom of
`docs/deploy/azure-wizard.md`.
