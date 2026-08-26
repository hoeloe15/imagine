/**
 * MCP wiring, and nothing else. The server knows which tools exist; it does not
 * know what a provider is, and it never constructs one. See ADR 0010.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { version } from "../version.js";
import {
  registerGenerateImage,
  type GenerateImageDependencies,
} from "./tools/generate-image.js";

export type ServerDependencies = GenerateImageDependencies;

export function createServer(deps: ServerDependencies): McpServer {
  const server = new McpServer(
    { name: "imagine", version },
    { capabilities: { tools: {} } },
  );

  registerGenerateImage(server, deps);

  return server;
}
