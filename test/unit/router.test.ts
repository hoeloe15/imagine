import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CONFIG,
  configSchema,
  type Config,
} from "../../src/core/config-schema.js";
import { ImagineError } from "../../src/core/errors.js";
import { loadBundledModelKnowledge } from "../../src/core/knowledge.js";
import { planCandidates, route, usableProviders } from "../../src/core/router.js";
import type {
  NormalisedRequest,
  NormalisedResult,
  ProviderModel,
} from "../../src/core/types.js";
import type { ImageProvider, ResolvedModel } from "../../src/providers/types.js";
import { StubProvider } from "../../src/providers/stub.js";

const knowledge = loadBundledModelKnowledge();

/**
 * The bundled defaults have every provider but OpenRouter switched off, which
 * would hide the multi-provider paths under test.
 */
function config(overrides: Record<string, unknown> = {}): Config {
  const base = structuredClone(DEFAULT_CONFIG);
  for (const provider of Object.values(base.providers)) provider.enabled = true;
  return configSchema.parse({ ...base, ...overrides });
}

function request(overrides: Partial<NormalisedRequest> = {}): NormalisedRequest {
  return { prompt: "a regional distribution network", ...overrides };
}

/** A stub under a real provider's id, recording what the router hands it. */
class NamedStub implements ImageProvider {
  readonly calls: { request: NormalisedRequest; resolved?: ResolvedModel }[] = [];
  private readonly stub: StubProvider;

  constructor(readonly id: string) {
    this.stub = new StubProvider(id);
  }

  isConfigured(): boolean {
    return true;
  }

  listModels(): Promise<ProviderModel[]> {
    return this.stub.listModels();
  }

  generate(
    givenRequest: NormalisedRequest,
    resolved?: ResolvedModel,
  ): Promise<NormalisedResult> {
    this.calls.push({ request: givenRequest, ...(resolved ? { resolved } : {}) });
    return this.stub.generate(givenRequest, resolved);
  }
}

class FailingProvider implements ImageProvider {
  readonly calls: { request: NormalisedRequest; resolved?: ResolvedModel }[] = [];

  constructor(
    readonly id: string,
    private readonly failure: ImagineError,
  ) {}

  isConfigured(): boolean {
    return true;
  }

  listModels(): Promise<ProviderModel[]> {
    return Promise.resolve([]);
  }

  generate(
    givenRequest: NormalisedRequest,
    resolved?: ResolvedModel,
  ): Promise<NormalisedResult> {
    this.calls.push({ request: givenRequest, ...(resolved ? { resolved } : {}) });
    return Promise.reject(this.failure);
  }
}

class UnconfiguredProvider extends StubProvider {
  override isConfigured(): boolean {
    return false;
  }
}

function rateLimited(): ImagineError {
  return new ImagineError("rate_limited", "quota exhausted", { retryable: true });
}

function filtered(): ImagineError {
  return new ImagineError("content_filtered", "prompt rejected by policy");
}

function authFailed(): ImagineError {
  return new ImagineError("auth_failed", "401 from provider: invalid API key");
}

describe("usableProviders", () => {
  it("drops providers that are disabled in config or report themselves unconfigured", () => {
    const usable = usableProviders(
      config({
        providers: {
          openrouter: { enabled: false, api_key_env: "OPENROUTER_API_KEY" },
          azure: { enabled: true, api_key_env: "AZURE_OPENAI_API_KEY" },
        },
      }),
      [
        new NamedStub("openrouter"),
        new NamedStub("azure"),
        new UnconfiguredProvider("xai"),
      ],
    );

    expect(usable.map((provider) => provider.id)).toEqual(["azure"]);
  });
});

