/**
 * Model selection and fallback: the only thing in the codebase that decides
 * *which* provider and model serve a request, and the only thing that turns a
 * failed attempt into another one.
 *
 * Selection order is the one in PLAN.md §4.1 and issue #5: `provider_hint`,
 * then `use_case`, then `default.model` from config, then the bundled default.
 * A hint is a hint — when it cannot be honoured the router selects anyway and
 * says so, in {@link RoutingOutcome.hint} and in `selection_reason`.
 *
 * Budget enforcement is not here: {@link RouteOptions.budgetPrecheck} is the
 * whole seam the ledger (issue #7) needs, wired up in issue #10.
 */

import type { Config } from "./config-schema.js";
import { ImagineError, isImagineError, type FailureReason } from "./errors.js";
import {
  availabilityFor,
  findModel,
  modelsAvailableVia,
  rankModelsForUseCase,
  type CuratedModel,
  type ModelKnowledge,
  type ModelSelection,
} from "./knowledge.js";
import {
  USE_CASES,
  type NormalisedRequest,
  type NormalisedResult,
  type UseCase,
} from "./types.js";
import type { ImageProvider } from "../providers/types.js";

/** Why a candidate was considered at all. Mirrors the selection order. */
export type SelectionSource =
  "provider_hint" | "use_case" | "config_default" | "bundled_default";

/** One (provider, model) pair the router is willing to try, with its reasoning. */
export interface RouteCandidate {
  provider: string;
  /** Curated model id, as `data/models.json` and the tool results name it. */
  model: string;
  /** Model reference in the provider's own namespace, handed to the adapter. */
  model_ref: string;
  source: SelectionSource;
  reason: string;
}

/** What became of a `provider_hint`. Absent when the caller gave none. */
export interface HintOutcome {
  requested: string;
  honoured: boolean;
  /** Why it could not be honoured. Absent when it was. */
  note?: string;
}

export interface AttemptFailure {
  reason: FailureReason;
  message: string;
  retryable: boolean;
  billed: boolean;
}

/** One call into an adapter. A retry of the same candidate is its own entry. */
export interface RouteAttempt {
  provider: string;
  model: string;
  model_ref: string;
  /** 1 for the first call against this candidate, 2 for the single retry. */
  attempt: number;
  outcome: "succeeded" | "failed";
  failure?: AttemptFailure;
}

/**
 * Consulted before each adapter call, and expected to throw an
 * {@link ImagineError} with reason `budget_exceeded` when the spend cap would
 * be breached. Deliberately the narrowest thing the router needs from the cost
 * ledger; issue #7 owns what goes behind it.
 */
export type BudgetPrecheck = (candidate: RouteCandidate) => void | Promise<void>;

export interface RouteOptions {
  request: NormalisedRequest;
  config: Config;
  knowledge: ModelKnowledge;
  /** Adapters registered in this process, in the order they should be preferred. */
  providers: readonly ImageProvider[];
  budgetPrecheck?: BudgetPrecheck;
}

export interface RoutingOutcome {
  result: NormalisedResult;
  selected: RouteCandidate;
  /** Human-readable reasoning for the tool result, per PLAN.md §5.1. */
  selection_reason: string;
  hint?: HintOutcome;
  /** Every adapter call made, in order. The fallback trail. */
  attempts: readonly RouteAttempt[];
}

export interface CandidatePlan {
  candidates: readonly RouteCandidate[];
  hint?: HintOutcome;
}

/**
 * The providers that can actually serve a request: registered adapters that
 * report themselves configured and are not switched off in config. A provider
 * the caller registered but never named in config counts as on — registering it
 * is the more deliberate act of the two.
 */
export function usableProviders(
  config: Config,
  providers: readonly ImageProvider[],
): ImageProvider[] {
  return providers.filter(
    (provider) =>
      (config.providers[provider.id]?.enabled ?? true) && provider.isConfigured(),
  );
}

/**
 * The full ordered candidate chain for a request, best first — the selection
 * decision without the side effects, so `recommend_model` and the tests can see
 * the same reasoning `route` acts on.
 */
