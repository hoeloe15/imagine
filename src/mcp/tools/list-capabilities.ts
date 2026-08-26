/**
 * The `list_capabilities` tool: what this installation can actually do right
 * now, as PLAN.md §5.2 defines it.
 *
 * Everything here is read from what the process already holds — config, the
 * curated knowledge, the ledger — plus one optional round trip per configured
 * provider for live model discovery. Nothing is generated and nothing is
 * written, so the tool is `readOnlyHint`.
 *
 * A key value never appears in the result. The only credential-shaped thing
 * that crosses the wire is the *name* of an environment variable that is not
 * set, which is what makes the answer actionable. See ADR 0011.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { BudgetSnapshot, CostLedger } from "../../core/budget.js";
import type { Config, ProviderConfig } from "../../core/config-schema.js";
import type { Env } from "../../core/config.js";
import { isImagineError, type FailureReason } from "../../core/errors.js";
import { availabilityFor, type ModelKnowledge } from "../../core/knowledge.js";
import { planCandidates } from "../../core/router.js";
import { USE_CASES } from "../../core/types.js";
import type { ImageProvider } from "../../providers/types.js";

export const LIST_CAPABILITIES_TOOL_NAME = "list_capabilities";

/** Everything the tool needs from the composition root, and nothing more. */
export interface ListCapabilitiesDependencies {
  config: Config;
  knowledge: ModelKnowledge;
  ledger: CostLedger;
  providers: readonly ImageProvider[];
  /**
   * The environment the config's `api_key_env` names are read from — the `.env`
   * files the config loader found, overlaid with the ambient environment.
   * Defaults to `process.env`, which is what a server built without the loader
   * would see anyway.
   */
  env?: Env;
}

/** `ready` means a request would reach this provider, not that it will succeed. */
export type ProviderStatus = "ready" | "not_configured" | "error";

export interface ProviderCapability {
  id: string;
  status: ProviderStatus;
  /** Model references this provider can serve, as the provider names them. */
  models: string[];
  /** Whether `models` came from the provider itself or from `data/models.json`. */
  models_source: "live" | "curated";
  /** Names of environment variables that are not set. Never values. */
  missing?: string[];
  /** Why the provider is not usable, when the status alone does not say it. */
  note?: string;
  /** Present only for `error`: what went wrong reaching the provider. */
  error?: string;
}

export interface CuratedModelSummary {
  id: string;
  display_name: string;
  /** Whether a request could reach this model through a ready provider now. */
  available: boolean;
  /** The provider it would be reached through, or `null` when unreachable. */
  provider: string | null;
  model_ref: string | null;
  per_image_usd: number;
  max_size: string;
}

/** The response envelope of PLAN.md §5.2. */
export interface ListCapabilitiesSuccess {
  configured_providers: ProviderCapability[];
  default_model: string | null;
  use_cases: string[];
  models: CuratedModelSummary[];
  budget: BudgetSnapshot & { on_exceed: Config["budget"]["on_exceed"] };
  knowledge_updated: string;
  disclaimer: string;
}

export interface ListCapabilitiesFailure {
  error: FailureReason;
  message: string;
  retryable: boolean;
  suggestion: string;
}

const providerCapabilitySchema = z.object({
  id: z.string(),
  status: z.enum(["ready", "not_configured", "error"]),
  models: z.array(z.string()),
  models_source: z.enum(["live", "curated"]),
  missing: z.array(z.string()).optional(),
  note: z.string().optional(),
  error: z.string().optional(),
});

const curatedModelSchema = z.object({
  id: z.string(),
  display_name: z.string(),
  available: z.boolean(),
  provider: z.string().nullable(),
  model_ref: z.string().nullable(),
  per_image_usd: z.number(),
  max_size: z.string(),
});

