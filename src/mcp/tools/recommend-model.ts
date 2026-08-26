/**
 * The `recommend_model` tool: advice before spending money.
 *
 * Read-only by construction — it calls no provider, writes nothing and touches
 * the ledger not at all. Everything it says comes from the curated knowledge
 * (`data/models.json`) and from the same selection logic `generate_image` would
 * use, via `planCandidates`, so the advice and the routing cannot drift apart.
 *
 * The two behaviours that matter more than the shape (PLAN.md §4.4, issue #12):
 * when the best model for a use case is not configured, the response says so and
 * names what would unlock it; and when the hinted volume makes the price gap
 * dominate the quality gap, the recommendation is the cheap model. A recommender
 * that always names the most expensive model is not trusted twice.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "../../core/config-schema.js";
import { isImagineError } from "../../core/errors.js";
import {
  modelsAvailableVia,
  rankModelsForUseCase,
  type CuratedModel,
  type ModelKnowledge,
  type ModelSelection,
} from "../../core/knowledge.js";
import { planCandidates, usableProviders } from "../../core/router.js";
import { USE_CASES, type UseCase } from "../../core/types.js";
import type { ImageProvider } from "../../providers/types.js";

export const RECOMMEND_MODEL_TOOL_NAME = "recommend_model";

/** Everything the tool needs from the composition root, and nothing more. */
export interface RecommendModelDependencies {
  config: Config;
  knowledge: ModelKnowledge;
  /** Registered adapters, in the order they should be preferred. */
  providers: readonly ImageProvider[];
}

const recommendModelInput = z.object({
  use_case: z
    .enum(USE_CASES)
    .optional()
    .describe("What the images are for. Omit for a general answer."),
  budget_hint: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Free text, e.g. "20 images for a deck", "one hero image, quality matters", ' +
        '"under $1 total". A count and a dollar cap are parsed out of it where present, ' +
        "and the assumption made is stated back in estimate.assumption.",
    ),
});

export const recommendModelInputSchema = recommendModelInput.shape;

export type RecommendModelArgs = z.infer<typeof recommendModelInput>;

/** The strongest curated model for the use case, configured or not. */
export interface BestOverall {
  model: string;
  display_name: string;
  available_to_you: boolean;
  via: string[];
  price_per_image_usd: number;
  why: string;
}

/** The strongest model this installation can actually reach. */
export interface BestConfigured {
  model: string;
  display_name: string;
  via: string;
  price_per_image_usd: number;
  why: string;
}

export interface CheaperAlternative {
  model: string;
  display_name: string;
  via: string;
  price_per_image_usd: number;
  trade_off: string;
}

export interface RecommendEstimate {
  assumed_count: number;
  assumed_budget_usd: number | null;
  /** The assumption in words, so a wrong parse is visible rather than silent. */
  assumption: string;
  /** `best_configured` for `assumed_count` images. */
  recommended_total_usd: number | null;
  /** `cheaper_alternative` for `assumed_count` images. */
  cheaper_total_usd: number | null;
}

/** The response of PLAN.md §5.3. */
export interface RecommendModelResponse {
  use_case: UseCase | null;
  best_overall: BestOverall;
  best_configured: BestConfigured | null;
  cheaper_alternative: CheaperAlternative | null;
  estimate: RecommendEstimate;
  /**
   * Which of the two the recommendation lands on, so a client does not have to
   * read the prose to find out. Null when nothing is configured.
   */
  recommended_model: string | null;
  recommendation: string;
  note_on_unconfigured: string[];
  knowledge_updated: string;
  disclaimer: string;
}

export const recommendModelOutputSchema = {
  use_case: z.string().nullable(),
  best_overall: z.object({
    model: z.string(),
    display_name: z.string(),
    available_to_you: z.boolean(),
    via: z.array(z.string()),
    price_per_image_usd: z.number(),
    why: z.string(),
  }),
  best_configured: z
    .object({
      model: z.string(),
      display_name: z.string(),
      via: z.string(),
      price_per_image_usd: z.number(),
      why: z.string(),
    })
    .nullable()
    .describe("Null when no configured provider can reach any curated model."),
  cheaper_alternative: z
    .object({
      model: z.string(),
      display_name: z.string(),
      via: z.string(),
      price_per_image_usd: z.number(),
      trade_off: z.string(),
    })
    .nullable()
    .describe("Null when the recommended model is already the cheapest one available."),
  estimate: z.object({
    assumed_count: z.number(),
    assumed_budget_usd: z.number().nullable(),
    assumption: z.string(),
    recommended_total_usd: z
      .number()
      .nullable()
      .describe("best_configured for assumed_count images."),
    cheaper_total_usd: z
      .number()
      .nullable()
      .describe("cheaper_alternative for assumed_count images."),
  }),
  recommended_model: z
    .string()
    .nullable()
    .describe("Which model the recommendation lands on: one of the two above."),
  recommendation: z.string(),
  note_on_unconfigured: z.array(z.string()),
  knowledge_updated: z.string(),
  disclaimer: z
    .string()
    .describe("How much weight the curated scores and prices can carry."),
};

