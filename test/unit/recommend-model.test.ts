import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CostLedger } from "../../src/core/budget.js";
import {
  DEFAULT_CONFIG,
  type Config,
  type ProviderConfig,
} from "../../src/core/config-schema.js";
import { parseModelKnowledge, type ModelKnowledge } from "../../src/core/knowledge.js";
import type { NormalisedResult, ProviderModel } from "../../src/core/types.js";
import { createServer, type ServerDependencies } from "../../src/mcp/server.js";
import { StubProvider } from "../../src/providers/stub.js";
import type { ImageProvider } from "../../src/providers/types.js";

/**
 * Three models with the shape of the real ones: a strong expensive specialist
 * reachable only through a second provider, a mid-priced all-rounder, and a
 * cheap one a point behind it.
 */
const knowledge: ModelKnowledge = parseModelKnowledge({
  schema_version: 1,
  updated: "2026-08-26",
  disclaimer: "Test fixture. Scores are editorial, prices indicative.",
  models: [
    {
      id: "premium-1",
      display_name: "Premium One",
      family: "test",
      leaderboard: null,
      strengths: {
        text_in_image: 5,
        photoreal: 4,
        illustration: 4,
        diagram: 4,
        fast_bulk: 2,
      },
      typical_latency_s: 12,
      price: {
        per_image_usd: 0.19,
        per_image_usd_4k: null,
        confidence: "indicative",
        checked: "2026-08-26",
      },
      availability: [{ provider: "premium", model_ref: "premium/premium-1" }],
      max_size: "1536x1024",
      notes:
        "Pick it when words must be legible inside the image. Do not pick it for bulk work.",
    },
    {
      id: "workhorse-1",
      display_name: "Workhorse One",
      family: "test",
      leaderboard: null,
      strengths: {
        text_in_image: 3,
        photoreal: 4,
        illustration: 5,
        diagram: 4,
        fast_bulk: 5,
      },
      typical_latency_s: 4,
      price: {
        per_image_usd: 0.04,
        per_image_usd_4k: null,
        confidence: "indicative",
        checked: "2026-08-26",
      },
      availability: [
        { provider: "stub", model_ref: "workhorse-1" },
        { provider: "premium", model_ref: "premium/workhorse-1" },
      ],
      max_size: "1024x1024",
      notes:
        "The default workhorse: fast and cheap. Do not pick it when the image must contain readable text.",
    },
    {
      id: "budget-1",
      display_name: "Budget One",
      family: "test",
      leaderboard: null,
      strengths: {
        text_in_image: 2,
        photoreal: 3,
        illustration: 4,
        diagram: 3,
        fast_bulk: 5,
      },
      typical_latency_s: 3,
      price: {
        per_image_usd: 0.01,
        per_image_usd_4k: null,
        confidence: "indicative",
        checked: "2026-08-26",
      },
      availability: [{ provider: "stub", model_ref: "budget-1" }],
      max_size: "1024x1024",
      notes:
        "The cheapest of the set. Do not pick it when the output size is load-bearing.",
    },
  ],
});

class UnconfiguredProvider extends StubProvider {
  override isConfigured(): boolean {
    return false;
  }
}

/** Proves the tool never generates: any call into the adapter fails the test. */
class ExplodingProvider implements ImageProvider {
  readonly id: string;

  constructor(id: string) {
    this.id = id;
  }

  isConfigured(): boolean {
    return true;
  }

  listModels(): Promise<ProviderModel[]> {
    throw new Error(`${this.id}.listModels must not be called by recommend_model`);
  }

  generate(): Promise<NormalisedResult> {
    throw new Error(`${this.id}.generate must not be called by recommend_model`);
  }
}

function provider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return { enabled: true, api_key_env: "STUB_API_KEY", ...overrides };
}

