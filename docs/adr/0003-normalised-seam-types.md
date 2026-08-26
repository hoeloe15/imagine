# 3. The normalised types at the seam

**Status:** accepted
**Date:** 2026-08-26

## Context

`NormalisedRequest`, `NormalisedResult`, `ProviderModel` and the failure type are
the only vocabulary shared by the MCP layer, the core router and the provider
adapters. Four choices in their shape were not obvious.

## Decision

**Image data is `Uint8Array`, not base64 and not a path.** The adapter decodes
whatever its API returns; `core/output.ts` is the only thing that writes. Base64
at this seam would mean every layer carries a 1.4 MB string it cannot use, and a
path would mean every adapter reimplements naming, directory creation and the
manifest — and would make the phase 3 Blob Storage sink a rewrite instead of a
swap. `Uint8Array` rather than `Buffer` keeps the core free of a Node-only type.

**Failures are thrown as one `ImagineError` class, not returned as a result
union.** `ImageProvider.generate` resolves with an image or throws; there is no
success flag to forget to check, and adapters get to use ordinary `try`/`catch`
around their HTTP calls. The class carries `reason`, `retryable` and `billed`,
and both flags default to the conservative answer: do not retry, assume nothing
was charged. `FailureReason` is a closed union so the router can decide on
retry and fallback by pattern matching rather than by parsing messages.

**Field names are the snake_case names of the public tool API** (`use_case`,
`provider_hint`, `output_dir`, `cost_usd`, `mime_type`). One vocabulary from
tool argument to adapter beats a rename at every layer boundary, and it keeps
`PLAN.md` §5 readable as the spec for these types.

**No zod at this seam.** Validation belongs where untrusted input arrives — the
MCP tool schemas and the config loader. A `NormalisedRequest` is only ever built
by our own code from already-validated input, so a runtime schema here would buy
nothing and would have to be kept in step with the tool schemas by hand.

**`ProviderModel.capabilities` is an opaque record.** It is whatever the
provider says about itself, surfaced by `list_capabilities` and not interpreted
by the router. The curated editorial knowledge the router actually selects on
lives in `data/models.json`, which is a different thing with a different schema.

## Consequences

`cost_usd` is nullable, because not every provider reports a cost; the ledger
(issue #7) has to fall back to the estimate in `models.json` and record which
source it used. Anything that needs a `Buffer` has to wrap the bytes. And when
an adapter meets a failure it cannot classify, it must still pick a
`FailureReason` — `unknown`, treated as not retryable — rather than inventing
one.
