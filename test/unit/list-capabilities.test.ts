import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CostLedger } from "../../src/core/budget.js";
import {
  DEFAULT_CONFIG,
  configSchema,
  type Config,
} from "../../src/core/config-schema.js";
import { ImagineError } from "../../src/core/errors.js";
import { parseModelKnowledge, type ModelKnowledge } from "../../src/core/knowledge.js";
import type { NormalisedResult, ProviderModel } from "../../src/core/types.js";
import { createServer, type ServerDependencies } from "../../src/mcp/server.js";
import {
  LIST_CAPABILITIES_TOOL_NAME,
  type ListCapabilitiesSuccess,
  type ProviderCapability,
} from "../../src/mcp/tools/list-capabilities.js";
import type { ImageProvider } from "../../src/providers/types.js";

const SECRET = "sk-do-not-leak-this-value";

const config: Config = configSchema.parse({
  ...DEFAULT_CONFIG,
  default: { model: null, size: "1024x1024", use_case: null },
  providers: {
    ready: { enabled: true, api_key_env: "IMAGINE_TEST_READY_KEY" },
    missing: { enabled: true, api_key_env: "IMAGINE_TEST_MISSING_KEY" },
    off: { enabled: false, api_key_env: "IMAGINE_TEST_OFF_KEY" },
  },
  budget: { max_usd_per_session: 5, max_usd_per_day: 10, on_exceed: "refuse" },
});

const env = { IMAGINE_TEST_READY_KEY: SECRET };

const knowledge: ModelKnowledge = parseModelKnowledge({
  schema_version: 1,
  updated: "2026-08-20",
  disclaimer: "Editorial judgement, not measurement.",
  models: [
    {
      id: "fast-one",
      display_name: "Fast One",
      family: "test",
      leaderboard: null,
      strengths: {
        text_in_image: 5,
        photoreal: 5,
        illustration: 5,
        diagram: 5,
        fast_bulk: 5,
      },
      typical_latency_s: 2,
      price: {
        per_image_usd: 0.02,
        per_image_usd_4k: null,
        confidence: "indicative",
        checked: "2026-08-20",
      },
      availability: [{ provider: "ready", model_ref: "ready/fast-1" }],
      max_size: "1024x1024",
      notes: "Only exists in tests.",
    },
    {
      id: "shared-one",
      display_name: "Shared One",
      family: "test",
      leaderboard: null,
      strengths: {
        text_in_image: 2,
        photoreal: 2,
        illustration: 2,
        diagram: 2,
        fast_bulk: 2,
      },
      typical_latency_s: 4,
      price: {
        per_image_usd: 0.05,
        per_image_usd_4k: null,
        confidence: "indicative",
        checked: "2026-08-20",
      },
      availability: [
        { provider: "ready", model_ref: "ready/shared-1" },
        { provider: "off", model_ref: "off/shared-1" },
      ],
      max_size: "1536x1024",
      notes: "Only exists in tests.",
    },
    {
      id: "unreachable-one",
      display_name: "Unreachable One",
      family: "test",
      leaderboard: null,
      strengths: {
        text_in_image: 4,
        photoreal: 4,
        illustration: 4,
        diagram: 4,
        fast_bulk: 4,
      },
      typical_latency_s: 9,
      price: {
        per_image_usd: 0.3,
        per_image_usd_4k: null,
        confidence: "indicative",
        checked: "2026-08-20",
      },
      availability: [{ provider: "missing", model_ref: "missing/unreachable-1" }],
      max_size: "1024x1024",
      notes: "Only exists in tests.",
    },
  ],
});

class FakeProvider implements ImageProvider {
  listModelsCalls = 0;

  constructor(
    readonly id: string,
    private readonly models: ProviderModel[] | ImagineError,
    private readonly configured = true,
  ) {}

  isConfigured(): boolean {
    return this.configured;
  }

  listModels(): Promise<ProviderModel[]> {
    this.listModelsCalls += 1;
    return this.models instanceof ImagineError
      ? Promise.reject(this.models)
      : Promise.resolve(this.models);
  }

  generate(): Promise<NormalisedResult> {
    return Promise.reject(new ImagineError("unknown", "not used in this test"));
  }
}

function providerModel(id: string): ProviderModel {
  return { id, display_name: id, capabilities: {} };
}

function readyProvider(): FakeProvider {
  return new FakeProvider("ready", [
    providerModel("ready/fast-1"),
    providerModel("ready/live-only-1"),
  ]);
}

let ledger: CostLedger;

beforeEach(async () => {
  const directory = await mkdtemp(join(tmpdir(), "imagine-list-capabilities-"));
  ledger = new CostLedger({
    budget: config.budget,
    costLog: join(directory, "costs.jsonl"),
  });
});

async function capabilities(
  overrides: Partial<ServerDependencies> = {},
): Promise<{ payload: ListCapabilitiesSuccess; raw: string }> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  const server = createServer({
    config,
    env,
    knowledge,
    ledger,
    providers: [readyProvider()],
    ...overrides,
  });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const result = await client.callTool({
    name: LIST_CAPABILITIES_TOOL_NAME,
    arguments: {},
  });
  await client.close();

  expect(result.isError).toBeFalsy();
  return {
    payload: result.structuredContent as unknown as ListCapabilitiesSuccess,
    raw: JSON.stringify(result),
  };
}

