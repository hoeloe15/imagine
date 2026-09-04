/**
 * The `generate_image` tool: protocol wiring and argument validation, plus the
 * assembly of the core pieces that do the actual work.
 *
 * Nothing here decides *which* model serves a request — `core/router.ts` does —
 * and nothing here names a provider. What lives here is the shape of the tool
 * as PLAN.md §5.1 defines it: the argument schema, the order the core is called
 * in, and the two response envelopes.
 *
 * A failure is a tool result, not a protocol error: the calling model has to be
 * able to read `suggestion` and act on it, which a JSON-RPC error does not let
 * it do. See ADR 0010.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { CostLedger } from "../../core/budget.js";
import type { Config } from "../../core/config-schema.js";
import { ImagineError, isImagineError, type FailureReason } from "../../core/errors.js";
import { estimateCostUsd, type ModelKnowledge } from "../../core/knowledge.js";
import { writeImage, type ObjectSink, type OutputConfig } from "../../core/output.js";
import { route, type RouteCandidate } from "../../core/router.js";
import { USE_CASES, type ImageSize, type NormalisedRequest } from "../../core/types.js";
import type { ImageProvider } from "../../providers/types.js";

export const GENERATE_IMAGE_TOOL_NAME = "generate_image";

/** Everything the tool needs from the composition root, and nothing more. */
export interface GenerateImageDependencies {
  config: Config;
  knowledge: ModelKnowledge;
  ledger: CostLedger;
  /** Registered adapters, in the order they should be preferred. */
  providers: readonly ImageProvider[];
  /** Where the bytes are stored. Absent means the local filesystem. */
  sink?: ObjectSink;
}

const IMAGE_SIZES = [
  "1024x1024",
  "1536x1024",
  "1024x1536",
  "auto",
] as const satisfies readonly ImageSize[];

const generateImageInput = z.object({
  prompt: z
    .string()
    .min(1)
    .describe("What to draw. Passed to the image model mostly untouched."),
  size: z
    .enum(IMAGE_SIZES)
    .optional()
    .describe(
      "Requested output size. Normalised per provider; the size actually produced comes back in the result.",
    ),
  style: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Free-text style nudge, e.g. "flat vector illustration" or "photorealistic".',
    ),
  use_case: z
    .enum(USE_CASES)
    .optional()
    .describe("What the image is for. Drives model selection when no hint is given."),
  provider_hint: z
    .string()
    .min(1)
    .optional()
    .describe(
      "A hint, never a contract: a provider id or a full model id. When it cannot be honoured the router selects anyway and says so in selection_reason.",
    ),
  output_dir: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Directory to write the image to. Defaults to the configured output.dir.",
    ),
});

export const generateImageInputSchema = generateImageInput.shape;

export type GenerateImageArgs = z.infer<typeof generateImageInput>;

export const generateImageOutputSchema = {
  path: z
    .string()
    .describe(
      "Where the image was written: a filesystem path with the local sink, and the blob's URL with the blob sink.",
    ),
  url: z
    .string()
    .optional()
    .describe(
      "A link to the image that needs no credentials, present only when the sink can hand one out. Render or download this; never expect image bytes in this result.",
    ),
  provider: z.string().describe("Id of the adapter that produced the image."),
  model: z
    .string()
    .describe("The model as the provider names it, as the provider reported it."),
  cost_usd: z
    .number()
    .describe(
      "What was recorded against the budget: the provider's figure, or the curated estimate when it reports none.",
    ),
  duration_ms: z.number(),
  width: z.number(),
  height: z.number(),
  selection_reason: z
    .string()
    .describe("Why this provider and model were chosen, including any fallback."),
  budget: z.object({
    session_spent_usd: z.number(),
    session_limit_usd: z.number().nullable(),
  }),
  budget_warning: z
    .string()
    .optional()
    .describe(
      "Present only when a budget was exceeded and budget.on_exceed is 'warn'.",
    ),
};

/** The success envelope of PLAN.md §5.1. */
export interface GenerateImageSuccess {
  path: string;
  url?: string;
  provider: string;
  model: string;
  cost_usd: number;
  duration_ms: number;
  width: number;
  height: number;
  selection_reason: string;
  budget: { session_spent_usd: number; session_limit_usd: number | null };
  budget_warning?: string;
}

/** The failure envelope of PLAN.md §5.1. */
export interface GenerateImageFailure {
  error: FailureReason;
  message: string;
  provider: string | null;
  model: string | null;
  cost_usd: number;
  retryable: boolean;
  suggestion: string;
}

const SUGGESTIONS: Readonly<Record<FailureReason, string>> = {
  auth_failed:
    "Check that the environment variable naming this provider's key is set and holds a valid key, or name another provider with provider_hint.",
  budget_exceeded:
    'Raise budget.max_usd_per_session or budget.max_usd_per_day in your config, set budget.on_exceed to "warn", or wait for the limit to reset.',
  content_filtered:
    "Rephrase the prompt, or name another provider with provider_hint — content policies differ between providers.",
  invalid_request:
    "Fix what the message names — a tool argument, the configuration, or the curated model data — and call generate_image again.",
  provider_unavailable:
    "The provider is unreachable right now. Retry in a moment, or name a different one with provider_hint.",
  rate_limited:
    "Wait for the rate limit to clear and retry, or name a different provider with provider_hint.",
  timeout:
    "Retry; if it keeps timing out, name a faster model with provider_hint — data/models.json lists typical latencies.",
  unknown:
    "Retry once; if it happens again, name a different provider with provider_hint.",
};

