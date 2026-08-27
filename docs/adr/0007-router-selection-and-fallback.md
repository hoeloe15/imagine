# 7. Router selection and fallback

**Status:** accepted, amended by [ADR 0013](0013-explicit-model-ref-at-the-adapter-seam.md)
**Date:** 2026-08-26

> **Amendment (ADR 0013).** "The resolved model reference travels to the adapter
> in `provider_hint`" no longer holds. `ImageProvider.generate` takes the
> resolved reference as a second argument, `ResolvedModel`, and the router
> leaves `provider_hint` as the caller wrote it. Every other decision below
> stands.

## Context

`src/core/router.ts` turns a `NormalisedRequest` into a concrete (provider,
model) pair, calls the adapter, and decides what to do when that call fails.
PLAN.md §4.1 fixes the selection order — hint, use case, configured default,
bundled default — and insists a hint that cannot be honoured is reported rather
than hidden. Five things it does not settle had to be decided here.

## Decision

**The resolved model reference travels to the adapter in `provider_hint`.**
`ImageProvider.generate` takes a `NormalisedRequest` and nothing else, and that
type has no model field; the only channel from router to adapter is the request
itself. So the router overwrites `provider_hint` with the `model_ref` of the
availability entry it selected before calling `generate`. By the time an adapter
sees a request, the hint has stopped being a hint: it is the model to use, in
that provider's own namespace, and an adapter is entitled to treat it as such.
Adding a `model` field to the seam types would be the cleaner shape, but it
would change a type three other issues are already building against.

**Only retryable failures cause a fallback.** A transient failure gets one
immediate retry against the same provider; if it fails again the router moves to
the next provider in the chain. A failure the adapter marked non-retryable —
`content_filtered`, `invalid_request`, `auth_failed`, `budget_exceeded`,
`unknown` — ends the request immediately, with no second provider tried. Another
provider will not fix a malformed prompt or a spend cap, and quietly spending
money elsewhere on a request the caller has not seen fail is the opposite of the
cost honesty in PLAN.md §4.4. The client is told which reason it hit and can
retry with a different `provider_hint` deliberately; PLAN.md §5.1 already shapes
that failure result as a suggestion, not an automatic second attempt.

**Retries are immediate, with no backoff.** One retry against a provider that
just rate-limited is a cheap probe, not a retry policy; a real policy needs
provider-supplied `Retry-After` handling, which belongs in the adapters that can
read that header. Sleeping in the core would also make every router test wait.

**A provider is tried at most once per request.** The candidate chain lists a
model through every provider that can reach it, in the operator's configured
provider order, so a hinted or highest-scoring model survives one of its
providers being down before the router drops to a weaker model. But once a
provider has failed twice, every later candidate on that provider is skipped: a
provider that is rate-limited or down is rate-limited or down for every model it
serves.

**The bundled default is the strongest model overall, not a hard-coded id.**
With no hint, no use case and no `default.model` there is nothing to optimise
for, so the chain is ordered by the sum of a model's use-case scores, then by
price, then by id. This keeps the fallback a property of `data/models.json`
rather than of the code: a weekly knowledge update moves the default without a
release, which is exactly the churn PLAN.md §4.3 promises to absorb.

## Consequences

Budget enforcement stays out of the router: `route` takes an optional
`budgetPrecheck(candidate)` callback, consulted before every adapter call and
expected to throw `ImagineError("budget_exceeded")`. That is the whole surface
the cost ledger (issue #7) needs; issue #10 wires the two together.

The router reports more than it selects. `RoutingOutcome` carries the chosen
candidate, a `selection_reason` string for the tool result, a `hint` outcome
saying whether the caller's hint was honoured and why not, and an `attempts`
array with every adapter call including the failed ones — the fallback trail the
response envelope in PLAN.md §5.1 wants.

Because the resolved reference overwrites `provider_hint`, an adapter must not
read that field as a caller-supplied provider name. Adapters that ignore it and
generate with a fixed model — `StubProvider` does — still work, but will report
a model the router did not choose. *(ADR 0013 removed the overwrite and gave
`StubProvider` the resolved reference to report.)*
