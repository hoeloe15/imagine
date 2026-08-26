/**
 * Loading and querying the curated editorial knowledge in `data/models.json`.
 *
 * This is the only thing in the core that knows what models are *good at*.
 * `ProviderModel` (see `types.ts`) is what a provider says about itself and is
 * a different source; nothing here talks to a provider.
 *
 * The runtime validator below is the executable schema.
 * `schema/models.schema.json` describes the same shape for editors and
 * reviewers. See ADR 0005.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ImagineError } from "./errors.js";
import { USE_CASES, type UseCase } from "./types.js";

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected a date as YYYY-MM-DD");

const score = z.number().int().min(1).max(5);

const strengthsSchema = z
  .object(
    Object.fromEntries(USE_CASES.map((useCase) => [useCase, score])) as Record<
      UseCase,
      typeof score
    >,
  )
  .strict();

const leaderboardSchema = z
  .object({
    source: z.string().min(1),
    rank_band: z.enum(["top-3", "top-10", "mid", "unranked"]),
    checked: isoDate,
  })
  .strict()
  .nullable();

const priceSchema = z
  .object({
    per_image_usd: z.number().min(0),
    per_image_usd_4k: z.number().min(0).nullable().default(null),
    confidence: z.enum(["indicative", "confirmed"]),
    checked: isoDate,
  })
  .strict();

const availabilitySchema = z
  .object({
    provider: z.string().min(1),
    model_ref: z.string().min(1),
    note: z.string().min(1).optional(),
  })
  .strict();

const modelSchema = z
  .object({
    id: z.string().min(1),
    display_name: z.string().min(1),
    family: z.string().min(1),
    leaderboard: leaderboardSchema,
    strengths: strengthsSchema,
    typical_latency_s: z.number().positive(),
    price: priceSchema,
    availability: z.array(availabilitySchema).min(1),
    max_size: z.string().min(1),
    notes: z.string().min(1),
  })
  .strict()
  .superRefine((model, ctx) => {
    const providers = model.availability.map((entry) => entry.provider);
    if (new Set(providers).size !== providers.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["availability"],
        message: `model "${model.id}" lists the same provider twice`,
      });
    }
  });

const knowledgeSchema = z
  .object({
    $schema: z.string().optional(),
    schema_version: z.literal(1),
    updated: isoDate,
    disclaimer: z.string().min(1),
    models: z.array(modelSchema).min(1),
  })
  .strict()
  .superRefine((knowledge, ctx) => {
    const ids = knowledge.models.map((model) => model.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["models"],
        message: "model ids must be unique",
      });
    }
  });

export type ModelStrengths = z.infer<typeof strengthsSchema>;
export type ModelPrice = z.infer<typeof priceSchema>;
export type ModelAvailability = z.infer<typeof availabilitySchema>;
export type CuratedModel = z.infer<typeof modelSchema>;
export type ModelKnowledge = z.infer<typeof knowledgeSchema>;

/** A model together with the provider a caller would actually reach it through. */
export interface ModelSelection {
  model: CuratedModel;
  via: ModelAvailability;
}

export interface ProviderFilter {
  /**
   * Adapter ids the caller can actually use. Omit to consider every provider
   * the knowledge file knows about.
   */
  providers?: readonly string[];
}

export function parseModelKnowledge(
  value: unknown,
  source = "<in-memory model knowledge>",
): ModelKnowledge {
  const parsed = knowledgeSchema.safeParse(value);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new ImagineError(
      "invalid_request",
      `${source} is not valid model knowledge — ${detail}`,
    );
  }
  return parsed.data;
}

export function loadModelKnowledgeFrom(filePath: string): ModelKnowledge {
  const absolute = resolve(filePath);
  let raw: string;
  try {
    raw = readFileSync(absolute, "utf8");
  } catch (cause) {
    throw new ImagineError(
      "invalid_request",
      `could not read model knowledge at ${absolute}`,
      { cause },
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (cause) {
    throw new ImagineError(
      "invalid_request",
      `model knowledge at ${absolute} is not valid JSON`,
      { cause },
    );
  }

  return parseModelKnowledge(json, absolute);
}

const BUNDLED_RELATIVE_PATH = join("data", "models.json");

/**
 * The bundled file sits at `<package root>/data/models.json`, and this module
 * runs from `src/core/` in tests but from `dist/` once built — so the package
 * root is found by walking up rather than by counting `..` segments.
 */
export function bundledModelsPath(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(directory, BUNDLED_RELATIVE_PATH);
    if (existsSync(candidate)) return candidate;

    const parent = dirname(directory);
    if (parent === directory) {
      throw new ImagineError(
        "invalid_request",
        `no bundled ${BUNDLED_RELATIVE_PATH} found above ${fileURLToPath(import.meta.url)}`,
      );
    }
    directory = parent;
  }
}

let bundled: ModelKnowledge | undefined;

/** The knowledge shipped with the package. Read once per process. */
export function loadBundledModelKnowledge(): ModelKnowledge {
  bundled ??= loadModelKnowledgeFrom(bundledModelsPath());
  return bundled;
}

export function findModel(
  knowledge: ModelKnowledge,
  modelId: string,
): CuratedModel | undefined {
  return knowledge.models.find((model) => model.id === modelId);
}

/** The entry a caller restricted to `providers` would reach `model` through. */
export function availabilityFor(
  model: CuratedModel,
  filter: ProviderFilter = {},
): ModelAvailability | undefined {
  const { providers } = filter;
  if (providers === undefined) return model.availability[0];
  return model.availability.find((entry) => providers.includes(entry.provider));
}

/** Every curated model reachable through the given providers, unranked. */
export function modelsAvailableVia(
  knowledge: ModelKnowledge,
  filter: ProviderFilter = {},
): ModelSelection[] {
  return knowledge.models.flatMap((model) => {
    const via = availabilityFor(model, filter);
    return via === undefined ? [] : [{ model, via }];
  });
}

/**
 * Candidates for a use case, best first: score descending, then price
 * ascending, then id — so equal scores resolve to the cheaper model and the
 * order never depends on the order of the file.
 */
export function rankModelsForUseCase(
  knowledge: ModelKnowledge,
  useCase: UseCase,
  filter: ProviderFilter = {},
): ModelSelection[] {
  return modelsAvailableVia(knowledge, filter).sort((a, b) => {
    const byScore = b.model.strengths[useCase] - a.model.strengths[useCase];
    if (byScore !== 0) return byScore;
    const byPrice = a.model.price.per_image_usd - b.model.price.per_image_usd;
    if (byPrice !== 0) return byPrice;
    return a.model.id.localeCompare(b.model.id);
  });
}

export function bestModelForUseCase(
  knowledge: ModelKnowledge,
  useCase: UseCase,
  filter: ProviderFilter = {},
): ModelSelection | undefined {
  return rankModelsForUseCase(knowledge, useCase, filter)[0];
}

export function priceForModel(
  knowledge: ModelKnowledge,
  modelId: string,
): ModelPrice | undefined {
  return findModel(knowledge, modelId)?.price;
}

/**
 * Indicative spend for `count` images, for the "20 images would cost you $X"
 * half of a recommendation. `undefined` when the model is not curated; the
 * caller must not silently treat an unknown model as free.
 */
export function estimateCostUsd(
  knowledge: ModelKnowledge,
  modelId: string,
  count: number,
): number | undefined {
  const price = priceForModel(knowledge, modelId);
  return price === undefined ? undefined : price.per_image_usd * count;
}