describe("planCandidates", () => {
  it("ranks by use case, restricted to available providers", () => {
    const plan = planCandidates({
      request: request({ use_case: "text_in_image" }),
      config: config(),
      knowledge,
      providers: [new NamedStub("openrouter")],
    });

    expect(plan.candidates[0]).toMatchObject({
      provider: "openrouter",
      model: "gpt-image-2",
      model_ref: "openai/gpt-image-2",
      source: "use_case",
    });
    expect(plan.candidates[0]?.reason).toContain("use_case=text_in_image");
    expect(
      plan.candidates.every((candidate) => candidate.provider === "openrouter"),
    ).toBe(true);
  });

  it("puts a honoured provider hint ahead of the use-case ranking", () => {
    const plan = planCandidates({
      request: request({ use_case: "illustration", provider_hint: "azure" }),
      config: config(),
      knowledge,
      providers: [new NamedStub("openrouter"), new NamedStub("azure")],
    });

    expect(plan.hint).toEqual({ requested: "azure", honoured: true });
    expect(plan.candidates[0]).toMatchObject({
      provider: "azure",
      source: "provider_hint",
    });
    expect(
      plan.candidates.some((candidate) => candidate.provider === "openrouter"),
    ).toBe(true);
  });

  it("honours a hint that names a model rather than a provider", () => {
    const plan = planCandidates({
      request: request({ provider_hint: "gemini-3.1-flash-image" }),
      config: config(),
      knowledge,
      providers: [new NamedStub("openrouter"), new NamedStub("azure")],
    });

    expect(plan.hint?.honoured).toBe(true);
    expect(plan.candidates[0]).toMatchObject({
      model: "gemini-3.1-flash-image",
      model_ref: "google/gemini-3.1-flash-image",
      source: "provider_hint",
    });
  });

  it("reports an unavailable hint as not honoured and selects anyway", () => {
    const plan = planCandidates({
      request: request({ use_case: "diagram", provider_hint: "azure" }),
      config: config(),
      knowledge,
      providers: [new NamedStub("openrouter")],
    });

    expect(plan.hint?.honoured).toBe(false);
    expect(plan.hint?.note).toContain("azure");
    expect(plan.candidates[0]).toMatchObject({
      provider: "openrouter",
      source: "use_case",
    });
  });

  it("explains a hint that names nothing the installation knows", () => {
    const plan = planCandidates({
      request: request({ provider_hint: "midjourney" }),
      config: config(),
      knowledge,
      providers: [new NamedStub("openrouter")],
    });

    expect(plan.hint).toMatchObject({ requested: "midjourney", honoured: false });
    expect(plan.hint?.note).toContain("nor a known model");
  });

  it("falls back to config default.model when no hint or use case is given", () => {
    const plan = planCandidates({
      request: request(),
      config: config({
        default: { model: "flux-2-pro", size: "1024x1024", use_case: null },
      }),
      knowledge,
      providers: [new NamedStub("openrouter")],
    });

    expect(plan.candidates[0]).toMatchObject({
      model: "flux-2-pro",
      source: "config_default",
    });
  });

  it("uses the bundled default when nothing else narrows the choice", () => {
    const plan = planCandidates({
      request: request(),
      config: config(),
      knowledge,
      providers: [new NamedStub("openrouter")],
    });

    expect(plan.candidates[0]).toMatchObject({
      model: "gemini-3.1-flash-image",
      source: "bundled_default",
    });
  });

  it("prefers config default.use_case over the bundled default", () => {
    const plan = planCandidates({
      request: request(),
      config: config({
        default: { model: null, size: "1024x1024", use_case: "text_in_image" },
      }),
      knowledge,
      providers: [new NamedStub("openrouter")],
    });

    expect(plan.candidates[0]).toMatchObject({
      model: "gpt-image-2",
      source: "use_case",
    });
  });

  it("refuses clearly when no provider is available at all", () => {
    expect(() =>
      planCandidates({
        request: request(),
        config: config(),
        knowledge,
        providers: [new UnconfiguredProvider("openrouter")],
      }),
    ).toThrowError(
      expect.objectContaining({
        name: "ImagineError",
        reason: "invalid_request",
        message: expect.stringContaining("unconfigured"),
      }),
    );
  });

  it("refuses clearly when an available provider reaches no curated model", () => {
    expect(() =>
      planCandidates({
        request: request(),
        config: config(),
        knowledge,
        providers: [new NamedStub("stub")],
      }),
    ).toThrowError(
      expect.objectContaining({ reason: "invalid_request", name: "ImagineError" }),
    );
  });
});