/** A model this installation can reach, with the router's reasoning for it. */
interface ConfiguredChoice {
  model: CuratedModel;
  via: string;
  reason: string;
}

/**
 * Volume at which a small quality gap stops being worth paying for repeatedly.
 * Three is deliberately low: the second and third image are already a batch.
 */
const VOLUME_COUNT = 3;

/** Price ratio at which "cheaper" is a real argument rather than rounding. */
const MEANINGFUL_RATIO = 1.5;

/** Score gap, out of five, a cheaper model may close before quality decides. */
const TOLERABLE_GAP = 1;

export function recommendModel(
  deps: RecommendModelDependencies,
  args: RecommendModelArgs,
): RecommendModelResponse {
  const { config, knowledge } = deps;
  const useCase = args.use_case ?? config.default.use_case ?? undefined;

  const parsedCount = parseCount(args.budget_hint);
  const count = parsedCount ?? 1;
  const cap = parseBudgetCap(args.budget_hint);

  const overall = rank(knowledge, useCase)[0] as ModelSelection;
  const configured = configuredChoices(deps, useCase);
  const reachable = new Set(configured.map((choice) => choice.model.id));

  const best = configured[0];
  const cheaper = best === undefined ? undefined : cheapestBelow(configured, best);

  const bestTotal = best === undefined ? null : total(best.model, count);
  const cheaperTotal = cheaper === undefined ? null : total(cheaper.model, count);

  const preferCheaper =
    best !== undefined &&
    cheaper !== undefined &&
    bestTotal !== null &&
    cheaperTotal !== null &&
    prefersCheaper({ best, cheaper, useCase, count, cap, bestTotal, cheaperTotal });

  return {
    use_case: useCase ?? null,
    best_overall: {
      model: overall.model.id,
      display_name: overall.model.display_name,
      available_to_you: reachable.has(overall.model.id),
      via: overall.model.availability.map((entry) => entry.provider),
      price_per_image_usd: overall.model.price.per_image_usd,
      why: whyBest(overall.model, useCase),
    },
    best_configured:
      best === undefined
        ? null
        : {
            model: best.model.id,
            display_name: best.model.display_name,
            via: best.via,
            price_per_image_usd: best.model.price.per_image_usd,
            why: `${best.reason}. ${firstSentence(best.model.notes)}`,
          },
    cheaper_alternative:
      best === undefined || cheaper === undefined
        ? null
        : {
            model: cheaper.model.id,
            display_name: cheaper.model.display_name,
            via: cheaper.via,
            price_per_image_usd: cheaper.model.price.per_image_usd,
            trade_off: tradeOff(best.model, cheaper.model, useCase),
          },
    estimate: {
      assumed_count: count,
      assumed_budget_usd: cap,
      assumption: assumption(args.budget_hint, parsedCount, cap, count),
      recommended_total_usd: bestTotal,
      cheaper_total_usd: cheaperTotal,
    },
    recommended_model: preferCheaper
      ? (cheaper?.model.id ?? null)
      : (best?.model.id ?? null),
    recommendation: recommendation({
      useCase,
      count,
      cap,
      best,
      cheaper,
      bestTotal,
      cheaperTotal,
      preferCheaper,
      overall,
    }),
    note_on_unconfigured: unconfiguredNotes(deps, useCase, overall.model, reachable),
    knowledge_updated: knowledge.updated,
    disclaimer: knowledge.disclaimer,
  };
}

/**
 * Curated models best first. With a use case that is the knowledge module's own
 * ranking; without one it is overall strength, cheapest among equals — the same
 * order the router falls back to when nothing narrows the choice.
 */
function rank(
  knowledge: ModelKnowledge,
  useCase: UseCase | undefined,
): ModelSelection[] {
  if (useCase !== undefined) return rankModelsForUseCase(knowledge, useCase);

  return modelsAvailableVia(knowledge).sort((a, b) => {
    const byScore = score(b.model, undefined) - score(a.model, undefined);
    if (byScore !== 0) return byScore;
    const byPrice = a.model.price.per_image_usd - b.model.price.per_image_usd;
    if (byPrice !== 0) return byPrice;
    return a.model.id.localeCompare(b.model.id);
  });
}

