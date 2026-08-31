/**
 * MCP wiring, and nothing else. The server knows which tools exist; it does not
 * know what a provider is, and it never constructs one. See ADR 0010.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { version } from "../version.js";
import { undeclareJsonSchemaDialect } from "./json-schema-dialect.js";
import {
  registerGenerateImage,
  type GenerateImageDependencies,
} from "./tools/generate-image.js";
import {
  registerListCapabilities,
  type ListCapabilitiesDependencies,
} from "./tools/list-capabilities.js";
import {
  registerRecommendModel,
  type RecommendModelDependencies,
} from "./tools/recommend-model.js";

export type ServerDependencies = GenerateImageDependencies &
  ListCapabilitiesDependencies &
  RecommendModelDependencies;

export function createServer(deps: ServerDependencies): McpServer {
  const server = new McpServer(
    { name: "imagine", version },
    { capabilities: { tools: {} } },
  );

  undeclareJsonSchemaDialect(server);

  registerGenerateImage(server, deps);
  registerListCapabilities(server, deps);
  registerRecommendModel(server, deps);

  return server;
}
