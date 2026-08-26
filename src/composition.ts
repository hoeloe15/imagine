/**
 * The composition root: the one place that knows both what a provider adapter
 * is and how the server is assembled. Everything under `src/mcp/` is handed its
 * dependencies from here, which is what keeps the MCP layer free of provider
 * knowledge (PLAN.md §3).
 *
 * Startup never fails over a missing key. A provider without credentials simply
 * reports itself unconfigured, the server starts, and `generate_image` answers
 * with a failure envelope saying what is missing — a client that cannot start
 * the server cannot show the user why.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { openCostLedger, type CostLedger } from "./core/budget.js";
import { loadConfig, resolveApiKey, type LoadConfigOptions } from "./core/config.js";
import { loadBundledModelKnowledge } from "./core/knowledge.js";
import { OPENROUTER_ID, OpenRouterProvider } from "./providers/openrouter.js";
import type { ImageProvider } from "./providers/types.js";
import { createServer, type ServerDependencies } from "./mcp/server.js";

export interface BuildOptions extends LoadConfigOptions {
  /** Replaces the adapters this function would otherwise construct. */
  providers?: readonly ImageProvider[];
  /** Replaces the ledger this function would otherwise open. */
  ledger?: CostLedger;
}

export async function buildDependencies(
  options: BuildOptions = {},
): Promise<ServerDependencies> {
  const { providers, ledger, ...configOptions } = options;
  const loaded = loadConfig(configOptions);
  const { config } = loaded;

  return {
    config,
    env: loaded.env,
    knowledge: loadBundledModelKnowledge(),
    ledger:
      ledger ??
      (await openCostLedger({
        budget: config.budget,
        costLog: config.logging.cost_log,
      })),
    providers: providers ?? [
      new OpenRouterProvider({ apiKey: keyOrNull(loaded, OPENROUTER_ID) }),
    ],
  };
}

export async function createImagineServer(
  options: BuildOptions = {},
): Promise<McpServer> {
  return createServer(await buildDependencies(options));
}

function keyOrNull(
  loaded: ReturnType<typeof loadConfig>,
  providerId: string,
): string | null {
  try {
    return resolveApiKey(loaded, providerId);
  } catch {
    return null;
  }
}