export function planCandidates(
  options: Omit<RouteOptions, "budgetPrecheck">,
): CandidatePlan {
  const { request, config, knowledge } = options;
  const providers = usableProviders(config, options.providers);
  if (providers.length === 0) {
    throw new ImagineError(
      "invalid_request",
      `No image provider is available. ${describeUnusable(config, options.providers)}`,
    );
  }

  const providerIds = providers.map((provider) => provider.id);
  const useCase = request.use_case ?? config.default.use_case ?? undefined;
  const requested = request.provider_hint;
  const hinted =
    requested === undefined
      ? []
      : hintCandidates(requested, knowledge, providerIds, useCase);
  const hint = describeHint(requested, hinted, knowledge, providerIds);

  const chain = [
    ...hinted,
    ...useCaseCandidates(knowledge, providerIds, useCase),
    ...configDefaultCandidates(config, knowledge, providerIds),
    ...bundledDefaultCandidates(knowledge, providerIds),
  ];

  const candidates = dedupe(chain);
  if (candidates.length === 0) {
    throw new ImagineError(
      "invalid_request",
      `No curated model is reachable through the available providers (${providerIds.join(", ")}). Check data/models.json against the providers you have configured.`,
    );
  }

  return { candidates, hint };
}

/**
 * Select, call, and fall back. Transient failures get one retry against the
 * same provider; a candidate that fails twice — or a provider already tried —
 * is skipped in favour of the next provider in the chain. A failure the adapter
 * marks non-retryable ends the request: another provider will not fix a
 * malformed prompt, a filtered subject or a budget refusal, and trying one
 * anyway spends money on the caller's behalf without being asked.
 */
export async function route(options: RouteOptions): Promise<RoutingOutcome> {
  const plan = planCandidates(options);
  const byId = new Map(
    usableProviders(options.config, options.providers).map((provider) => [
      provider.id,
      provider,
    ]),
  );

  const attempts: RouteAttempt[] = [];
  const triedProviders = new Set<string>();
  let lastFailure: ImagineError | undefined;

  for (const candidate of plan.candidates) {
    if (triedProviders.has(candidate.provider)) continue;
    const provider = byId.get(candidate.provider);
    if (provider === undefined) continue;
    triedProviders.add(candidate.provider);

    const request = requestFor(options.request, options.config, candidate);
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await options.budgetPrecheck?.(candidate);
      try {
        const result = await provider.generate(request);
        attempts.push({ ...attemptKey(candidate), attempt, outcome: "succeeded" });
        return {
          result,
          selected: candidate,
          selection_reason: describeSelection(candidate, plan.hint, attempts),
          hint: plan.hint,
          attempts,
        };
      } catch (cause) {
        const failure = asImagineError(cause, candidate);
        attempts.push({
          ...attemptKey(candidate),
          attempt,
          outcome: "failed",
          failure: {
            reason: failure.reason,
            message: failure.message,
            retryable: failure.retryable,
            billed: failure.billed,
          },
        });
        if (!failure.retryable) throw failure;
        lastFailure = failure;
      }
    }
  }

  throw exhausted(attempts, lastFailure);
}

/**
 * The request as the chosen adapter receives it: size defaulted from config,
 * and `provider_hint` narrowed to the resolved model reference. `ImageProvider`
 * has no model parameter of its own, so the resolved reference travels in the
 * field the caller's hint arrived in — by the time an adapter sees a request,
 * the hint has stopped being a hint. See ADR 0007.
 */
function requestFor(
  request: NormalisedRequest,
  config: Config,
  candidate: RouteCandidate,
): NormalisedRequest {
  return {
    ...request,
    size: request.size ?? config.default.size,
    provider_hint: candidate.model_ref,
  };
}

/**
 * A hint counts as honoured only when it produced something to try. A hint that
 * names an available provider with no curated model behind it is as unhonoured
 * as one naming a provider that is switched off.
 */
function describeHint(
  requested: string | undefined,
  hinted: readonly RouteCandidate[],
  knowledge: ModelKnowledge,
  providerIds: readonly string[],
): HintOutcome | undefined {
  if (requested === undefined) return undefined;
  if (hinted.length > 0) return { requested, honoured: true };
  return {
    requested,
    honoured: false,
    note: hintNote(requested, knowledge, providerIds),
  };
}

