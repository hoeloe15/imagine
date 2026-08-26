# 10. `McpServer`, and the shape of the `generate_image` tool

**Status:** accepted
**Date:** 2026-08-26
**Supersedes:** [ADR 0002](0002-low-level-mcp-server-in-the-scaffold.md)

## Context

Issue #10 lands the first real tool, which is the moment ADR 0002 reserved for
revisiting the low-level `Server`. It also has to fix several things PLAN.md
§5.1 leaves open: where the tool gets its dependencies, what a failure looks
like on the wire, and which of the several names for a model the envelope
carries.

## Decision

**`McpServer`, not the low-level `Server`.** The only reason for the low-level
server was that `McpServer` cannot answer `tools/list` with an empty list, and
there is no longer an empty list to answer with. `registerTool` gives argument
validation, the JSON Schema in `tools/list` and the `structuredContent`
plumbing from one zod shape, none of which is worth reimplementing by hand on
raw request handlers. The manual `tools/list` handler is removed rather than
kept alongside, as ADR 0002 required.

**The MCP layer is handed its dependencies; it never builds them.**
`createServer(deps)` takes config, curated knowledge, the cost ledger and the
registered adapters. `src/composition.ts` is the only file that both knows what
a provider is and how the server is assembled, so PLAN.md §3's test — delete the
MCP layer, write a CLI in its place, lose nothing — still holds. The tool
handler is assembly, not routing: authorise, `route`, `writeImage`, record. Any
decision about *which* model serves the request is still made in
`core/router.ts` alone.

**A failure is a tool result with `isError: true`, never a JSON-RPC error.**
PLAN.md §5.1's failure envelope carries `retryable` and `suggestion`, which
exist so the calling model can choose what to do next; a protocol error reaches
the model as a string at best and as a client-side exception at worst. Every
`ImagineError` — including the budget refusal and the "no provider is
configured" case — is rendered as that envelope. The one exception is argument
validation, which the SDK answers before the handler runs.

**`suggestion` is a fixed sentence per `FailureReason`.** The reasons are a
closed union (ADR 0003) and the advice per reason is genuinely static; deriving
it from the message would mean parsing prose the adapters write.

**Startup does not fail over a missing key.** A provider without credentials is
constructed anyway and reports itself unconfigured, so the server starts and
answers with a failure envelope naming what is missing. A server that refuses to
start cannot tell the user why: the client shows a dead connection.

**The envelope's `model` is the provider's own model reference, not the curated
id.** PLAN.md §5.1's example shows `google/gemini-3.1-flash-image` — an
OpenRouter reference — and the manifest (ADR 0006) already records the
provider-reported model. On success the value is what the adapter says it
generated with, which is also what makes an adapter ignoring the router's choice
visible (ADR 0007). On a failure, where there is no result, it is the
`model_ref` the router was about to use. The curated id stays in
`selection_reason`, which is where the reasoning belongs.

**`budget` in the success envelope carries only the session figures.** That is
what §5.1 shows. The full snapshot, day included, is `list_capabilities`'
business (§5.2). Under `on_exceed: "warn"` an extra `budget_warning` string
carries the ledger's message, which is the "flags it in the response" PLAN.md §7
asks for.

## Consequences

`createServer` now requires an argument, so every caller is a composition root
or a test that builds one. `src/index.ts` is four lines: build, connect.

The tool declares an `outputSchema`, so a success must carry
`structuredContent`; the SDK skips that check when `isError` is set, which is
exactly what the failure envelope needs. Adding `list_capabilities` and
`recommend_model` (issues #11, #12) means one more `registerTool` call each and
a wider `ServerDependencies` — no change to this wiring.

`generate_image` is the only tool for now, so `tools/list` is no longer empty
and the regression ADR 0002 guarded against cannot recur. If a build ever
removes every tool, `tools/list` breaks again — a test asserting the tool is
listed is what catches that.