function byId(payload: ListCapabilitiesSuccess, id: string): ProviderCapability {
  const found = payload.configured_providers.find((provider) => provider.id === id);
  if (found === undefined) throw new Error(`no provider ${id} in the response`);
  return found;
}

describe("list_capabilities", () => {
  it("is registered as a read-only tool taking no arguments", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    const server = createServer({
      config,
      env,
      knowledge,
      ledger,
      providers: [readyProvider()],
    });

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const { tools } = await client.listTools();
    const tool = tools.find((entry) => entry.name === LIST_CAPABILITIES_TOOL_NAME);

    expect(tool?.annotations?.readOnlyHint).toBe(true);
    expect(tool?.inputSchema.properties ?? {}).toEqual({});

    await client.close();
  });

  it("reports a configured provider as ready, with the models it discovers live", async () => {
    const { payload } = await capabilities();
    const ready = byId(payload, "ready");

    expect(ready.status).toBe("ready");
    expect(ready.models_source).toBe("live");
    expect(ready.models).toEqual(["ready/fast-1", "ready/live-only-1"]);
    expect(ready.missing).toBeUndefined();
  });

  it("names the environment variable an unconfigured provider is waiting for", async () => {
    const { payload } = await capabilities();
    const missing = byId(payload, "missing");

    expect(missing.status).toBe("not_configured");
    expect(missing.missing).toEqual(["IMAGINE_TEST_MISSING_KEY"]);
    expect(missing.models).toEqual(["missing/unreachable-1"]);
    expect(missing.models_source).toBe("curated");
  });

  it("reports a disabled provider as not configured, without asking for a key", async () => {
    const { payload } = await capabilities();
    const off = byId(payload, "off");

    expect(off.status).toBe("not_configured");
    expect(off.missing).toBeUndefined();
    expect(off.note).toMatch(/disabled/i);
  });

  it("never returns a key value", async () => {
    const { raw } = await capabilities();
    expect(raw).not.toContain(SECRET);
  });

  it("survives a provider whose live discovery fails", async () => {
    const broken = new FakeProvider(
      "ready",
      new ImagineError("provider_unavailable", "could not reach the provider"),
    );
    const { payload } = await capabilities({ providers: [broken] });
    const ready = byId(payload, "ready");

    expect(ready.status).toBe("error");
    expect(ready.error).toContain("could not reach the provider");
    expect(ready.models).toEqual(["ready/fast-1", "ready/shared-1"]);
    expect(ready.models_source).toBe("curated");
  });

  it("reports an adapter that says it is unconfigured as not configured", async () => {
    const unconfigured = new FakeProvider("ready", [], false);
    const { payload } = await capabilities({ providers: [unconfigured] });

    expect(byId(payload, "ready").status).toBe("not_configured");
    expect(unconfigured.listModelsCalls).toBe(0);
  });

  it("says so when a configured provider has no registered adapter", async () => {
    const { payload } = await capabilities({ providers: [] });
    const ready = byId(payload, "ready");

    expect(ready.status).toBe("not_configured");
    expect(ready.note).toMatch(/adapter/i);
  });

  it("discovers models once per provider per process", async () => {
    const provider = readyProvider();
    await capabilities({ providers: [provider] });
    await capabilities({ providers: [provider] });

    expect(provider.listModelsCalls).toBe(1);
  });

  it("marks curated models reachable only through a ready provider", async () => {
    const { payload } = await capabilities();
    const available = Object.fromEntries(
      payload.models.map((model) => [model.id, model.available]),
    );

    expect(available).toEqual({
      "fast-one": true,
      "shared-one": true,
      "unreachable-one": false,
    });
    expect(payload.models.find((model) => model.id === "shared-one")?.provider).toBe(
      "ready",
    );
    expect(
      payload.models.find((model) => model.id === "unreachable-one")?.provider,
    ).toBeNull();
  });

  it("reports the model generate_image would pick with no arguments", async () => {
    const { payload } = await capabilities();
    expect(payload.default_model).toBe("fast-one");
  });

  it("reports the budget with both session and day figures", async () => {
    await ledger.record({
      provider: "ready",
      model: "fast-one",
      reported_cost_usd: 0.25,
    });
    const { payload } = await capabilities();

    expect(payload.budget).toMatchObject({
      session_spent_usd: 0.25,
      session_limit_usd: 5,
      day_spent_usd: 0.25,
      day_limit_usd: 10,
      on_exceed: "refuse",
    });
    expect(payload.budget.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Date.parse(payload.budget.day_resets_at)).not.toBeNaN();
  });

  it("carries the curated data's age, disclaimer and use-case tags", async () => {
    const { payload } = await capabilities();

    expect(payload.knowledge_updated).toBe("2026-08-20");
    expect(payload.disclaimer).toBe("Editorial judgement, not measurement.");
    expect(payload.use_cases).toEqual([
      "text_in_image",
      "photoreal",
      "illustration",
      "diagram",
      "fast_bulk",
    ]);
  });
});
