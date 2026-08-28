# 15. Provider-condemning versus request-condemning failures

**Status:** accepted
**Date:** 2026-08-28
**Amends:** ADR 0007

## Context

ADR 0007 drew one line through failure handling: retryable failures cause a
retry and then a fallback, and every non-retryable failure ends the request.
The reasoning was cost honesty — another provider will not fix a malformed
prompt, and paying a second provider to fail the same way spends the caller's
money without being asked.

The first real multi-provider run showed that line is in the wrong place.
OpenRouter was configured with an invalid key — `isConfigured()` only checks
that the environment variable is non-empty, so the router had no way to know
before calling — and Azure was configured and working. A `generate_image` call
with no `provider_hint` ranked OpenRouter first, got a 401, mapped it to
`auth_failed`, and threw. Azure was never tried, although it would have
succeeded (issue #49).

`auth_failed` does not say *this request is bad*. It says *this provider is
unusable*, for this request and every other one, until an operator fixes a key.
Refusing to fall back protects nothing: a provider that rejected the
credentials never authorised a call, so it cannot have billed for one, and the
next provider in the chain is exactly the right place to go. Meanwhile the
caller — usually a model, not a human reading logs — is handed a hard failure
for a request that was perfectly serveable.

## Decision

**Non-retryable is two things, and the router tells them apart by reason.**
A `FailureReason` either condemns the *provider* or condemns the *request*.

| Reason | Retry same provider | Fall back | Rationale |
| --- | --- | --- | --- |
| `auth_failed` | no | **yes — provider excluded** | Credentials are wrong for this provider only. Retrying the same key cannot help; nothing was billed; the next provider is untouched by the problem. |
| `rate_limited` | yes (one probe) | yes | Unchanged from ADR 0007. |
| `timeout` | yes (one probe) | yes | Unchanged from ADR 0007. |
| `provider_unavailable` | yes (one probe) | yes | Unchanged from ADR 0007. |
| `content_filtered` | no | no — throws | Condemns the request. Another provider is a second charge for a prompt the caller has not yet seen refused, and a policy shop-around we should not do on the caller's behalf. |
| `invalid_request` | no | no — throws | Condemns the request. A malformed request is malformed everywhere; if it is malformed for one provider only, that is our normalisation bug to fix, not a cost to pass on. |
| `budget_exceeded` | no | no — throws | Condemns the request by construction. It is a *local* refusal from `budgetPrecheck` before any call; falling back would be the router spending exactly the money the ledger just refused. |
| `unknown` | no | no — throws | Kept terminal, deliberately. ADR 0007's conservative default still applies: an unclassified error may well have reached the provider and been billed, and it is the reason an adapter returns when it has *no* information — the worst possible basis for deciding another provider is safe to charge. When a real `unknown` turns out to be an auth failure in disguise, the fix is in the adapter's mapping, not in loosening this default. |

Only `auth_failed` condemns the provider today. The set is a named constant in
`router.ts` rather than a flag on `ImagineError`, so the router — the only thing
that owns fallback policy — decides, and an adapter cannot opt itself into
having its failures shopped around to other providers.

**A condemned provider skips its retry.** Providers already get at most one
attempt per request (ADR 0007); a rejected credential does not deserve the
second call within that attempt either, so the router breaks out of the retry
loop and goes straight to the next provider.

**The exclusion is named in the trail and in `selection_reason`.** The failed
attempt is recorded in `attempts` as always, and `selection_reason` gains a
clause naming each excluded provider, its reason and its message:

```
no hint, use case or configured default; …; fell back to azure after
openrouter/openai/gpt-image-2 (auth_failed); excluded for this request:
openrouter (auth_failed: 401 from provider: invalid API key)
```

A silent fallback would hide a broken key indefinitely — the request succeeds,
the operator never learns their OpenRouter key stopped working, and the bill
quietly moves to another provider. The point of falling back is to serve the
request *and* say what happened. The same clause is appended to the error when
every provider fails, so an all-keys-wrong installation gets told which keys.

## Consequences

The observed scenario now works: invalid `OPENROUTER_API_KEY` plus a working
Azure config, hint-less `generate_image`, served by Azure with the OpenRouter
auth failure named in the reasoning. `test/unit/router.test.ts` pins it, along
with the no-retry-on-`auth_failed` rule, the trail contents, and the terminality
of `content_filtered`, `invalid_request`, `budget_exceeded` and `unknown`.

When every provider's credentials are rejected, `route` throws `auth_failed`
(the last failure's reason) rather than `provider_unavailable`, with the whole
trail in the message. That is a better diagnosis than before, when the first
provider's failure ended the request and later providers were never shown to be
broken too.

Cost exposure grows by at most one call per request, and only for a reason that
cannot have been billed. `content_filtered` — the reason ADR 0007 was really
protecting against — is unchanged.

`isConfigured()` staying a non-emptiness check is now a smaller problem: a key
that is present but wrong costs a wasted round trip and a line in the trail
instead of a failed request. Validating keys at startup remains a separate, and
much less urgent, idea.