describe("route", () => {
  it("calls the selected adapter with the resolved model reference and the default size", async () => {
    const openrouter = new NamedStub("openrouter");

    const outcome = await route({
      request: request({ use_case: "illustration" }),
      config: config(),
      knowledge,
      providers: [openrouter],
    });

    expect(outcome.selected).toMatchObject({
      provider: "openrouter",
      model: "gemini-3.1-flash-image",
    });
    expect(openrouter.calls[0]).toMatchObject({
      request: { size: "1024x1024", prompt: "a regional distribution network" },
      resolved: { model_ref: "google/gemini-3.1-flash-image" },
    });
    expect(outcome.selection_reason).toContain("use_case=illustration");
    expect(outcome.attempts).toEqual([
      expect.objectContaining({
        provider: "openrouter",
        attempt: 1,
        outcome: "succeeded",
      }),
    ]);
  });

  it("keeps an explicitly requested size", async () => {
    const openrouter = new NamedStub("openrouter");

    await route({
      request: request({ size: "1536x1024" }),
      config: config(),
      knowledge,
      providers: [openrouter],
    });

    expect(openrouter.calls[0]?.request.size).toBe("1536x1024");
  });

  it("hands the adapter the caller's hint untouched, beside the resolved model", async () => {
    const openrouter = new NamedStub("openrouter");

    await route({
      request: request({ provider_hint: "gemini-3.1-flash-image" }),
      config: config(),
      knowledge,
      providers: [openrouter],
    });

    expect(openrouter.calls[0]?.request.provider_hint).toBe("gemini-3.1-flash-image");
    expect(openrouter.calls[0]?.resolved).toEqual({
      model_ref: "google/gemini-3.1-flash-image",
    });
  });

  it("says in selection_reason that a hint was not honoured", async () => {
    const outcome = await route({
      request: request({ provider_hint: "google", use_case: "diagram" }),
      config: config(),
      knowledge,
      providers: [new NamedStub("openrouter")],
    });

    expect(outcome.hint).toMatchObject({ requested: "google", honoured: false });
    expect(outcome.selection_reason).toContain('provider_hint="google" not honoured');
    expect(outcome.selected.provider).toBe("openrouter");
  });

  it("retries a transient failure once against the same provider", async () => {
    const flaky = new FailingProvider("openrouter", rateLimited());
    const generate = vi.spyOn(flaky, "generate");
    generate.mockRejectedValueOnce(rateLimited());
    generate.mockResolvedValueOnce({
      bytes: new Uint8Array([1]),
      mime_type: "image/png",
      provider: "openrouter",
      model: "google/gemini-3.1-flash-image",
      cost_usd: 0.039,
      duration_ms: 10,
      width: 1024,
      height: 1024,
    });

    const outcome = await route({
      request: request(),
      config: config(),
      knowledge,
      providers: [flaky],
    });

    expect(generate).toHaveBeenCalledTimes(2);
    expect(outcome.attempts).toHaveLength(2);
    expect(outcome.attempts[0]).toMatchObject({ attempt: 1, outcome: "failed" });
    expect(outcome.attempts[1]).toMatchObject({ attempt: 2, outcome: "succeeded" });
  });

  it("falls back to the next provider after a persistent transient failure, and reports it", async () => {
    const openrouter = new FailingProvider("openrouter", rateLimited());
    const azure = new NamedStub("azure");

    const outcome = await route({
      request: request({ use_case: "text_in_image" }),
      config: config(),
      knowledge,
      providers: [openrouter, azure],
    });

    expect(openrouter.calls).toHaveLength(2);
    expect(outcome.selected.provider).toBe("azure");
    expect(outcome.selection_reason).toContain("fell back to azure");
    expect(outcome.selection_reason).toContain("rate_limited");
    expect(outcome.attempts.map((attempt) => attempt.outcome)).toEqual([
      "failed",
      "failed",
      "succeeded",
    ]);
  });

  it("does not fall back after a non-retryable failure", async () => {
    const openrouter = new FailingProvider("openrouter", filtered());
    const azure = new NamedStub("azure");

    await expect(
      route({
        request: request({ use_case: "text_in_image" }),
        config: config(),
        knowledge,
        providers: [openrouter, azure],
      }),
    ).rejects.toMatchObject({ name: "ImagineError", reason: "content_filtered" });

    expect(openrouter.calls).toHaveLength(1);
    expect(azure.calls).toHaveLength(0);
  });

  it.each([
    new ImagineError("invalid_request", "size not supported"),
    new ImagineError("budget_exceeded", "session limit of $5.00 reached"),
    new ImagineError("unknown", "something the adapter could not classify"),
  ])(
    "keeps $reason a request-level refusal, with no other provider tried",
    async (failure) => {
      const openrouter = new FailingProvider("openrouter", failure);
      const azure = new NamedStub("azure");

      await expect(
        route({
          request: request({ use_case: "text_in_image" }),
          config: config(),
          knowledge,
          providers: [openrouter, azure],
        }),
      ).rejects.toMatchObject({ name: "ImagineError", reason: failure.reason });

      expect(openrouter.calls).toHaveLength(1);
      expect(azure.calls).toHaveLength(0);
    },
  );

  it("serves a hint-less request through azure when openrouter's key is rejected", async () => {
    const openrouter = new FailingProvider("openrouter", authFailed());
    const azure = new NamedStub("azure");

    const outcome = await route({
      request: request(),
      config: config(),
      knowledge,
      providers: [openrouter, azure],
    });

    expect(outcome.selected.provider).toBe("azure");
    expect(outcome.result.provider).toBe("azure");
    expect(azure.calls).toHaveLength(1);
    expect(outcome.selection_reason).toContain("openrouter");
    expect(outcome.selection_reason).toContain("auth_failed");
    expect(outcome.selection_reason).toContain("invalid API key");
  });

  it("does not retry a provider that rejected the credentials, and records the skip", async () => {
    const openrouter = new FailingProvider("openrouter", authFailed());
    const azure = new NamedStub("azure");

    const outcome = await route({
      request: request({ use_case: "text_in_image" }),
      config: config(),
      knowledge,
      providers: [openrouter, azure],
    });

    expect(openrouter.calls).toHaveLength(1);
    expect(outcome.attempts).toEqual([
      expect.objectContaining({
        provider: "openrouter",
        attempt: 1,
        outcome: "failed",
        failure: expect.objectContaining({ reason: "auth_failed", billed: false }),
      }),
      expect.objectContaining({ provider: "azure", outcome: "succeeded" }),
    ]);
  });

  it("reports auth_failed when every provider's credentials are rejected", async () => {
    const openrouter = new FailingProvider("openrouter", authFailed());
    const azure = new FailingProvider("azure", authFailed());

    await expect(
      route({
        request: request({ use_case: "text_in_image" }),
        config: config(),
        knowledge,
        providers: [openrouter, azure],
      }),
    ).rejects.toMatchObject({
      name: "ImagineError",
      reason: "auth_failed",
      message: expect.stringContaining("openrouter"),
    });

    expect(openrouter.calls).toHaveLength(1);
    expect(azure.calls).toHaveLength(1);
  });

  it("reports the whole trail when every provider fails", async () => {
    const openrouter = new FailingProvider("openrouter", rateLimited());
    const azure = new FailingProvider(
      "azure",
      new ImagineError("provider_unavailable", "503", {
        retryable: true,
        billed: false,
      }),
    );

    await expect(
      route({
        request: request({ use_case: "text_in_image" }),
        config: config(),
        knowledge,
        providers: [openrouter, azure],
      }),
    ).rejects.toMatchObject({
      name: "ImagineError",
      reason: "provider_unavailable",
      message: expect.stringContaining("openrouter/openai/gpt-image-2"),
    });

    expect(openrouter.calls).toHaveLength(2);
    expect(azure.calls).toHaveLength(2);
  });

  it("classifies an adapter error that is not an ImagineError as unknown, and stops", async () => {
    const openrouter = new FailingProvider("openrouter", rateLimited());
    vi.spyOn(openrouter, "generate").mockRejectedValue(new TypeError("fetch failed"));

    await expect(
      route({
        request: request(),
        config: config(),
        knowledge,
        providers: [openrouter],
      }),
    ).rejects.toMatchObject({
      name: "ImagineError",
      reason: "unknown",
      retryable: false,
    });
  });

  it("lets a budget precheck refuse before any provider is called", async () => {
    const openrouter = new NamedStub("openrouter");
    const budgetPrecheck = vi.fn(() => {
      throw new ImagineError("budget_exceeded", "session limit of $5.00 reached");
    });

    await expect(
      route({
        request: request(),
        config: config(),
        knowledge,
        providers: [openrouter],
        budgetPrecheck,
      }),
    ).rejects.toMatchObject({ reason: "budget_exceeded" });

    expect(budgetPrecheck).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openrouter",
        model_ref: expect.any(String),
      }),
    );
    expect(openrouter.calls).toHaveLength(0);
  });
});
