# 2. Low-level MCP `Server` in the scaffold

**Status:** accepted
**Date:** 2026-08-26

## Context

The scaffold must answer `tools/list` with an empty list. The SDK's high-level
`McpServer` only installs the `tools/list` request handler as a side effect of
registering the first tool, so with no tools it answers `-32601 Method not
found` — even when `capabilities.tools` is declared.

Installing the handler manually on `McpServer` is worse than useless: the first
`registerTool` call would then throw, because `McpServer` refuses to overwrite a
handler that is already set.

## Decision

`src/mcp/server.ts` uses the low-level `Server` with an explicit `tools/list`
handler returning `{ tools: [] }`.

## Consequences

When the first real tool lands (issue #10), revisit this: either keep the
low-level `Server` and register tool handlers explicitly, or switch to
`McpServer` — at which point the manual handler must be removed, not kept
alongside.