function hintNote(
  hint: string,
  knowledge: ModelKnowledge,
  providerIds: readonly string[],
): string {
  if (providerIds.includes(hint)) {
    return `provider "${hint}" is available but no curated model is reachable through it`;
  }

  const model = matchModel(hint, knowledge);
  if (model !== undefined) {
    const via = model.availability.map((entry) => entry.provider).join(", ");
    return `model "${hint}" is only reachable through ${via}, and none of those is available (available: ${providerIds.join(", ")})`;
  }
  const isKnownProvider = knowledge.models.some((known) =>
    known.availability.some((entry) => entry.provider === hint),
  );
  if (isKnownProvider) {
    return `provider "${hint}" is not available (available: ${providerIds.join(", ")})`;
  }
  return `"${hint}" is neither an available provider (${providerIds.join(", ")}) nor a known model`;
}

function hintCandidates(
  hint: string,
  knowledge: ModelKnowledge,
  providerIds: readonly string[],
  useCase: UseCase | undefined,
): RouteCandidate[] {
  const hinted = modelHint(hint, knowledge, providerIds);
  if (hinted.length > 0) {
    return hinted.map((selection) =>
      candidate(
        selection,
        "provider_hint",
        `provider_hint="${hint}" honoured as model ${selection.model.id} via ${selection.via.provider}`,
      ),
    );
  }

  if (!providerIds.includes(hint)) return [];
  return rank(knowledge, [hint], useCase).map((selection) =>
    candidate(
      selection,
      "provider_hint",
      `provider_hint="${hint}" honoured; ${describeRanking(useCase)} available through ${hint}`,
    ),
  );
}

/**
 * The hint read as a model — a curated id or a provider's own model reference —
 * across every provider that can reach it, so a hinted model survives one of
 * its providers being down.
 */
function modelHint(
  hint: string,
  knowledge: ModelKnowledge,
  providerIds: readonly string[],
): ModelSelection[] {
  const model = matchModel(hint, knowledge);
  if (model === undefined) return [];
  return reachVia(model, providerIds);
}

function matchModel(hint: string, knowledge: ModelKnowledge): CuratedModel | undefined {
  return (
    findModel(knowledge, hint) ??
    knowledge.models.find((model) =>
      model.availability.some((entry) => entry.model_ref === hint),
    )
  );
}

function useCaseCandidates(
  knowledge: ModelKnowledge,
  providerIds: readonly string[],
  useCase: UseCase | undefined,
): RouteCandidate[] {
  if (useCase === undefined) return [];
  return rank(knowledge, providerIds, useCase).map((selection) =>
    candidate(selection, "use_case", describeRanking(useCase)),
  );
}

function configDefaultCandidates(
  config: Config,
  knowledge: ModelKnowledge,
  providerIds: readonly string[],
): RouteCandidate[] {
  const configured = config.default.model;
  if (configured === null) return [];

  return modelHint(configured, knowledge, providerIds).map((selection) =>
    candidate(
      selection,
      "config_default",
      `config default.model="${configured}", reachable through ${selection.via.provider}`,
    ),
  );
}

/**
 * With no hint, no use case and no configured default there is nothing to
 * optimise for, so the chain is ordered by overall strength — the model that is
 * least likely to be the wrong choice for an unstated purpose — and cheapest
 * first among equals.
 */
function bundledDefaultCandidates(
  knowledge: ModelKnowledge,
  providerIds: readonly string[],
): RouteCandidate[] {
  return rank(knowledge, providerIds, undefined).map((selection) =>
    candidate(
      selection,
      "bundled_default",
      `no hint, use case or configured default; ${selection.model.id} is the strongest available model across all use cases at the lowest price`,
    ),
  );
}

function rank(
  knowledge: ModelKnowledge,
  providerIds: readonly string[],
  useCase: UseCase | undefined,
): ModelSelection[] {
  const ranked =
    useCase !== undefined
      ? rankModelsForUseCase(knowledge, useCase, { providers: providerIds })
      : modelsAvailableVia(knowledge, { providers: providerIds }).sort((a, b) => {
          const byStrength = overallStrength(b.model) - overallStrength(a.model);
          if (byStrength !== 0) return byStrength;
          const byPrice = a.model.price.per_image_usd - b.model.price.per_image_usd;
          if (byPrice !== 0) return byPrice;
          return a.model.id.localeCompare(b.model.id);
        });

  return ranked.flatMap((selection) => reachVia(selection.model, providerIds));
}