function outputConfig(config: Config): OutputConfig {
  return {
    dir: config.output.dir,
    filename: config.output.filename,
    ...(config.output.manifest === null ? {} : { manifest: config.output.manifest }),
  };
}

function normalisedRequest(args: GenerateImageArgs): NormalisedRequest {
  return {
    prompt: args.prompt,
    ...(args.size === undefined ? {} : { size: args.size }),
    ...(args.style === undefined ? {} : { style: args.style }),
    ...(args.use_case === undefined ? {} : { use_case: args.use_case }),
    ...(args.provider_hint === undefined ? {} : { provider_hint: args.provider_hint }),
    ...(args.output_dir === undefined ? {} : { output_dir: args.output_dir }),
  };
}

function asImagineError(cause: unknown): ImagineError {
  if (isImagineError(cause)) return cause;
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new ImagineError("unknown", detail, { cause });
}

function succeeded(payload: GenerateImageSuccess): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: { ...payload },
  };
}

function failed(payload: GenerateImageFailure): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    isError: true,
  };
}

/**
 * One image, from validated arguments to a response envelope: authorise the
 * spend, route, write the bytes to disk, record what it cost.
 */
export async function generateImage(
  deps: GenerateImageDependencies,
  args: GenerateImageArgs,
): Promise<CallToolResult> {
  const { config, knowledge, ledger, providers, sink } = deps;
  const request = normalisedRequest(args);

  /** The candidate the ledger last authorised: who a failure belongs to. */
  let attempted: RouteCandidate | undefined;
  let warning: string | undefined;

  const estimateFor = (candidate: RouteCandidate): number | undefined =>
    estimateCostUsd(knowledge, candidate.model, 1);

  try {
    const outcome = await route({
      request,
      config,
      knowledge,
      providers,
      budgetPrecheck: (candidate) => {
        attempted = candidate;
        const decision = ledger.authorise(estimateFor(candidate) ?? 0);
        if (decision.exceeded && decision.message !== null) warning = decision.message;
      },
    });

    const written = await writeImage(
      request,
      outcome.result,
      outputConfig(config),
      sink,
    );
    const record = await ledger.record({
      provider: outcome.result.provider,
      model: outcome.result.model,
      reported_cost_usd: outcome.result.cost_usd,
      estimated_cost_usd: estimateFor(outcome.selected) ?? null,
      prompt: request.prompt,
      image_path: written.path,
    });

    return succeeded({
      path: written.path,
      ...(written.url === undefined ? {} : { url: written.url }),
      provider: outcome.result.provider,
      model: outcome.result.model,
      cost_usd: record.cost_usd,
      duration_ms: outcome.result.duration_ms,
      width: outcome.result.width,
      height: outcome.result.height,
      selection_reason: outcome.selection_reason,
      budget: {
        session_spent_usd: ledger.spentThisSession(),
        session_limit_usd: ledger.budget.max_usd_per_session,
      },
      ...(warning === undefined ? {} : { budget_warning: warning }),
    });
  } catch (cause) {
    const failure = asImagineError(cause);
    return failed({
      error: failure.reason,
      message: failure.message,
      provider: attempted?.provider ?? null,
      model: attempted?.model_ref ?? null,
      cost_usd: await recordFailure(ledger, request, attempted, failure),
      retryable: failure.retryable,
      suggestion: SUGGESTIONS[failure.reason],
    });
  }
}

/**
 * Logs the failed attempt and answers what it cost. A ledger that cannot write
 * must not replace the failure the caller actually needs to see, so a problem
 * here is swallowed rather than thrown.
 */
async function recordFailure(
  ledger: CostLedger,
  request: NormalisedRequest,
  candidate: RouteCandidate | undefined,
  failure: ImagineError,
): Promise<number> {
  if (candidate === undefined) return 0;
  try {
    const record = await ledger.recordFailure(
      {
        provider: candidate.provider,
        model: candidate.model_ref,
        prompt: request.prompt,
      },
      failure,
    );
    return record.cost_usd;
  } catch {
    return 0;
  }
}

export function registerGenerateImage(
  server: McpServer,
  deps: GenerateImageDependencies,
): void {
  server.registerTool(
    GENERATE_IMAGE_TOOL_NAME,
    {
      title: "Generate an image",
      description:
        "Generate an image, store it and return where it went plus what it cost. " +
        "The image bytes never travel back to the client: put the returned path into your " +
        "document, or read the file yourself if you need the pixels. When the server stores " +
        "images in the cloud the result also carries url, a link anyone can open — show that.",
      inputSchema: generateImageInputSchema,
      outputSchema: generateImageOutputSchema,
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    (args) => generateImage(deps, args),
  );
}
