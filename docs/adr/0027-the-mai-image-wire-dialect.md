# 27. The MAI-Image wire dialect inside the Azure adapter

**Status:** accepted
**Date:** 2026-09-04
**Amends:** [ADR 0014](0014-azure-openai-adapter.md)
**Follows:** [ADR 0013](0013-explicit-model-ref-at-the-adapter-seam.md),
[ADR 0022](0022-hosted-config-and-managed-identity.md)

## Context

Microsoft's own image models — the MAI-Image family — are deployable into the
same Azure resource that already serves GPT Image 2, and on the public image
arena of 2026-09-04 MAI-Image 2.6 ranks second, ahead of everything else this
repo curates except GPT Image 2. Adding it looked like a config change: name a
deployment, done.

It is not. `docs/research/mai-image-2026-09.md` found that MAI is a **different
API on a different host**, and it disagrees with Azure OpenAI on exactly the
detail ADR 0014 exists to protect:

| | `gpt-image` (ADR 0014) | MAI-Image |
| --- | --- | --- |
| Host | `<resource>.openai.azure.com` | `<resource>.services.ai.azure.com` |
| Path | `/openai/deployments/{deployment}/images/generations` | `/mai/v1/images/generations` |
| Deployment named in | the **URL path** | the **request body**, as `model` |
| `api-version` | required query string | none |
| Size | `size: "1536x1024"` | `width` and `height` integers |
| `n` | sent as `1` | not a parameter; one image per call |
| Entra audience | `https://ai.azure.com/.default` | `https://cognitiveservices.azure.com/.default` |

The irony is worth writing down, because it is the whole reason this is
dangerous: **putting the deployment name in the body is the failure that broke
LiteLLM for `gpt-image`, and it is mandatory for MAI.** The rule is per-API, not
per-vendor, and a well-meaning future change that "makes the Azure adapter
consistent" would break one of the two.

All of the above was confirmed against the owner's real deployment on
2026-09-04: a Bearer token for the `cognitiveservices` audience, no
`api-version`, `model` in the body, `200` with a base64 PNG in `data[0].b64_json`.

## Decision

**A wire dialect seam inside `src/providers/azure.ts`, not a second provider.**

The dialects share far more than they differ on: the auth header handling, the
base64 decode, the MIME sniff, the status-to-reason table, the content-filter
detection, the 404 hint, the deployment resolution and the "one deployment is
the default" rule are all identical, and all of them are things we got wrong at
least once before getting right. A `MaiProvider` would either duplicate them or
grow a shared base class, and it would also lie to the router and to
`list_capabilities`, which would see two Azure providers where the operator has
one Azure resource. Three things branch on the dialect and nothing else does:

1. **The URL.** `/mai/v1/images/generations` with no query string.
2. **The body.** `{ model, prompt, width, height }` instead of
   `{ prompt, n, size }`.
3. **The Entra scope.**

**The dialect is a property of the deployment, not of the provider**, because one
resource legitimately serves both. So `providers.azure.deployments` values widen
from a bare string to `string | { deployment, dialect?, endpoint? }`. **A bare
string still means the `openai` dialect**, so every config written before this
ADR keeps working and nothing has to be migrated; that is the whole reason for
the union rather than a cleaner object-only shape.

**The MAI host is derived, not configured.** It is the same resource under a
different suffix, so the adapter takes the resource name from the endpoint the
operator already wrote and swaps the suffix for `services.ai.azure.com`. Asking
an operator to write the same resource name twice invites the two to disagree.
The per-entry `endpoint` exists as the escape hatch for a resource whose host
does not follow the pattern, and nothing in the normal path uses it.

**The Entra scope becomes a parameter of the token provider rather than a
file-level constant.** `AccessTokenProvider` was `() => Promise<string>` with
the scope baked in at construction; it is now `(scope) => Promise<string>`, and
the adapter asks for the audience the dialect's endpoint accepts. The
composition root keeps one memoised managed-identity provider per scope, so each
audience still gets the token caching ADR 0022 built. This was forced: the two
endpoints accept different audiences and nobody has documented that a token for
one works at the other, so guessing would have made a 401 the first symptom.

**Sizes are clamped, and the answer is read from the PNG.** MAI takes free
integers inside `width x height <= 1,048,576` with each side at least 768. Of the
three sizes the tool offers, `1024x1024` fits exactly and the other two do not —
`1536x1024` is 1,572,864 pixels. Rather than refuse a size the tool advertises,
the adapter **shrinks the request to the largest same-shape size that fits**,
rounded down to a multiple of eight: `1536x1024` becomes `1248x832` and
`1024x1536` becomes `832x1248`. `auto` and an absent size mean the square.

Refusing instead was the alternative, and it was rejected because it would make
`generate_image` fail for a size the tool's own schema lists, for a reason the
caller cannot act on. Shrinking is not silent either: the result already reports
the dimensions read from the returned **PNG header**, so a caller that asked for
1536 wide is told it got 1248, and `max_size` in `data/models.json` says
`1024x1024` so the router and `recommend_model` never promise more.

**Both dialects are pinned as mirror images in
`test/contract/azure-request.test.ts`.** The `openai` block asserts the
deployment is in the path and that the deployment name appears nowhere in the
body; the `mai` block asserts `model` **is** the deployment name in the body, the
path contains no deployment name, the query is empty, the host is
`services.ai.azure.com`, and width and height are integers inside the budget.
That pair of tests is the most valuable artefact of this change: it makes the
difference between the two APIs impossible to lose by accident.

## Consequences

The Azure surface area is permanently doubled: every future change to the Azure
adapter now has two paths to get right, and the mitigation is that the seam is
deliberately three branches wide and the contract tests fail loudly if a fourth
appears without being asserted.

`list_capabilities` now reports a `dialect` for every Azure deployment, and omits
`api_version` for MAI ones, because there is no API version to report.

`data/models.json` gains its first **Azure-only** model. Until now every curated
model was reachable through OpenRouter, and a test asserted exactly that; it no
longer holds, and MAI-Image 2.6 is now the answer to "best photoreal" on a
tie-break against FLUX 2 Pro, which is a curation question issue #59 raises and
does not settle.

Two things about MAI-Image 2.6 stay unverified and are recorded in the model
notes rather than smoothed over: **its price**, because Microsoft prices the
family per token and publishes no rate for 2.6 at all — the curated figure is the
published 2.5 output rate times a token count we measured on a real call — and
**its latency**, for which no first-party number exists. Both are marked
indicative. The **edits** endpoint (multipart, identity preservation) is real and
is not implemented; the repo has no abstraction for editing an image yet.
