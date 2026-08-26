# 4. Config loading, validation and key resolution

**Status:** accepted
**Date:** 2026-08-26

## Context

`PLAN.md` §7 fixes the config *content*: a `config.json` that is safe to commit,
layered project-over-user-over-defaults, with secrets named rather than stored.
Four choices about how that is implemented were not obvious.

## Decision

**zod validates; the JSON Schema is generated from it.** The issue asks for
`schema/config.schema.json`, and the value of that file is editor autocomplete
and inline errors on the `$schema` line a user writes. Validating against it at
runtime would mean a JSON Schema validator dependency (ajv) next to the zod we
already ship for the MCP tool schemas, and two descriptions of the same shape to
keep in step. So `configFileSchema` is the single source of truth,
`configJsonSchema()` derives the published file with `z.toJSONSchema`, and a
unit test fails if the committed file has drifted. Regenerating it is a two-line
script plus `prettier --write`, which is cheap enough not to warrant a package
script of its own yet.

**Two schemas, not one: files are parsed without defaults.** A schema that
applies defaults while parsing a *fragment* would make every file contribute
values its author never typed, and the lowest-precedence file would then win by
accident. `configFileSchema` is therefore fully partial and default-free, and
defaults live in one place — `DEFAULT_CONFIG`, the base of the merge — with
`configSchema` applying only the per-provider defaults that cannot be known
until after merging (an unknown provider id has no entry in `DEFAULT_CONFIG`).
Each file is validated on its own so an error can name *that file*, and the
merged result is validated again for the cross-field rules.

**A key value never enters `Config`.** Only `api_key_env` — the *name* of an
environment variable — is stored, and the schema rejects anything that does not
look like a variable name, which catches a pasted key before it reaches disk.
`resolveApiKey` is the only function that touches a value, it returns it rather
than storing it, and no message it builds ever interpolates it. That makes the
whole config object safe to log by construction, rather than by remembering to
redact.

**Config failures are `ImagineError("invalid_request")`.** `FailureReason` is a
closed union built for provider failures (ADR 0003) and has no `invalid_config`
member. Rather than widen a type the whole seam depends on, config problems reuse
`invalid_request` — not retryable, not billed — so the MCP layer renders them
through the same path as any other failure. If configuration errors later need
to be distinguished from a bad tool argument, that is the moment to add a
reason, not before.

## Consequences

Config is loaded synchronously at startup with `readFileSync`; it is process
startup, and sync keeps the API and the tests free of ceremony. Strict objects
mean an unrecognised key is an error, so a forward-compatible field cannot be
added to a config file before the code understands it — deliberate, since a
silently ignored typo in `output.dir` is worse. Unknown *provider ids* are
allowed, because adapters are meant to be pluggable. And a provider block a user
writes is enabled unless it says `"enabled": false`, while the shipped defaults
disable every provider except OpenRouter, which is what makes the zero-config
path — one `OPENROUTER_API_KEY`, no file — work.
