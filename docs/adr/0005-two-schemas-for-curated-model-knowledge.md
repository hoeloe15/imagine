# 5. Two schemas for the curated model knowledge

**Status:** accepted
**Date:** 2026-08-26

## Context

`data/models.json` is hand-edited weekly by a human, and later by a bot opening
a PR against it. It is also read at startup by the router, which selects models
on it. Both audiences need a schema, and they want different things from one:
the editor wants completion and red squiggles inside the file, the loader wants
a typed value and a readable error.

ADR 0003 already ruled that zod belongs where untrusted input arrives, not at
the internal seam. A bundled data file is exactly that boundary — it is data,
not code, and a stale hand-edit is the most likely way it goes wrong.

## Decision

**Two schemas, with the zod one authoritative.** `schema/models.schema.json`
(JSON Schema 2020-12) is referenced from the file's own `$schema` key and serves
editors and reviewers. `src/core/knowledge.ts` carries the zod schema, which is
what actually runs. No JSON Schema validator is added as a dependency: ajv would
be a runtime dependency earning nothing that zod, already present, does not
give — and a validator that only runs in CI would not protect a user whose
hand-edited file is wrong at startup. A unit test asserts the two agree on the
parts that could silently drift: the use-case keys and the schema version.

**Both schemas are strict.** An unrecognised field is an error rather than
something quietly dropped, because the likeliest cause is a typo in a key the
router then treats as absent — a score that reads as missing, not as wrong.

**Every use case in `USE_CASES` must be scored.** The zod strengths shape is
derived from that constant rather than written out, so adding a use-case tag
makes the existing entries fail validation instead of defaulting them to a
score nobody chose.

**Ties rank by price, then by id.** Editorial scores are a coarse 1–5, so ties
are normal rather than exceptional. Falling back to the cheaper model matches
the cost-honesty principle in PLAN.md §4.4, and the final id tiebreak keeps the
order independent of the order entries happen to sit in the file.

**Azure's `model_ref` is the canonical model id, not a deployment name.** A
deployment name is per-installation and belongs in config
(`providers.azure.deployments`), so a placeholder in shared curated data would
be a value no installation can use. The availability note says where the real
name comes from.

**Loading walks up for the package root.** This module runs from `src/core/` in
tests and from `dist/` once bundled, so a counted `../..` would be right in one
and wrong in the other.

## Consequences

Adding a field means editing two files. That is accepted: the JSON Schema is
short, and the test that pins the shared parts fails loudly when only one is
updated. `ImagineError` now carries a failure that is not a generation failure —
malformed curated data is raised as `invalid_request`, which reads oddly but
avoids widening `FailureReason` for a startup concern.
