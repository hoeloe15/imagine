# 11. What `list_capabilities` reports, and how it knows

**Status:** accepted
**Date:** 2026-08-26

## Context

Issue #11 asks for a read-only tool answering "what can this installation do
right now?": provider status, the models reachable through each, which
environment variables an unconfigured provider is waiting for, the budget state
and how stale the curated data is. PLAN.md §5.2 fixes the broad shape but leaves
open where the tool learns which keys are missing, what "the models" means when
the curated file and the provider disagree, and what `status: "error"` is for.

## Decision

**Missing keys are answered from the environment, so the MCP layer is handed
one.** Whether a key is present is a fact about the ambient environment, not
about `Config` — `Config` only ever names the variable (ADR 0004). The narrowest
thing that closes the gap is an optional `env` on the tool's dependencies, filled
from `LoadedConfig.env` by the composition root and defaulting to `process.env`.
`LoadedConfig` itself is not passed: it carries the resolved key values' source
and would put a superset of the config into the MCP layer for no gain.

The readiness rule is reimplemented as a boolean rather than borrowed from
`resolveApiKey`, which throws prose naming config files this tool does not have.
The rule is small — enabled, Entra, `api_key_env`, is it set — and the drift risk
is smaller than the cost of synthesising a fake `LoadedConfig` to reuse it.

**Only the *name* of an unset variable is ever reported.** `missing` holds
variable names; nothing reads a value, so no prefix, length or fingerprint of a
key can reach the client. A test asserts the key value does not appear anywhere
in the serialised result.

**`status` is about reachability, not about whether a generation will work.**
`ready` means credentials are present, an adapter is registered, and the adapter
reports itself configured. `not_configured` covers every way a provider is not
wired up — no key, disabled, no adapter in this build — with a `note` saying
which, since the four cases need different actions from the user. `error` is
reserved for a provider that is configured but did not answer model discovery:
that is genuinely a fault to report rather than a setup step to complete.

**A provider that fails discovery never fails the tool.** Discovery runs per
provider and its failure is captured as that provider's `error`, with the curated
references from `data/models.json` standing in for the model list. One
unreachable provider must not cost the client the answer about all the others.

**Discovery is cached per adapter instance for the process lifetime, failures
included.** The issue asks for a process-lifetime cache; caching the *outcome*
rather than the models means an unreachable provider is not re-dialled on every
call, which is where repeated latency would hurt most. The cache is a `WeakMap`
keyed by the adapter, so it dies with the adapter and cannot leak between tests.

**`models` per provider is what the provider says, ordered curated-first.** When
discovery succeeds the list is the provider's own, with curated references first
because those are the ones the router can actually pick; a curated reference the
provider does not report is dropped, since the provider is the authority on what
it can serve today. `models_source` says which of the two sources the list came
from, so a client can tell "the provider told us this" from "this is what our
file claims".

**`default_model` is asked of the router, not derived.** It is
`planCandidates`' first candidate for an empty request, so what the tool reports
as the default cannot drift from what `generate_image` would actually pick. With
nothing reachable the configured `default.model` is reported instead, which may
be `null`.

**The budget block is the full snapshot plus `on_exceed`.** ADR 0010 kept the
day figures out of the `generate_image` envelope and named this tool as their
home. `on_exceed` rides along because "spent $4.90 of $5" means something
different when the next request is refused than when it is merely flagged.

## Consequences

`ServerDependencies` gains an optional `env`; existing callers and tests that
build dependency literals are unaffected, and a server built without the config
loader silently reads `process.env`, which is what it would have seen anyway.

`test/unit/server.test.ts` asserted the exact tool list, which a second tool
breaks by construction. It now asserts containment per tool — still a guard
against the empty `tools/list` regression of ADR 0002, but one that does not have
to be edited every time a tool is added.

The per-provider model list is only as short as the provider's own image-model
catalogue. If a provider ever reports hundreds, this response grows with it and
will need a cap — a limit argument would be the place to put one, at the cost of
the tool no longer taking no parameters.