/**
 * What this installation can reach, best first, as the router would order it.
 * An installation with nothing configured is not an error here: advice about
 * models you cannot reach yet is exactly what such a caller needs.
 */
function configuredChoices(
  deps: RecommendModelDependencies,
  useCase: UseCase | undefined,
): ConfiguredChoice[] {
  let candidates;
  try {
    candidates = planCandidates({
      request: { prompt: "", ...(useCase === undefined ? {} : { use_case: useCase }) },
      config: deps.config,
      knowledge: deps.knowledge,
      providers: deps.providers,
    }).candidates;
  } catch (cause) {
    if (isImagineError(cause)) return [];
    throw cause;
  }

  const choices: ConfiguredChoice[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.model)) continue;
    const model = deps.knowledge.models.find((entry) => entry.id === candidate.model);
    if (model === undefined) continue;
    seen.add(candidate.model);
    choices.push({ model, via: candidate.provider, reason: candidate.reason });
  }
  return choices;
}

function cheapestBelow(
  choices: readonly ConfiguredChoice[],
  best: ConfiguredChoice,
): ConfiguredChoice | undefined {
  return choices
    .filter(
      (choice) =>
        choice.model.id !== best.model.id &&
        choice.model.price.per_image_usd < best.model.price.per_image_usd,
    )
    .sort(
      (a, b) =>
        a.model.price.per_image_usd - b.model.price.per_image_usd ||
        a.model.id.localeCompare(b.model.id),
    )[0];
}

/**
 * A cheaper model wins when it costs nothing in quality, when a small quality
 * gap is repeated across a whole batch at a real discount, or when the stated
 * budget simply does not stretch to the better one. A gap of two points or more
 * is a different model rather than a discount, and no volume argument buys it
 * back; for a single image the few cents saved never do either.
 */
function prefersCheaper(options: {
  best: ConfiguredChoice;
  cheaper: ConfiguredChoice;
  useCase: UseCase | undefined;
  count: number;
  cap: number | null;
  bestTotal: number;
  cheaperTotal: number;
}): boolean {
  const { best, cheaper, useCase, count, cap, bestTotal, cheaperTotal } = options;
  const gap = score(best.model, useCase) - score(cheaper.model, useCase);
  const ratio = best.model.price.per_image_usd / cheaper.model.price.per_image_usd;

  if (cap !== null && bestTotal > cap && cheaperTotal <= cap) return true;
  if (gap > TOLERABLE_GAP) return false;
  if (gap <= 0) return true;
  return count >= VOLUME_COUNT && ratio >= MEANINGFUL_RATIO;
}

/** 1–5. Without a use case, the average across all of them. */
function score(model: CuratedModel, useCase: UseCase | undefined): number {
  if (useCase !== undefined) return model.strengths[useCase];
  const sum = USE_CASES.reduce((running, tag) => running + model.strengths[tag], 0);
  return sum / USE_CASES.length;
}

