# 13. An explicit model reference at the adapter seam

**Status:** accepted
**Date:** 2026-08-27
**Amends:** ADR 0007, ADR 0009

## Context

ADR 0007 sent the router's resolved model reference to the adapter by
overwriting `NormalisedRequest.provider_hint` with it, and ADR 0009 had the
OpenRouter adapter read that field back: a hint containing `/` was treated as a
model reference, anything else fell through to a default. One field carried two
meanings — what the caller asked for, and what the router decided — told apart
only by a slash and by an unwritten rule about who wrote the field last.

That is fragile in two directions. An adapter written against the seam cannot
tell the two meanings apart at the type level, so a caller-supplied hint that
happens to look like a model id is indistinguishable from a routing decision.
And a request that never went through the router carries a hint the adapter
will honour as if it had. Issue #29 asks for the reference to travel
explicitly; issue #9 (the Azure adapter) should land on the clarified seam
rather than on the overloaded one.

## Decision

**`ImageProvider.generate` takes a second argument.**

```ts
export interface ResolvedModel {
  model_ref: string;
}

generate(
  request: NormalisedRequest,
  resolved?: ResolvedModel,
): Promise<NormalisedResult>;
```

A second parameter rather than a routed-request type: the request stays the one
value that travels unchanged from tool argument to adapter, and `ResolvedModel`
stays a decision *about* a request rather than a second shape of it. A caller's
hint and the router's choice now have different types in different positions,
so no adapter can confuse them by accident.

**The router no longer touches `provider_hint`.** It defaults `size` from
config and passes the caller's request otherwise untouched, with
`{ model_ref }` beside it. By the time an adapter sees a request, the hint is
still a hint — an adapter simply has no reason to read it.

**`resolved` is optional, and an adapter falls back to a default model of its
own.** The router always supplies it; a direct construction — a contract test,
a script, a live check — does not have to invent one. `OpenRouterProvider` keeps
its `model` constructor option and its built-in
`google/gemini-3.1-flash-image` default for exactly those calls, and the
hint-contains-a-slash heuristic is gone.

**`StubProvider.generate` takes the request it used to omit, and reports the
resolved reference as its model**, falling back to `stub-image-1`. An adapter
that ignored the seam and reported a model the router did not choose was the
loose end ADR 0007 named in its own consequences; it is closed here.

## Consequences

No caller-visible behaviour changes: `generate_image` builds the same request,
the router makes the same selection, and OpenRouter receives the same wire body
for every routed call. The one changed behaviour is for *direct* adapter use
outside the router: `OpenRouterProvider.generate({ prompt, provider_hint:
"vendor/model" })` used to generate with that model and now generates with the
adapter's default. Passing `{ model_ref: "vendor/model" }` as the second
argument is the replacement, and the contract test pins both halves.

Every adapter added from here — the Azure adapter in issue #9 first — reads its
model from `ResolvedModel` and never from the request.