/**
 * Every way to reach a model, in the caller's provider order — so the same
 * model through a second provider is tried before dropping to a weaker model,
 * and so the preference order is the one the operator configured rather than
 * the order the knowledge file happens to list.
 */
function reachVia(
  model: CuratedModel,
  providerIds: readonly string[],
): ModelSelection[] {
  return providerIds.flatMap((providerId) => {
    const via = availabilityFor(model, { providers: [providerId] });
    return via === undefined ? [] : [{ model, via }];
  });
}

function overallStrength(model: CuratedModel): number {
  return USE_CASES.reduce((total, useCase) => total + model.strengths[useCase], 0);
}

function describeRanking(useCase: UseCase | undefined): string {
  return useCase === undefined
    ? "strongest available model overall at the lowest price"
    : `use_case=${useCase}; highest-scoring available model for ${useCase} at the lowest price`;
}

function candidate(
  selection: ModelSelection,
  source: SelectionSource,
  reason: string,
): RouteCandidate {
  return {
    provider: selection.via.provider,
    model: selection.model.id,
    model_ref: selection.via.model_ref,
    source,
    reason,
  };
}

function dedupe(candidates: readonly RouteCandidate[]): RouteCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((entry) => {
    const key = `${entry.provider} ${entry.model_ref}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function describeSelection(
  selected: RouteCandidate,
  hint: HintOutcome | undefined,
  attempts: readonly RouteAttempt[],
): string {
  const parts: string[] = [];
  if (hint !== undefined && !hint.honoured) {
    parts.push(
      `provider_hint="${hint.requested}" not honoured — ${hint.note ?? "unavailable"}`,
    );
  }
  parts.push(selected.reason);

  const failed = attempts.filter((attempt) => attempt.outcome === "failed");
  if (failed.length > 0) {
    const trail = failed
      .map(
        (attempt) =>
          `${attempt.provider}/${attempt.model_ref} (${attempt.failure?.reason})`,
      )
      .join(", then ");
    parts.push(`fell back to ${selected.provider} after ${trail}`);
  }
  return parts.join("; ");
}

function attemptKey(
  candidate: RouteCandidate,
): Pick<RouteAttempt, "provider" | "model" | "model_ref"> {
  return {
    provider: candidate.provider,
    model: candidate.model,
    model_ref: candidate.model_ref,
  };
}

function asImagineError(cause: unknown, candidate: RouteCandidate): ImagineError {
  if (isImagineError(cause)) return cause;
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new ImagineError(
    "unknown",
    `Provider "${candidate.provider}" failed with an unclassified error while generating with ${candidate.model_ref}: ${detail}`,
    { cause },
  );
}

function exhausted(
  attempts: readonly RouteAttempt[],
  lastFailure: ImagineError | undefined,
): ImagineError {
  const trail = attempts
    .filter((attempt) => attempt.outcome === "failed")
    .map(
      (attempt) =>
        `${attempt.provider}/${attempt.model_ref} (${attempt.failure?.reason})`,
    )
    .join(", ");
  const billed = attempts.some((attempt) => attempt.failure?.billed === true);

  return new ImagineError(
    lastFailure?.reason ?? "provider_unavailable",
    `Every available provider failed: ${trail}. No provider is left to fall back to.`,
    { retryable: lastFailure?.retryable ?? false, billed, cause: lastFailure },
  );
}

function describeUnusable(config: Config, providers: readonly ImageProvider[]): string {
  if (providers.length === 0) {
    return "No provider adapter is registered in this process.";
  }
  const reasons = providers.map((provider) =>
    config.providers[provider.id]?.enabled === false
      ? `${provider.id} is disabled in config`
      : `${provider.id} reports itself unconfigured (missing credentials)`,
  );
  return `Registered providers: ${reasons.join("; ")}.`;
}