function total(model: CuratedModel, count: number): number {
  return round(model.price.per_image_usd * count);
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function whyBest(model: CuratedModel, useCase: UseCase | undefined): string {
  const strength =
    useCase === undefined
      ? `Highest average score across all use cases (${formatScore(score(model, undefined))}/5).`
      : `Scores ${model.strengths[useCase]}/5 for ${useCase}, the highest of the curated models.`;
  return `${strength} ${firstSentence(model.notes)}`;
}

function tradeOff(
  best: CuratedModel,
  cheaper: CuratedModel,
  useCase: UseCase | undefined,
): string {
  const ratio = best.price.per_image_usd / cheaper.price.per_image_usd;
  const label = useCase ?? "overall strength";
  const parts = [
    `Roughly ${formatRatio(ratio)}x cheaper at ${usd(cheaper.price.per_image_usd)} an image.`,
    `Scores ${formatScore(score(cheaper, useCase))}/5 for ${label} where ${best.display_name} scores ${formatScore(score(best, useCase))}/5.`,
  ];
  const caveat = warning(cheaper.notes);
  if (caveat !== undefined) parts.push(caveat);
  return parts.join(" ");
}

function recommendation(options: {
  useCase: UseCase | undefined;
  count: number;
  cap: number | null;
  best: ConfiguredChoice | undefined;
  cheaper: ConfiguredChoice | undefined;
  bestTotal: number | null;
  cheaperTotal: number | null;
  preferCheaper: boolean;
  overall: ModelSelection;
}): string {
  const { useCase, count, cap, best, cheaper, bestTotal, cheaperTotal } = options;
  const images = `${count} ${count === 1 ? "image" : "images"}`;
  const purpose = useCase === undefined ? "general use" : `use_case=${useCase}`;

  if (best === undefined || bestTotal === null) {
    return (
      `Nothing to recommend yet: no configured provider reaches any curated model. ` +
      `For ${purpose} the strongest curated model is ${options.overall.model.display_name} ` +
      `(${options.overall.model.id}) at ${usd(options.overall.model.price.per_image_usd)} an image; ` +
      `note_on_unconfigured says what reaching it takes.`
    );
  }

  if (cheaper === undefined || cheaperTotal === null) {
    return (
      `For ${purpose}, use ${best.model.display_name} (${best.model.id}) via ${best.via} — ` +
      `${usd(best.model.price.per_image_usd)} an image, about ${usd(bestTotal)} for ${images}. ` +
      `It is also the cheapest model you can reach, so there is no cost argument against it.`
    );
  }

  const saving = usd(round(bestTotal - cheaperTotal));

  if (options.preferCheaper) {
    const reason =
      cap !== null && bestTotal > cap
        ? `A ${usd(cap)} budget does not cover ${images} with ${best.model.display_name} (${usd(bestTotal)})`
        : `For ${images} the price gap outweighs the quality gap`;
    return (
      `${reason}: use ${cheaper.model.display_name} (${cheaper.model.id}) via ${cheaper.via} — ` +
      `about ${usd(cheaperTotal)} instead of ${usd(bestTotal)}, a saving of ${saving}. ` +
      `${best.model.display_name} scores ${formatScore(score(best.model, useCase))}/5 for ` +
      `${useCase ?? "overall strength"} against ${formatScore(score(cheaper.model, useCase))}/5, ` +
      `so switch back if that difference is what the batch is about.`
    );
  }

  return (
    `For ${purpose}, use ${best.model.display_name} (${best.model.id}) via ${best.via} — ` +
    `about ${usd(bestTotal)} for ${images}. ` +
    `${cheaper.model.display_name} would cost ${usd(cheaperTotal)}, ${saving} less, but scores ` +
    `${formatScore(score(cheaper.model, useCase))}/5 for ${useCase ?? "overall strength"} against ` +
    `${formatScore(score(best.model, useCase))}/5 — worth it only if that difference does not matter here.`
  );
}

/**
 * What a caller would have to do to reach what they cannot reach today, named
 * concretely enough to act on: the environment variable, the config switch, or
 * the fact that this build has no adapter for the provider at all.
 */
function unconfiguredNotes(
  deps: RecommendModelDependencies,
  useCase: UseCase | undefined,
  overall: CuratedModel,
  reachable: ReadonlySet<string>,
): string[] {
  const { config, knowledge } = deps;
  const registered = new Set(deps.providers.map((provider) => provider.id));
  const usable = new Set(
    usableProviders(config, deps.providers).map((provider) => provider.id),
  );
  const purpose = useCase === undefined ? "general use" : useCase;

  const notes: string[] = [];
  if (!reachable.has(overall.id)) {
    notes.push(
      `The strongest curated model for ${purpose} is ${overall.display_name} ` +
        `(${overall.id}) at ${usd(overall.price.per_image_usd)} an image, and you cannot reach it.`,
    );
  }

  const unlockable = knowledge.models.reduce<Map<string, string[]>>(
    (byProvider, model) => {
      if (reachable.has(model.id)) return byProvider;
      for (const entry of model.availability) {
        if (usable.has(entry.provider) || !registered.has(entry.provider)) continue;
        byProvider.set(entry.provider, [
          ...(byProvider.get(entry.provider) ?? []),
          model.id,
        ]);
      }
      return byProvider;
    },
    new Map(),
  );

  const lines = [...unlockable.entries()].sort(
    (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
  );
  for (const [provider, models] of lines) {
    notes.push(
      `Enabling ${provider} would give you ${listOf(models)} with one credential — ${enablingSteps(config, provider)}.`,
    );
  }

  const unlocked = new Set(lines.flatMap(([, models]) => models));
  if (!reachable.has(overall.id) && !unlocked.has(overall.id)) {
    const providers = overall.availability.map((entry) => entry.provider);
    notes.push(
      `${overall.display_name} is only reachable through ${listOf(providers)}, ` +
        `and this build registers no adapter for ${listOf(providers.filter((id) => !registered.has(id)))}.`,
    );
  }

  return notes;
}

function enablingSteps(config: Config, providerId: string): string {
  const provider = config.providers[providerId];
  if (provider === undefined) {
    return `add providers.${providerId} to your config, naming the environment variable that holds its key`;
  }

  const steps: string[] = [];
  if (!provider.enabled) steps.push(`set providers.${providerId}.enabled to true`);
  if (provider.auth === "entra") {
    steps.push(`sign in with Entra credentials for providers.${providerId}.endpoint`);
  } else if (provider.api_key_env) {
    steps.push(`set ${provider.api_key_env}`);
  } else {
    steps.push(
      `set providers.${providerId}.api_key_env to the environment variable holding its key`,
    );
  }
  return steps.join(" and ");
}

/**
 * A count out of free text: a number, optionally behind a couple of adjectives,
 * in front of a word for a picture. A dollar amount is never a count — "under $1
 * total" says nothing about how many images, and guessing one from it would be
 * the silent wrong parse this is written to avoid.
 */
const COUNTED_THINGS =
  "images?|renders?|pictures?|photos?|illustrations?|icons?|thumbnails?|shots?|frames?|variations?|visuals?|graphics?|diagrams?";

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  dozen: 12,
  twenty: 20,
  fifty: 50,
  hundred: 100,
};

export function parseCount(hint: string | undefined): number | null {
  if (hint === undefined) return null;

  const words = Object.keys(NUMBER_WORDS).join("|");
  const pattern = new RegExp(
    `(?<![$\\d.])\\b(\\d{1,4}|${words})\\b\\s+(?:[A-Za-z][A-Za-z-]*\\s+){0,2}(?:${COUNTED_THINGS})\\b`,
    "i",
  );
  const match = pattern.exec(hint);
  if (match === null) return null;

  const raw = (match[1] ?? "").toLowerCase();
  const value = NUMBER_WORDS[raw] ?? Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function parseBudgetCap(hint: string | undefined): number | null {
  if (hint === undefined) return null;
  const match = /\$\s*(\d+(?:\.\d+)?)/.exec(hint);
  if (match === null) return null;
  const value = Number.parseFloat(match[1] ?? "");
  return Number.isFinite(value) && value > 0 ? value : null;
}

function assumption(
  hint: string | undefined,
  parsed: number | null,
  cap: number | null,
  count: number,
): string {
  const images = `${count} ${count === 1 ? "image" : "images"}`;
  const budget = cap === null ? "" : ` Read a ${usd(cap)} total budget from it.`;

  if (hint === undefined) {
    return `No budget_hint given, so the estimate is for ${images}.`;
  }
  if (parsed === null) {
    return `No count found in budget_hint "${hint}", so the estimate is for ${images}.${budget}`;
  }
  return `Read ${images} from budget_hint "${hint}"; the estimate is wrong if that is not what you meant.${budget}`;
}

function sentences(notes: string): string[] {
  return notes.split(/(?<=\.)\s+/).filter((sentence) => sentence.length > 0);
}

function firstSentence(notes: string): string {
  return sentences(notes)[0] ?? notes;
}

/** The curated "do not pick it when…" clause, which is the honest half. */
function warning(notes: string): string | undefined {
  return sentences(notes).find((sentence) => /^Do not pick it\b/i.test(sentence));
}

function listOf(values: readonly string[]): string {
  if (values.length <= 1) return values[0] ?? "nothing";
  return `${values.slice(0, -1).join(", ")} and ${values[values.length - 1]}`;
}

function usd(value: number): string {
  const fixed =
    value >= 0.1
      ? value.toFixed(2)
      : value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  return `$${fixed}`;
}

function formatScore(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatRatio(value: number): string {
  return value >= 10 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, "");
}

export function registerRecommendModel(
  server: McpServer,
  deps: RecommendModelDependencies,
): void {
  server.registerTool(
    RECOMMEND_MODEL_TOOL_NAME,
    {
      title: "Recommend a model",
      description:
        "Advice before spending money: the strongest model for a use case, the strongest one " +
        "you can actually reach, a cheaper alternative with its trade-off, and what a batch " +
        "would cost. Spends nothing and calls no provider.",
      inputSchema: recommendModelInputSchema,
      outputSchema: recommendModelOutputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args): CallToolResult => {
      const payload = recommendModel(deps, args);
      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        structuredContent: { ...payload },
      };
    },
  );
}
