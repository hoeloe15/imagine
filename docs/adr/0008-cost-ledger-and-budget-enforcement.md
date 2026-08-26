# 8. Cost ledger and budget enforcement

**Status:** accepted
**Date:** 2026-08-26

## Context

PLAN.md §4.4 makes cost a first-class return value: every generation logs what it
cost, and config caps spend per session and per day. Issue #7 turns that into
`core/budget.ts`. Several of its choices are not implied by either document.

## Decision

**A provider-reported cost always wins; the curated price is only a fallback.**
`resolveCost` prefers `reported_cost_usd` whenever it is a finite non-negative
number — `0` included, because free models genuinely report zero and treating
that as "missing" would substitute a made-up price for a known one. The curated
`estimateCostUsd` (ADR 0005) is used only when the provider reports nothing, and
every record carries `cost_source: "provider" | "estimate" | "unknown"` so a
later reconciliation can tell the two apart. An entry with neither figure is
recorded as `unknown` at zero rather than being given an invented price;
knowledge.ts already refuses to treat an uncurated model as free, and the ledger
must not undo that by guessing.

**An unbilled attempt is recorded at zero, not at its estimate.** ADR 0003 gives
`ImagineError` a `billed` flag defaulting to "assume nothing was charged", and
issue #7 requires that an unbilled failure not count against a budget. The record
is still written to the cost log — a refusal that leaves no trace is the silent
stall PLAN.md §7 rules out — but with `billed: false` and `cost_usd: 0`. Writing
the estimate alongside `billed: false` was rejected: the log is the artefact a
user greps to answer "what did today cost", and a number in a `cost_usd` column
that was never charged is a lie a reader has to know to discount.

**A day is a local calendar day, and it resets at local midnight.** The issue
does not say. UTC would be defensible for a server, but this is a developer tool
running on a laptop: a user who is told "$8 of $10 spent today" means their own
day, and a budget that rolls over at 02:00 CEST would be surprising. The record
carries both an ISO `timestamp` and a local `day` key; totals are always
recomputed from `timestamp`, so the `day` field is greppability for the phase 2
gallery, not the source of truth, and a log carried across timezones re-buckets
rather than accumulating two conflicting notions of a day.

**The cost log is the day accumulator.** A session is one process (PLAN.md §7)
and lives in memory, but a day outlives restarts, so `openCostLedger` sums the
billed records already in `logging.cost_log` into the day totals before serving
the first request. Otherwise `max_usd_per_day` would be a per-process cap under
another name, and restarting the server would be the way around it. History
never counts as session spend. A line that cannot be read as a record is skipped
and counted in `skippedHistoryLines`; a corrupt log line must not stop the server
from starting, and dropping one line understates spend far less than refusing to
start would help.

**Exactly reaching a limit is allowed; only exceeding it is not.** The check is
`spent + estimate > limit`, with a 1e-9 slack so binary floating point cannot
refuse a request that lands exactly on the cap. Totals are rounded to a millionth
of a dollar on the way in and out, which is two orders of magnitude below the
cheapest per-image price the curated file records.

**When both limits would be exceeded, the one with the least headroom is
reported.** Both apply, and the message a caller sees should name the limit that
will keep biting.

**`check` answers, `authorise` enforces.** `check` is pure with respect to the
budget and returns a `BudgetDecision`; `authorise` throws a `budget_exceeded`
`ImagineError` (`retryable: false`, `billed: false`) under `on_exceed: "refuse"`
and otherwise returns the same decision with `exceeded: true` and a message for
`warn` to surface. Splitting them keeps `list_capabilities` and `recommend_model`
able to report budget state without risking a throw on a read-only call.

## Consequences

The cost log is append-only JSONL at `logging.cost_log`, one record per attempt:
`timestamp`, `day`, `session_id`, `provider`, `model`, `cost_usd`, `cost_source`,
`billed`, `failure_reason`, `prompt`, `image_path`. Like the manifest (ADR 0006)
it is written with `appendFile`, which is atomic enough for one process and is
not a guarantee across processes; two servers sharing a cost log can interleave.
Day totals are read at startup only, so a second server started later will not
see the first one's ongoing spend until it restarts.

A failed append throws, after the spend has already been counted in memory — the
budget stays correct for this process, and the error names the amount and the
file so nothing is lost silently. Setting `logging.cost_log` to `null` keeps the
ledger in memory: budgets still work for the session, and the daily cap becomes
per-process.