export const listCapabilitiesOutputSchema = {
  configured_providers: z
    .array(providerCapabilitySchema)
    .describe(
      "Every provider this installation knows about, ready or not, with the environment variables a not_configured one is waiting for.",
    ),
  default_model: z
    .string()
    .nullable()
    .describe(
      "The curated model generate_image would pick with no arguments. Null when nothing is reachable.",
    ),
  use_cases: z.array(z.string()).describe("Use-case tags generate_image accepts."),
  models: z
    .array(curatedModelSchema)
    .describe("The curated catalogue, each entry marked reachable or not right now."),
  budget: z
    .object({
      session_spent_usd: z.number(),
      session_limit_usd: z.number().nullable(),
      day_spent_usd: z.number(),
      day_limit_usd: z.number().nullable(),
      day: z.string(),
      day_resets_at: z.string(),
      on_exceed: z.enum(["refuse", "warn"]),
    })
    .describe("Spend so far and the limits it is measured against."),
  knowledge_updated: z
    .string()
    .describe("The date data/models.json was last curated, so staleness is visible."),
  disclaimer: z.string().describe("How much the curated scores and prices are worth."),
};

/**
 * Live discovery, once per provider per process. The outcome is cached rather
 * than the models, so a provider that could not be reached is not asked again
 * on every call — the issue asks for a process-lifetime cache, and a failing
 * provider is the case where re-asking hurts most.
 */
interface Discovery {
  models: string[];
  error?: string;
}

const discovered = new WeakMap<ImageProvider, Promise<Discovery>>();

function discover(provider: ImageProvider): Promise<Discovery> {
  const existing = discovered.get(provider);
  if (existing !== undefined) return existing;

  const attempt = provider
    .listModels()
    .then((models) => ({ models: models.map((model) => model.id) }))
    .catch((cause: unknown) => ({ models: [], error: describe(cause) }));

  discovered.set(provider, attempt);
  return attempt;
}

function describe(cause: unknown): string {
  if (isImagineError(cause)) return cause.message;
  return cause instanceof Error ? cause.message : String(cause);
}

/** Model references `data/models.json` says this provider can serve. */
function curatedRefsFor(knowledge: ModelKnowledge, providerId: string): string[] {
  return knowledge.models.flatMap((model) => {
    const entry = model.availability.find((option) => option.provider === providerId);
    return entry === undefined ? [] : [entry.model_ref];
  });
}

interface Credentials {
  ready: boolean;
  missing: string[];
  note?: string;
}

/**
 * Whether a provider's credentials are present, without ever reading a value.
 * Entra authenticates from the ambient identity, so there is no variable to
 * check and nothing to report missing.
 */
function credentials(provider: ProviderConfig | undefined, env: Env): Credentials {
  if (provider === undefined) return { ready: true, missing: [] };

  if (!provider.enabled) {
    return {
      ready: false,
      missing: [],
      note: "Disabled in configuration.",
    };
  }

  if (provider.auth === "entra") return { ready: true, missing: [] };

  const variable = provider.api_key_env;
  if (variable === null) {
    return {
      ready: false,
      missing: [],
      note: "No api_key_env is configured, so there is no environment variable to read a key from.",
    };
  }

  if (!env[variable]) return { ready: false, missing: [variable] };
  return { ready: true, missing: [] };
}

function providerIds(deps: ListCapabilitiesDependencies): string[] {
  const fromConfig = Object.keys(deps.config.providers);
  const extra = deps.providers
    .map((provider) => provider.id)
    .filter((id) => !fromConfig.includes(id));
  return [...fromConfig, ...extra];
}

async function describeProvider(
  id: string,
  deps: ListCapabilitiesDependencies,
  env: Env,
): Promise<ProviderCapability> {
  const curated = curatedRefsFor(deps.knowledge, id);
  const adapter = deps.providers.find((provider) => provider.id === id);
  const credential = credentials(deps.config.providers[id], env);

  if (!credential.ready) {
    return {
      id,
      status: "not_configured",
      models: curated,
      models_source: "curated",
      ...(credential.missing.length === 0 ? {} : { missing: credential.missing }),
      ...(credential.note === undefined ? {} : { note: credential.note }),
    };
  }

  if (adapter === undefined) {
    return {
      id,
      status: "not_configured",
      models: curated,
      models_source: "curated",
      note: "No adapter for this provider is registered in this build, so nothing can be routed to it yet.",
    };
  }

  if (!adapter.isConfigured()) {
    return {
      id,
      status: "not_configured",
      models: curated,
      models_source: "curated",
      note: "The adapter reports itself unconfigured.",
    };
  }

  const live = await discover(adapter);
  if (live.error !== undefined) {
    return {
      id,
      status: "error",
      models: curated,
      models_source: "curated",
      error: live.error,
    };
  }

  return {
    id,
    status: "ready",
    models: merge(curated, live.models),
    models_source: "live",
  };
}

