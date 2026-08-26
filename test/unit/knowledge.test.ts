import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isImagineError } from "../../src/core/errors.js";
import {
  availabilityFor,
  bestModelForUseCase,
  bundledModelsPath,
  estimateCostUsd,
  findModel,
  loadBundledModelKnowledge,
  loadModelKnowledgeFrom,
  modelsAvailableVia,
  parseModelKnowledge,
  priceForModel,
  rankModelsForUseCase,
  type ModelKnowledge,
} from "../../src/core/knowledge.js";
import { USE_CASES } from "../../src/core/types.js";

const knowledge = loadBundledModelKnowledge();

function writeTempJson(contents: string): string {
  const directory = mkdtempSync(join(tmpdir(), "imagine-knowledge-"));
  const path = join(directory, "models.json");
  writeFileSync(path, contents, "utf8");
  return path;
}

function expectRejection(load: () => unknown, fragment: string): void {
  try {
    load();
    expect.unreachable("expected the loader to throw");
  } catch (error) {
    expect(isImagineError(error)).toBe(true);
    expect((error as Error).message).toContain(fragment);
  }
}

function rescored(diagram: number): ModelKnowledge {
  return parseModelKnowledge({
    schema_version: knowledge.schema_version,
    updated: knowledge.updated,
    disclaimer: knowledge.disclaimer,
    models: knowledge.models.map((model) => ({
      ...model,
      strengths: { ...model.strengths, diagram },
    })),
  });
}

