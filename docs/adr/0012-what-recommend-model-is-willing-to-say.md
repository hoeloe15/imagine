# 12. What `recommend_model` is willing to say

**Status:** accepted
**Date:** 2026-08-26

## Context

Issue #12 and PLAN.md §5.3 fix the response shape of `recommend_model`, but the
shape is the easy half. The tool has to make three judgements the plan states as
prose: when a cheaper model is the honest answer, what to do with free text like
`"20 images for a deck"`, and what to say when the best model for a use case is
one the caller cannot reach. PLAN.md §4.4 is blunt about the stakes — a
recommender that always recommends the best model is a recommender nobody trusts
on their second invoice — and being wrong in the other direction is just as bad.

## Decision

**The advice is assembled in the tool, over `planCandidates`, not in a new core
module.** Issue #12 asked for `src/core/recommend.ts` as well. There is nothing
for it to hold: the selection decision already lives in `core/router.ts`, the
ranking and the cost arithmetic in `core/knowledge.ts`, and what is left is the
prose and the shape of one tool result — which is what `src/mcp/tools/` is for.
Calling `planCandidates` rather than re-ranking against the configured providers
is the point: the model `recommend_model` names is by construction the model
`generate_image` would route to, and the two cannot drift.

**A cheaper model wins on a small gap repeated across a batch, never on a large
one.** With the curated scores as the only quality signal, the rule is: a
cheaper model that scores at least as well always wins; a gap of one point wins
only from three images up and only at a 1.5x price ratio or better; a gap of two
or more never wins on volume, because that is a different model rather than a
discount. A stated dollar cap overrides all of it — a recommendation the caller
cannot afford is not a recommendation. The thresholds are editorial, like the
scores they read, and they are named constants so an argument about them is an
argument about one line.

**A count is parsed only where a word for a picture says so, and the assumption
is always stated back.** `"20 images for a deck"` yields 20; `"under $1 total"`
yields no count at all rather than a dollar amount mistaken for one. Every
response carries `estimate.assumption` in words — "Read 20 images from
budget_hint …" or "No count found in budget_hint …" — so a wrong parse is
visible in the answer instead of silently doubling an estimate. The same free
text is read for a dollar cap, which is what makes "under $1 total" actionable.

**`recommended_model` names the choice; the estimate keeps PLAN.md's fields.**
`estimate.recommended_total_usd` is `best_configured` × count and
`cheaper_total_usd` is `cheaper_alternative` × count, as §5.3 shows. Which of
the two the tool actually lands on moves into a separate `recommended_model`, so
a client learns the answer without parsing the prose — and so the two totals keep
meaning the same thing whichever way the recommendation goes.

**Nothing that can be reached is left unmentioned, and nothing is an error.**
`note_on_unconfigured` names the strongest model the caller cannot reach and,
per provider, what enabling it takes: the environment variable the config names,
the `enabled` flag, or the fact that this build registers no adapter for it. A
provider with no adapter is never offered as a fix. An installation with nothing
configured still gets the full editorial answer plus those notes rather than a
failure envelope: advice about models you cannot reach yet is exactly what such a
caller needs, and the tool spends nothing either way.

## Consequences

The tool is `readOnlyHint: true` and honestly so — it calls no adapter, opens no
ledger and takes `config`, `knowledge` and `providers` only, so
`ServerDependencies` needed no new field and `src/composition.ts` no change.

The prose is generated from the curated `notes` field: the first sentence
becomes the "why", and a "Do not pick it when…" sentence becomes the trade-off
caveat. That gives `data/models.json` a soft convention — write the pick and the
caveat as separate sentences — which the schema does not enforce. A model whose
notes do not follow it loses a caveat, not correctness.

The prefer-cheaper thresholds are duplicated nowhere but tested directly
(`test/unit/recommend-model.test.ts` covers best-is-configured,
best-is-not-configured, volume-implies-cheap, cap-overrides-quality and the
no-arguments answer). Changing a threshold changes those tests, which is the
intended amount of friction.
