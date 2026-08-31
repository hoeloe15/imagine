# 19. No JSON Schema dialect on tool schemas

**Status:** accepted
**Date:** 2026-08-31

## Context

Issue #52: a Claude Code session refused `list_capabilities` outright with

    Tool has an invalid outputSchema: JSON Schema declares an unsupported
    dialect ("$schema": "http://json-schema.org/draft-07/schema#"). The
    default validator supports JSON Schema 2020-12 only.

Other clients accept the same tool, so the server works in one runtime and not
in another — the worst kind of bug for something meant to be shared.

The cause is in the SDK, not in our schemas. `McpServer`'s `tools/list` handler
converts every registered zod shape through `toJsonSchemaCompat`, which routes
zod v3 shapes to `zodToJsonSchema` and zod v4 shapes to Zod Mini's
`toJSONSchema`. Both branches take a `target` option, both default it to
draft-7, and `McpServer` passes only `strictUnions` and `pipeStrategy` — there
is no way through the public API to ask for a different dialect. 1.30.0 is the
latest published SDK, so there is no version to upgrade to; the ceiling in
`package.json` stays `^1.20.0` and the installed 1.30.0 is unchanged.

## Decision

**The `$schema` declaration is removed from every tool's `inputSchema` and
`outputSchema` before the listing goes out**, rather than being rewritten to the
2020-12 URI. A schema that declares no dialect is validated in the validator's
own, which is what both camps of client already do with a schema they accept.
Rewriting the URI would assert a dialect the body was not generated for; leaving
it off asserts nothing. It is safe here because the generated bodies use no
keyword whose meaning differs between draft-07 and 2020-12 — only `type`,
`properties`, `required`, `items`, `enum`, `anyOf`, `additionalProperties`,
`minLength` and `description`. A zod tuple would break that assumption
(draft-07's array-form `items` means something else in 2020-12), which is a
reason to keep tuples out of tool schemas, not a reason to prefer the URI.

Dropping `outputSchema` and `structuredContent` altogether was the issue's last
resort and is not needed: compliant clients keep their typed output.

**The rewrite happens in one place**, `src/mcp/json-schema-dialect.ts`, called by
`createServer` before any tool is registered. It wraps the `tools/list` handler
that `McpServer` installs on the underlying `Server` when the first tool is
registered, so tools stay ordinary `registerTool` calls with plain zod shapes
and no tool has to know about any of this. Wrapping the handler as it is
installed is what keeps this to one interception point; the alternative —
replacing the handler afterwards — would mean reimplementing the SDK's whole
listing, and the per-tool alternative would mean three places to forget.

This reaches into the SDK's request-handler registration, which is not a
supported extension point. `test/unit/server.test.ts` drives a real client over
`InMemoryTransport` and asserts the serialised listing contains no
`json-schema.org` reference at all, so an SDK change that moves the seam fails
loudly rather than silently restoring the client-side refusal.
