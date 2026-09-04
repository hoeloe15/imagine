# 14. The Azure OpenAI adapter

**Status:** accepted, amended by
[ADR 0027](0027-the-mai-image-wire-dialect.md)
**Date:** 2026-08-27
**Follows:** [ADR 0009](0009-openrouter-adapter.md),
[ADR 0013](0013-explicit-model-ref-at-the-adapter-seam.md)

> **Amendment, 2026-09-04 (ADR 0027).** Everything below still describes the
> Azure OpenAI wire shape exactly, but it is no longer the *only* shape the
> adapter speaks. Microsoft's MAI-Image models live in the same Azure resource
> behind a different API, and that API requires the deployment name **in the
> request body as `model`** — the precise opposite of the rule this ADR was
> written to protect. The adapter therefore has a wire-dialect seam: `openai`
> (this ADR) and `mai` (ADR 0027). Two things stated here have moved with it:
> `providers.azure.deployments` values are now `string | { deployment, dialect?,
> endpoint? }`, where a bare string still means the `openai` dialect described
> below; and the Entra scope is no longer one constant per file but a parameter
> of the token provider, because the two endpoints accept different audiences.
> The LiteLLM warning is unchanged and undiluted — it is a rule about *this*
> API, not about Azure in general.

## Context

Azure OpenAI is the second adapter and the first one aimed at an organisation
rather than an individual: the model runs in the customer's own resource, under
their own governance. `docs/research/providers-2026-08.md` §2 gives the wire
shape and one very loud warning — **the deployment name goes in the URL path and
must never appear as `model` in the request body**, the mistake that broke
LiteLLM repeatedly (research §5, issue #9). Everything else about the request is
either documented thinly or not at all, and the deployment name is a value only
the operator knows.

ADR 0009 already set the adapter pattern: an injected `fetch`, a status-to-reason
mapping table, and a contract test that pins the exact URL, headers and body.
This ADR records only what Azure decides differently.

## Decision

**The wire shape is pinned, not described.**

```
POST {endpoint}/openai/deployments/{deployment}/images/generations
     ?api-version={api_version}

api-key: <key>                 (auth: api_key)
Authorization: Bearer <token>  (auth: entra)

{ "prompt": "...", "n": 1, "size": "1024x1024" }
```

`test/contract/azure-request.test.ts` asserts each half of that separately: the
deployment in the path, the api-version in the query, **no `model` key and no
occurrence of the deployment name anywhere in the body**, the exact body fields,
and `api-key` versus `Authorization` per auth mode.

Two body fields were not settled by the research and are pinned so a live run
fails loudly rather than quietly. `n: 1` is sent explicitly: the images API is
OpenAI-compatible in shape, one image is what `NormalisedResult` can carry, and
an explicit `1` is unambiguous where a default is not. `response_format` is
**not** sent at all — the gpt-image series does not support it and always
answers with base64 (research §2), so sending it is a 400 waiting to happen.
`size` is passed through as the pixel string and omitted for `"auto"`, and
`style` is appended to the prompt, both exactly as ADR 0009 decided.

**The deployment comes from `providers.azure.deployments[<curated model id>]`.**
Per ADR 0013 the router hands the adapter `{ model_ref }`, and for Azure a
`model_ref` *is* the curated model id (`data/models.json` lists Azure
availability for `gpt-image-2` under exactly that reference). A model with no
mapping is an `invalid_request` that names the key to add —
`providers.azure.deployments["flux-2-pro"]` — and lists what is configured
today, because the fix is a config edit and the message is the only place the
user will see which one.

**Without a resolved model, one configured deployment is the default and
several are an error.** A direct call — a script, a live check — has no router
behind it. One deployment is unambiguous, so it serves. Zero or several are not,
and the adapter says so rather than picking one and spending the operator's
money on a guess.

**Entra is accepted but not acquired here.** Entra is the documented Azure
recommendation and is the schema's default `auth`, but obtaining a token needs
`@azure/identity`, and taking a dependency for it is a decision that belongs to
the endpoint-auth work in **issue #23** rather than being smuggled in with a
provider adapter. So the adapter takes a `getAccessToken?: () => Promise<string>`
constructor option and sends whatever it returns as a bearer token; anyone can
wire `DefaultAzureCredential` (scope `https://ai.azure.com/.default`) to it in
one line, and the contract test covers the bearer path with a fake.

The composition root wires `api_key` mode fully. For `entra` mode it registers
the adapter with a token provider that rejects with an `auth_failed` naming
issue #23 and the `api_key` alternative. That is deliberately louder than
reporting the provider unconfigured: the config *is* complete, and "the adapter
reports itself unconfigured" would not tell the user which of the four fields
to look at. The consequence is real and accepted — enabling Azure with Entra
today fails the request rather than falling back to another provider, because
`auth_failed` is not retryable and the router does not fall back on
non-retryable failures (ADR 0007).

**`listModels()` returns the configured deployments and makes no network call.**
Azure exposes no listing of image deployments an adapter can rely on (research
§2). The mapping the operator wrote is therefore the most truthful answer
available: `id` is the curated model id, and `capabilities` carries the
deployment name and api-version, so `list_capabilities` shows which deployment
a model would actually be routed to.

**`isConfigured()` is the conjunction of all four things a call needs**:
enabled, an endpoint, a credential for the chosen auth mode, and at least one
deployment. Any one of them missing makes the request fail, so any one of them
missing makes the provider unusable, and the router should skip it rather than
discover it mid-request.

**Error mapping**, as ADR 0009's table adapted to Azure's semantics:

| Status | Reason | Retryable |
|---|---|---|
| 400 | `invalid_request`, or `content_filtered` when Azure's error code says so | no |
| 401 | `auth_failed` | no |
| 403 | `auth_failed` | no |
| 404 | `provider_unavailable`, with "the deployment name is probably wrong" | no |
| 408, 504 | `timeout` | yes |
| 422 | `invalid_request` | no |
| 429 | `rate_limited` | yes |
| other 5xx | `provider_unavailable` | yes |
| transport failure | `provider_unavailable` | yes |
| abort/timeout | `timeout` | yes |
| anything else | `unknown` | no |

Three rows differ from OpenRouter. **403 is authorisation** — private endpoints,
network rules, a missing RBAC role — not moderation as it is on OpenRouter, so
it maps to `auth_failed`. **404 is almost always a deployment name that does not
exist on this resource**, so the message says that outright and names the
deployment it tried; a bare "not found" against a URL the user never typed is
close to useless. And **the content filter is recognised by code, not by prose**:
Azure names it (`content_policy_violation`, `ResponsibleAIPolicyViolation` and
friends, in `error.code` or `error.innererror.code`), which is more reliable than
matching English, with a message-pattern check kept only as a fallback.

**Nothing is `billed`.** Azure reports no cost in the response, so `cost_usd` is
`null` and the ledger prices the call from the curated per-image figure
(ADR 0008). A rejected request produces no image and is not charged for.

## Consequences

Azure is a real provider: `list_capabilities` reports it as `ready` once
configured, and the router will route `gpt-image-2` to it. The organisation
story in the README — GPT Image 2 under Entra ID governance — is now half true:
the adapter reaches Azure, but only with an API key until issue #23 lands.

The adapter imports `imageDimensions` from `providers/openrouter.ts`. Header
sniffing is now needed by two adapters, which is exactly the trigger ADR 0009
named for lifting it into the core — that move touches `src/core/` and is left
to a follow-up rather than folded into this issue.

The `n: 1` field and the omission of `response_format` are the two guesses in
the wire shape. Both are asserted in the contract test, so if a live run
disagrees the failure names the field rather than presenting as a mysterious
400.
