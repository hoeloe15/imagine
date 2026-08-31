/**
 * The SDK converts zod shapes with zod-to-json-schema's default target and
 * exposes no way to pick the dialect, so every tool schema it serialises carries
 * `"$schema": "http://json-schema.org/draft-07/schema#"`. Clients that validate
 * `structuredContent` with a 2020-12-only validator reject such a tool outright.
 *
 * Declaring no dialect leaves the client validating in its own, which is correct
 * here because the generated bodies use no keyword whose meaning differs between
 * the two drafts. See ADR 0019.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ListToolsRequestSchema,
  type ListToolsResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

type RequestHandler = (request: never, extra: never) => unknown;

interface HandlerRegistry {
  setRequestHandler(requestSchema: unknown, handler: RequestHandler): void;
}

/**
 * Must be called before the tools are registered: the SDK installs its
 * `tools/list` handler when the first tool is registered, and this wraps that
 * handler as it goes in.
 */
export function undeclareJsonSchemaDialect(server: McpServer): void {
  const registry = server.server as unknown as HandlerRegistry;
  const install = registry.setRequestHandler.bind(registry);

  registry.setRequestHandler = (requestSchema, handler) => {
    if (requestSchema !== ListToolsRequestSchema) {
      install(requestSchema, handler);
      return;
    }
    install(requestSchema, async (request, extra) => {
      const result = (await handler(request, extra)) as ListToolsResult;
      return { ...result, tools: result.tools.map(withoutDialect) };
    });
  };
}

function withoutDialect(tool: Tool): Tool {
  return {
    ...tool,
    inputSchema: withoutSchemaKeyword(tool.inputSchema),
    ...(tool.outputSchema === undefined
      ? {}
      : { outputSchema: withoutSchemaKeyword(tool.outputSchema) }),
  };
}

function withoutSchemaKeyword<T extends object>(schema: T): T {
  const stripped = { ...schema } as Record<string, unknown>;
  delete stripped.$schema;
  return stripped as T;
}