function config(): Config {
  return {
    ...structuredClone(DEFAULT_CONFIG),
    providers: {
      stub: provider(),
      premium: provider({ api_key_env: "PREMIUM_API_KEY" }),
    },
  };
}

function dependencies(
  providers: readonly ImageProvider[] = [new StubProvider()],
): ServerDependencies {
  const resolved = config();
  return {
    config: resolved,
    knowledge,
    ledger: new CostLedger({ budget: resolved.budget }),
    providers,
  };
}

interface ToolResult {
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

async function connect(deps: ServerDependencies): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([
    createServer(deps).connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

async function callRecommendModel(
  deps: ServerDependencies,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const client = await connect(deps);
  try {
    const result = (await client.callTool({
      name: "recommend_model",
      arguments: args,
    })) as unknown as ToolResult;
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
    expect(result.structuredContent).toEqual(body);
    return body;
  } finally {
    await client.close();
  }
}

function section(body: Record<string, unknown>, key: string): Record<string, unknown> {
  return (body[key] ?? {}) as Record<string, unknown>;
}

describe("the recommend_model tool", () => {
  it("is listed as read-only with the parameters PLAN.md §5.3 names", async () => {
    const client = await connect(dependencies());
    const { tools } = await client.listTools();
    await client.close();

    const tool = tools.find((entry) => entry.name === "recommend_model");
    expect(tool).toBeDefined();
    expect(Object.keys(tool?.inputSchema.properties ?? {}).sort()).toEqual([
      "budget_hint",
      "use_case",
    ]);
    expect(tool?.inputSchema.required ?? []).toEqual([]);
    expect(tool?.annotations?.readOnlyHint).toBe(true);
  });

  it("recommends the best configured model for one image, and names the cheaper one", async () => {
    const body = await callRecommendModel(dependencies([new StubProvider()]), {
      use_case: "illustration",
      budget_hint: "one hero image, quality matters",
    });

    expect(body["use_case"]).toBe("illustration");
    expect(section(body, "best_overall")).toMatchObject({
      model: "workhorse-1",
      available_to_you: true,
      via: ["stub", "premium"],
    });
    expect(String(section(body, "best_overall")["why"])).toContain(
      "5/5 for illustration",
    );
    expect(section(body, "best_configured")).toMatchObject({
      model: "workhorse-1",
      via: "stub",
      price_per_image_usd: 0.04,
    });
    expect(section(body, "cheaper_alternative")).toMatchObject({ model: "budget-1" });
    expect(String(section(body, "cheaper_alternative")["trade_off"])).toContain(
      "4x cheaper",
    );

    expect(body["recommended_model"]).toBe("workhorse-1");
    expect(section(body, "estimate")).toMatchObject({
      assumed_count: 1,
      recommended_total_usd: 0.04,
      cheaper_total_usd: 0.01,
    });
    expect(String(section(body, "estimate")["assumption"])).toContain("Read 1 image");
    expect(body["note_on_unconfigured"]).toEqual([]);
    expect(body["knowledge_updated"]).toBe("2026-08-26");
    expect(String(body["disclaimer"])).toContain("editorial");
  });

  it("says when the best model is not configured and what enabling it takes", async () => {
    const body = await callRecommendModel(
      dependencies([new StubProvider(), new UnconfiguredProvider("premium")]),
      { use_case: "text_in_image" },
    );

    expect(section(body, "best_overall")).toMatchObject({
      model: "premium-1",
      available_to_you: false,
      via: ["premium"],
    });
    expect(section(body, "best_configured")).toMatchObject({
      model: "workhorse-1",
      via: "stub",
    });

    const notes = body["note_on_unconfigured"] as string[];
    expect(notes).toHaveLength(2);
    expect(notes[0]).toContain("Premium One");
    expect(notes[0]).toContain("cannot reach it");
    expect(notes[1]).toContain("premium-1");
    expect(notes[1]).toContain("PREMIUM_API_KEY");
    expect(notes.join(" ")).not.toContain("workhorse-1");
  });

  it("recommends the cheap model once the volume in budget_hint makes cost decide", async () => {
    const body = await callRecommendModel(dependencies([new StubProvider()]), {
      use_case: "illustration",
      budget_hint: "20 images for a deck",
    });

    expect(section(body, "best_configured")).toMatchObject({ model: "workhorse-1" });
    expect(body["recommended_model"]).toBe("budget-1");
    expect(section(body, "estimate")).toMatchObject({
      assumed_count: 20,
      recommended_total_usd: 0.8,
      cheaper_total_usd: 0.2,
    });

    const recommendation = String(body["recommendation"]);
    expect(recommendation).toContain("Budget One");
    expect(recommendation).toContain("$0.20");
    expect(recommendation).toContain("$0.80");
    expect(recommendation).toContain("saving");
    expect(String(section(body, "estimate")["assumption"])).toContain("Read 20 images");
  });

  it("lets a stated dollar cap override the quality argument, and reads no count from it", async () => {
    const body = await callRecommendModel(
      dependencies([new StubProvider(), new StubProvider("premium")]),
      { use_case: "text_in_image", budget_hint: "12 images, under $1 total" },
    );

    expect(section(body, "best_configured")).toMatchObject({
      model: "premium-1",
      via: "premium",
    });
    expect(section(body, "estimate")).toMatchObject({
      assumed_count: 12,
      assumed_budget_usd: 1,
      recommended_total_usd: 2.28,
      cheaper_total_usd: 0.12,
    });
    expect(body["recommended_model"]).toBe("budget-1");
    expect(String(body["recommendation"])).toContain("$1.00 budget does not cover");
  });

  it("answers generally with no arguments, and states the count it assumed", async () => {
    const body = await callRecommendModel(dependencies([new StubProvider()]));

    expect(body["use_case"]).toBeNull();
    expect(section(body, "best_overall")).toMatchObject({ model: "workhorse-1" });
    expect(section(body, "best_configured")).toMatchObject({ model: "workhorse-1" });
    expect(body["recommended_model"]).toBe("workhorse-1");
    expect(section(body, "estimate")["assumed_count"]).toBe(1);
    expect(String(section(body, "estimate")["assumption"])).toContain(
      "No budget_hint given",
    );
    expect(String(body["recommendation"])).toContain("Workhorse One");
  });

  it("still advises when nothing is configured, rather than failing", async () => {
    const body = await callRecommendModel(
      dependencies([new UnconfiguredProvider(), new UnconfiguredProvider("premium")]),
      { use_case: "diagram" },
    );

    expect(body["best_configured"]).toBeNull();
    expect(body["cheaper_alternative"]).toBeNull();
    expect(body["recommended_model"]).toBeNull();
    expect(section(body, "estimate")["recommended_total_usd"]).toBeNull();
    expect(String(body["recommendation"])).toContain("Nothing to recommend yet");

    const notes = (body["note_on_unconfigured"] as string[]).join(" ");
    expect(notes).toContain("STUB_API_KEY");
    expect(notes).toContain("PREMIUM_API_KEY");
    expect(notes).toContain("workhorse-1");
  });

  it("reads a count out of budget_hint only where one is there", async () => {
    const body = await callRecommendModel(dependencies([new StubProvider()]), {
      budget_hint: "under $1 total",
    });

    expect(section(body, "estimate")).toMatchObject({
      assumed_count: 1,
      assumed_budget_usd: 1,
    });
    expect(String(section(body, "estimate")["assumption"])).toContain("No count found");
  });

  it("calls no provider and spends nothing", async () => {
    const deps = dependencies([new ExplodingProvider("stub")]);
    const body = await callRecommendModel(deps, { use_case: "fast_bulk" });

    expect(body["best_configured"]).not.toBeNull();
    expect(deps.ledger.spentThisSession()).toBe(0);
  });
});