describe("bundled data/models.json", () => {
  it("validates and carries the disclaimer and a date", () => {
    expect(knowledge.schema_version).toBe(1);
    expect(knowledge.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(knowledge.disclaimer).toMatch(/indicative/i);
  });

  it("contains the four v1 models", () => {
    expect(knowledge.models.map((model) => model.id)).toEqual([
      "gpt-image-2",
      "gemini-3.1-flash-image",
      "grok-imagine-image-2.0",
      "flux-2-pro",
    ]);
  });

  it("scores every model on every use case and dates every price", () => {
    for (const model of knowledge.models) {
      expect(Object.keys(model.strengths).sort()).toEqual([...USE_CASES].sort());
      expect(model.price.confidence).toBe("indicative");
      expect(model.price.checked).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(model.price.per_image_usd).toBeGreaterThan(0);
      expect(model.notes.length).toBeGreaterThan(40);
    }
  });

  it("agrees with the research doc on which model wins which use case", () => {
    expect(bestModelForUseCase(knowledge, "text_in_image")?.model.id).toBe(
      "gpt-image-2",
    );
    expect(bestModelForUseCase(knowledge, "photoreal")?.model.id).toBe("flux-2-pro");
    expect(bestModelForUseCase(knowledge, "illustration")?.model.id).toBe(
      "gemini-3.1-flash-image",
    );
    expect(bestModelForUseCase(knowledge, "fast_bulk")?.model.id).toBe(
      "grok-imagine-image-2.0",
    );
  });

  it("is reachable through OpenRouter for every model, per the MVP plan", () => {
    for (const model of knowledge.models) {
      expect(availabilityFor(model, { providers: ["openrouter"] })).toBeDefined();
    }
  });

  it("matches the shape schema/models.schema.json documents", () => {
    const schema = JSON.parse(
      readFileSync(
        join(bundledModelsPath(), "..", "..", "schema", "models.schema.json"),
        "utf8",
      ),
    ) as {
      $defs: { strengths: { required: string[] } };
      properties: { schema_version: { const: number } };
    };

    expect(schema.$defs.strengths.required.sort()).toEqual([...USE_CASES].sort());
    expect(schema.properties.schema_version.const).toBe(knowledge.schema_version);
  });
});

describe("loadModelKnowledgeFrom", () => {
  it("reads and validates a file from disk", () => {
    expect(loadModelKnowledgeFrom(bundledModelsPath()).models).toHaveLength(4);
  });

  it("rejects a missing file", () => {
    expectRejection(
      () => loadModelKnowledgeFrom(join(tmpdir(), "imagine-absent.json")),
      "could not read model knowledge",
    );
  });

  it("rejects malformed JSON", () => {
    expectRejection(
      () => loadModelKnowledgeFrom(writeTempJson("{ nope")),
      "is not valid JSON",
    );
  });
});

describe("parseModelKnowledge", () => {
  it("rejects an out-of-range score", () => {
    const broken = structuredClone(knowledge);
    broken.models[0]!.strengths.diagram = 9;

    expectRejection(() => parseModelKnowledge(broken), "strengths.diagram");
  });

  it("rejects a missing use-case score", () => {
    const broken = structuredClone(knowledge) as unknown as {
      models: [{ strengths: Record<string, number> }];
    };
    delete broken.models[0].strengths.photoreal;

    expectRejection(() => parseModelKnowledge(broken), "photoreal");
  });

  it("rejects duplicate model ids", () => {
    const broken = structuredClone(knowledge);
    broken.models.push(structuredClone(broken.models[0]!));

    expectRejection(() => parseModelKnowledge(broken), "unique");
  });

  it("rejects a model no provider can reach", () => {
    const broken = structuredClone(knowledge);
    broken.models[0]!.availability = [];

    expectRejection(() => parseModelKnowledge(broken), "availability");
  });

  it("rejects an unknown field rather than silently ignoring it", () => {
    expectRejection(() => parseModelKnowledge({ ...knowledge, rank: "first" }), "rank");
  });

  it("rejects a future schema version", () => {
    expectRejection(
      () => parseModelKnowledge({ ...knowledge, schema_version: 2 }),
      "schema_version",
    );
  });
});

describe("queries restricted to configured providers", () => {
  it("answers the best model for a use case given only certain providers", () => {
    const best = bestModelForUseCase(knowledge, "text_in_image", {
      providers: ["google", "xai"],
    });

    expect(best?.model.id).toBe("grok-imagine-image-2.0");
    expect(best?.via.provider).toBe("xai");
  });

  it("returns the unrestricted winner when no filter is given", () => {
    const best = bestModelForUseCase(knowledge, "text_in_image");

    expect(best?.model.id).toBe("gpt-image-2");
    expect(best?.via.provider).toBe("azure");
  });

  it("hides models the given providers cannot reach", () => {
    const ids = modelsAvailableVia(knowledge, { providers: ["azure"] }).map(
      (selection) => selection.model.id,
    );

    expect(ids).toEqual(["gpt-image-2"]);
  });

  it("returns nothing when no provider is configured", () => {
    expect(modelsAvailableVia(knowledge, { providers: [] })).toEqual([]);
    expect(
      bestModelForUseCase(knowledge, "diagram", { providers: [] }),
    ).toBeUndefined();
  });

  it("breaks a score tie on price, then on id", () => {
    const tied = rescored(4);

    expect(
      rankModelsForUseCase(tied, "diagram").map((selection) => selection.model.id),
    ).toEqual([
      "grok-imagine-image-2.0",
      "gemini-3.1-flash-image",
      "flux-2-pro",
      "gpt-image-2",
    ]);
  });

  it("ranks by score before price", () => {
    const ranked = rankModelsForUseCase(knowledge, "text_in_image");

    expect(ranked.map((selection) => selection.model.id)).toEqual([
      "gpt-image-2",
      "flux-2-pro",
      "grok-imagine-image-2.0",
      "gemini-3.1-flash-image",
    ]);
  });
});

describe("price lookup", () => {
  it("finds a model and its indicative price", () => {
    expect(findModel(knowledge, "flux-2-pro")?.display_name).toBe("FLUX 2 Pro");
    expect(priceForModel(knowledge, "gemini-3.1-flash-image")).toMatchObject({
      per_image_usd: 0.039,
      per_image_usd_4k: 0.12,
    });
  });

  it("estimates a batch, which is the point of the cheaper-alternative advice", () => {
    expect(estimateCostUsd(knowledge, "gpt-image-2", 6)).toBeCloseTo(1.14, 5);
    expect(estimateCostUsd(knowledge, "gemini-3.1-flash-image", 6)).toBeCloseTo(
      0.234,
      5,
    );
  });

  it("does not pretend an uncurated model is free", () => {
    expect(priceForModel(knowledge, "dall-e-3")).toBeUndefined();
    expect(estimateCostUsd(knowledge, "dall-e-3", 6)).toBeUndefined();
  });
});
