# 9. The OpenRouter adapter

**Status:** accepted
**Date:** 2026-08-26

## Context

OpenRouter is the zero-config default provider (PLAN.md §7). Its dedicated
Image API is documented in `docs/research/providers-2026-08.md` §1, but that
research answers only part of what an adapter has to decide: the documented
response carries `data[].b64_json`, `data[].media_type` and `usage.cost`, and
nothing else. Several choices had to be made where the API is silent or where
the normalised seam does not map onto it one to one.

## Decision

**`fetch` is a constructor parameter, defaulting to `globalThis.fetch`.** The
failure this project is guarding against is a wrong request shape — that is the
concrete bug that disqualified LiteLLM (research §5). An injected `fetch` lets
`test/contract/openrouter-request.test.ts` assert the exact URL, method,
headers and body, with no network and no recording harness. No HTTP mocking
dependency is added for the same reason.

**The model comes from `provider_hint` when it names one, otherwise from a
configured default.** `NormalisedRequest` has no `model` field; the router
passes its model choice through `provider_hint`, which PLAN.md §5.1 defines as
either a provider id or a full model id. A hint containing `/` is treated as a
model reference and sent as `model`; a hint naming the adapter itself is not a
model and falls through to the default. The built-in default is
`google/gemini-3.1-flash-image` — the cheap, broadly capable model the plan
already uses as its example of the sensible recommendation.

**`size` is passed through as the pixel string, and omitted for `"auto"`.**
The API accepts the OpenAI-style `size` field; `"auto"` is our vocabulary, not
theirs, so it is expressed by sending nothing and letting the model pick.
`style` has no field of its own, so it is appended to the prompt as
`"\n\nStyle: …"`, exactly as `NormalisedRequest.style` prescribes.

**Output dimensions are read from the image header.** The documented response
does not state the size produced, and `NormalisedResult` promises the size
actually produced rather than the size requested. So the adapter sniffs
PNG/JPEG/WebP/GIF headers from the decoded bytes. Order of preference:
dimensions the response states (if a future response ever does), then the
bytes, then the requested size, then `0×0` — never a silent echo of the
request.

**Error mapping.** Status to `FailureReason`, with `retryable` set to whether
retrying the *same* request could plausibly succeed:

| Status | Reason | Retryable |
|---|---|---|
| 400 | `invalid_request`, or `content_filtered` when the message reads like a policy rejection | no |
| 401 | `auth_failed` | no |
| 402 | `auth_failed` | no |
| 403 | `content_filtered` | no |
| 404 | `provider_unavailable` | no |
| 408, 504 | `timeout` | yes |
| 422 | `invalid_request` | no |
| 429 | `rate_limited` | yes |
| other 5xx | `provider_unavailable` | yes |
| transport failure | `provider_unavailable` | yes |
| abort/timeout | `timeout` | yes |
| anything else | `unknown` | no |

Two of these are not obvious. **402 is "top up your credits"**, and
`budget_exceeded` is reserved for a local refusal before any provider was
called (see `errors.ts`), so an account that cannot pay is mapped to
`auth_failed`: a credential-level problem no retry can fix. **403 is
moderation**, not authorisation — OpenRouter uses it for flagged input — so it
maps to `content_filtered` and 401 carries authentication on its own.

**Nothing is billed.** OpenRouter does not charge for a failed generation
(research §1), so every mapped failure has `billed: false`. The single
exception is a `200` that carries a positive `usage.cost` but no usable image:
money was reported spent, so the ledger is told.

**A `200` body containing an `error` object is treated as that error**, using
its `error.code` as the status. OpenRouter normalises some upstream failures
this way, and a caller that only checked `response.ok` would read a rate limit
as a missing image.

**Model discovery tries `/images/models` and falls back to
`/models?output_modalities=image`.** Both are documented; the first is
narrower. An `auth_failed` on the first is not retried against the second,
because a rejected key will reject twice and the second call only obscures the
message.

## Consequences

The adapter holds its key as a constructor argument rather than reading config
itself, so the wiring layer stays the only thing that calls `resolveApiKey`;
`isConfigured()` is then simply "a non-empty key was handed to me". Header
sniffing is a small amount of format knowledge living in a provider adapter —
acceptable while one adapter needs it, and the obvious thing to lift into the
core if a second one does. And the `size` mapping is the weakest documented
point: it is asserted in the contract test, so a live run that rejects it will
fail loudly rather than quietly producing the wrong dimensions.