/**
 * The live list, with the curated references first — those are the ones the
 * router can actually pick. A curated reference the provider does not report is
 * left out: the provider is the authority on what it can serve today.
 */
function merge(curated: readonly string[], live: readonly string[]): string[] {
  const preferred = curated.filter((ref) => live.includes(ref));
  return [...preferred, ...live.filter((ref) => !preferred.includes(ref))];
}

function curatedModels(
  knowledge: ModelKnowledge,
  readyProviders: readonly string[],
): CuratedModelSummary[] {
  return knowledge.models.map((model) => {
    const via = availabilityFor(model, { providers: readyProviders });
    return {
      id: model.id,
      display_name: model.display_name,
      available: via !== undefined,
      provider: via?.provider ?? null,
      model_ref: via?.model_ref ?? null,
      per_image_usd: model.price.per_image_usd,
      max_size: model.max_size,
    };
  });
}

/**
 * What `generate_image` would pick with no arguments at all: the router's own
 * first candidate, so the reported default cannot drift from the real one. The
 * configured default is the answer when nothing is reachable to rank.
 */
function defaultModel(deps: ListCapabilitiesDependencies): string | null {
  try {
    const plan = planCandidates({
      request: { prompt: "" },
      config: deps.config,
      knowledge: deps.knowledge,
      providers: deps.providers,
    });
    return plan.candidates[0]?.model ?? deps.config.default.model;
  } catch {
    return deps.config.default.model;
  }
}

export async function listCapabilities(
  deps: ListCapabilitiesDependencies,
): Promise<CallToolResult> {
  try {
    const env = deps.env ?? process.env;
    const providers = await Promise.all(
      providerIds(deps).map((id) => describeProvider(id, deps, env)),
    );
    const ready = providers
      .filter((provider) => provider.status === "ready")
      .map((provider) => provider.id);

    const payload: ListCapabilitiesSuccess = {
      configured_providers: providers,
      default_model: defaultModel(deps),
      use_cases: [...USE_CASES],
      models: curatedModels(deps.knowledge, ready),
      budget: { ...deps.ledger.snapshot(), on_exceed: deps.config.budget.on_exceed },
      knowledge_updated: deps.knowledge.updated,
      disclaimer: deps.knowledge.disclaimer,
    };

    return {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      structuredContent: { ...payload },
    };
  } catch (cause) {
    const failure: ListCapabilitiesFailure = {
      error: isImagineError(cause) ? cause.reason : "unknown",
      message: describe(cause),
      retryable: isImagineError(cause) ? cause.retryable : false,
      suggestion:
        "list_capabilities reads configuration, the curated model data and the cost ledger. Fix what the message names — most likely the configuration or data/models.json — and call it again.",
    };
    return {
      content: [{ type: "text", text: JSON.stringify(failure, null, 2) }],
      isError: true,
    };
  }
}

export function registerListCapabilities(
  server: McpServer,
  deps: ListCapabilitiesDependencies,
): void {
  server.registerTool(
    LIST_CAPABILITIES_TOOL_NAME,
    {
      title: "List what this installation can do",
      description:
        "Report what is available right now: which providers are ready and which are waiting " +
        "for an environment variable, which models are reachable through them, what has been " +
        "spent against the budget, and how recently the curated model data was updated. " +
        "Read-only, costs nothing, and never returns a key.",
      inputSchema: {},
      outputSchema: listCapabilitiesOutputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () => listCapabilities(deps),
  );
}
