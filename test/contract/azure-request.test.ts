/**
 * What goes on the wire to Azure. These assertions are the point of the
 * hand-written adapter, and the two dialects are exact mirror images of each
 * other:
 *
 * - `openai` — the deployment name belongs in the URL path and must never
 *   appear as `model` in the body, the exact mistake that broke LiteLLM
 *   (research §2, §5, issue #9).
 * - `mai` — the deployment name belongs in the body as `model` and must never
 *   appear in the path, there is no `api-version`, and the host is a different
 *   one (`mai-image-2026-09.md` §1, issue #59).
 *
 * Each half is asserted against both dialects on purpose. The rule is per-API,
 * not per-vendor, so a change that "fixes" one of them by breaking the other has
 * to fail here.
 */

import { describe, expect, it } from "vitest";
import {
  AZURE_ENTRA_SCOPE,
  AZURE_MAI_ENTRA_SCOPE,
  AzureProvider,
  type FetchLike,
} from "../../src/providers/azure.js";

const ENDPOINT = "https://my-resource.openai.azure.com";
const API_KEY = "azure-test-key";
const DEPLOYMENTS = { "gpt-image-2": "my-gpt-image-2" };

interface RecordedCall {
  url: string;
  init: RequestInit;
}

function recordingFetch(responses: Response[]) {
  const calls: RecordedCall[] = [];
  const queue = [...responses];
  const impl: FetchLike = (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    const next = queue.shift();
    if (!next) throw new Error(`unexpected fetch call to ${String(input)}`);
    return Promise.resolve(next);
  };
  return { calls, impl };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function pngBase64(width: number, height: number): string {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return Buffer.from(bytes).toString("base64");
}

const IMAGE_RESPONSE = { created: 1, data: [{ b64_json: pngBase64(1024, 1024) }] };

function providerWith(responses: Response[]) {
  const fetch = recordingFetch(responses);
  const provider = new AzureProvider({
    endpoint: ENDPOINT,
    auth: "api_key",
    apiKey: API_KEY,
    deployments: DEPLOYMENTS,
    fetch: fetch.impl,
  });
  return { provider, fetch };
}

function bodyOf(call: RecordedCall | undefined): Record<string, unknown> {
  return JSON.parse(String(call?.init.body)) as Record<string, unknown>;
}

describe("Azure request shape — generate", () => {
  it("puts the deployment in the path and the api-version in the query", async () => {
    const { provider, fetch } = providerWith([jsonResponse(IMAGE_RESPONSE)]);

    await provider.generate(
      { prompt: "a red bicycle", size: "1536x1024" },
      { model_ref: "gpt-image-2" },
    );

    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]?.url).toBe(
      "https://my-resource.openai.azure.com/openai/deployments/my-gpt-image-2/images/generations?api-version=2025-04-01-preview",
    );
    expect(fetch.calls[0]?.init.method).toBe("POST");
  });

  it("never sends a model field in the body — the LiteLLM bug", async () => {
    const { provider, fetch } = providerWith([jsonResponse(IMAGE_RESPONSE)]);

    await provider.generate({ prompt: "x" }, { model_ref: "gpt-image-2" });

    const body = bodyOf(fetch.calls[0]);
    expect(body).not.toHaveProperty("model");
    expect(body).not.toHaveProperty("deployment");
    expect(JSON.stringify(body)).not.toContain("my-gpt-image-2");
  });

  it("still speaks the openai dialect when the entry is written as an object", async () => {
    const fetch = recordingFetch([jsonResponse(IMAGE_RESPONSE)]);
    const provider = new AzureProvider({
      endpoint: ENDPOINT,
      auth: "api_key",
      apiKey: API_KEY,
      deployments: { "gpt-image-2": { deployment: "my-gpt-image-2" } },
      fetch: fetch.impl,
    });

    await provider.generate({ prompt: "x" }, { model_ref: "gpt-image-2" });

    expect(fetch.calls[0]?.url).toBe(
      "https://my-resource.openai.azure.com/openai/deployments/my-gpt-image-2/images/generations?api-version=2025-04-01-preview",
    );
    expect(bodyOf(fetch.calls[0])).not.toHaveProperty("model");
  });

  it("sends exactly prompt, n and size, and no response_format", async () => {
    const { provider, fetch } = providerWith([jsonResponse(IMAGE_RESPONSE)]);

    await provider.generate(
      { prompt: "a red bicycle", size: "1024x1536" },
      { model_ref: "gpt-image-2" },
    );

    expect(bodyOf(fetch.calls[0])).toEqual({
      prompt: "a red bicycle",
      n: 1,
      size: "1024x1536",
    });
  });

  it("omits size entirely when the caller asked for auto or for nothing", async () => {
    const { provider, fetch } = providerWith([
      jsonResponse(IMAGE_RESPONSE),
      jsonResponse(IMAGE_RESPONSE),
    ]);

    await provider.generate(
      { prompt: "one", size: "auto" },
      { model_ref: "gpt-image-2" },
    );
    await provider.generate({ prompt: "two" }, { model_ref: "gpt-image-2" });

    for (const call of fetch.calls) {
      expect(bodyOf(call)).not.toHaveProperty("size");
    }
  });

  it("appends style to the prompt, because the API has no style parameter", async () => {
    const { provider, fetch } = providerWith([jsonResponse(IMAGE_RESPONSE)]);

    await provider.generate(
      { prompt: "a harbour", style: "flat vector illustration" },
      { model_ref: "gpt-image-2" },
    );

    expect(bodyOf(fetch.calls[0])).toMatchObject({
      prompt: "a harbour\n\nStyle: flat vector illustration",
    });
  });

  it("sends the key as an api-key header, never as a bearer token", async () => {
    const { provider, fetch } = providerWith([jsonResponse(IMAGE_RESPONSE)]);

    await provider.generate({ prompt: "x" }, { model_ref: "gpt-image-2" });

    expect(fetch.calls[0]?.init.headers).toEqual({
      "api-key": API_KEY,
      Accept: "application/json",
      "Content-Type": "application/json",
    });
  });

  it("sends an Entra token as a bearer header, never as api-key", async () => {
    const fetch = recordingFetch([jsonResponse(IMAGE_RESPONSE)]);
    const provider = new AzureProvider({
      endpoint: ENDPOINT,
      auth: "entra",
      deployments: DEPLOYMENTS,
      getAccessToken: () => Promise.resolve("entra-token"),
      fetch: fetch.impl,
    });

    await provider.generate({ prompt: "x" }, { model_ref: "gpt-image-2" });

    expect(fetch.calls[0]?.init.headers).toEqual({
      Authorization: "Bearer entra-token",
      Accept: "application/json",
      "Content-Type": "application/json",
    });
  });

  it("honours a configured api_version and a trailing slash on the endpoint", async () => {
    const fetch = recordingFetch([jsonResponse(IMAGE_RESPONSE)]);
    const provider = new AzureProvider({
      endpoint: `${ENDPOINT}/`,
      apiVersion: "2026-01-01",
      auth: "api_key",
      apiKey: API_KEY,
      deployments: DEPLOYMENTS,
      fetch: fetch.impl,
    });

    await provider.generate({ prompt: "x" }, { model_ref: "gpt-image-2" });

    expect(fetch.calls[0]?.url).toBe(
      "https://my-resource.openai.azure.com/openai/deployments/my-gpt-image-2/images/generations?api-version=2026-01-01",
    );
  });

  it("uses the single configured deployment when no model was resolved", async () => {
    const { provider, fetch } = providerWith([jsonResponse(IMAGE_RESPONSE)]);

    const result = await provider.generate({ prompt: "x" });

    expect(fetch.calls[0]?.url).toContain("/deployments/my-gpt-image-2/");
    expect(result.model).toBe("gpt-image-2");
  });
});

const MAI_DEPLOYMENTS = {
  "mai-image-2.6": { deployment: "mai-image-2-6", dialect: "mai" },
} as const;

function maiProviderWith(responses: Response[], options: Record<string, unknown> = {}) {
  const fetch = recordingFetch(responses);
  const provider = new AzureProvider({
    endpoint: ENDPOINT,
    auth: "api_key",
    apiKey: API_KEY,
    deployments: MAI_DEPLOYMENTS,
    fetch: fetch.impl,
    ...options,
  });
  return { provider, fetch };
}

describe("Azure request shape — generate, mai dialect", () => {
  it("puts the deployment in the body as model and never in the path", async () => {
    const { provider, fetch } = maiProviderWith([jsonResponse(IMAGE_RESPONSE)]);

    await provider.generate(
      { prompt: "a red bicycle" },
      { model_ref: "mai-image-2.6" },
    );

    const url = new URL(String(fetch.calls[0]?.url));
    expect(url.pathname).toBe("/mai/v1/images/generations");
    expect(url.pathname).not.toContain("mai-image-2-6");
    expect(bodyOf(fetch.calls[0])["model"]).toBe("mai-image-2-6");
  });

  it("sends no api-version, in the query or anywhere else", async () => {
    const { provider, fetch } = maiProviderWith([jsonResponse(IMAGE_RESPONSE)]);

    await provider.generate({ prompt: "x" }, { model_ref: "mai-image-2.6" });

    const url = new URL(String(fetch.calls[0]?.url));
    expect(url.search).toBe("");
    expect(url.searchParams.get("api-version")).toBeNull();
    expect(bodyOf(fetch.calls[0])).not.toHaveProperty("api-version");
  });

  it("derives the services.ai.azure.com host from the configured endpoint", async () => {
    const { provider, fetch } = maiProviderWith([jsonResponse(IMAGE_RESPONSE)]);

    await provider.generate({ prompt: "x" }, { model_ref: "mai-image-2.6" });

    expect(fetch.calls[0]?.url).toBe(
      "https://my-resource.services.ai.azure.com/mai/v1/images/generations",
    );
  });

  it("lets a deployment override the host outright", async () => {
    const fetch = recordingFetch([jsonResponse(IMAGE_RESPONSE)]);
    const provider = new AzureProvider({
      endpoint: ENDPOINT,
      auth: "api_key",
      apiKey: API_KEY,
      deployments: {
        "mai-image-2.6": {
          deployment: "mai-image-2-6",
          dialect: "mai",
          endpoint: "https://elsewhere.services.ai.azure.com/",
        },
      },
      fetch: fetch.impl,
    });

    await provider.generate({ prompt: "x" }, { model_ref: "mai-image-2.6" });

    expect(fetch.calls[0]?.url).toBe(
      "https://elsewhere.services.ai.azure.com/mai/v1/images/generations",
    );
  });

  it("sends exactly model, prompt, width and height — no size, no n", async () => {
    const { provider, fetch } = maiProviderWith([jsonResponse(IMAGE_RESPONSE)]);

    await provider.generate(
      { prompt: "a red bicycle", size: "1024x1024" },
      { model_ref: "mai-image-2.6" },
    );

    expect(bodyOf(fetch.calls[0])).toEqual({
      model: "mai-image-2-6",
      prompt: "a red bicycle",
      width: 1024,
      height: 1024,
    });
  });

  it("sends width and height as integers, clamped into the pixel budget", async () => {
    const { provider, fetch } = maiProviderWith([
      jsonResponse(IMAGE_RESPONSE),
      jsonResponse(IMAGE_RESPONSE),
      jsonResponse(IMAGE_RESPONSE),
    ]);

    await provider.generate(
      { prompt: "one", size: "1536x1024" },
      { model_ref: "mai-image-2.6" },
    );
    await provider.generate(
      { prompt: "two", size: "auto" },
      { model_ref: "mai-image-2.6" },
    );
    await provider.generate({ prompt: "three" }, { model_ref: "mai-image-2.6" });

    for (const call of fetch.calls) {
      const body = bodyOf(call);
      const width = body["width"];
      const height = body["height"];
      expect(Number.isInteger(width)).toBe(true);
      expect(Number.isInteger(height)).toBe(true);
      expect(Number(width)).toBeGreaterThanOrEqual(768);
      expect(Number(height)).toBeGreaterThanOrEqual(768);
      expect(Number(width) * Number(height)).toBeLessThanOrEqual(1_048_576);
    }

    expect(bodyOf(fetch.calls[0])).toMatchObject({ width: 1248, height: 832 });
    expect(bodyOf(fetch.calls[1])).toMatchObject({ width: 1024, height: 1024 });
    expect(bodyOf(fetch.calls[2])).toMatchObject({ width: 1024, height: 1024 });
  });

  it("appends style to the prompt here too", async () => {
    const { provider, fetch } = maiProviderWith([jsonResponse(IMAGE_RESPONSE)]);

    await provider.generate(
      { prompt: "a harbour", style: "flat vector illustration" },
      { model_ref: "mai-image-2.6" },
    );

    expect(bodyOf(fetch.calls[0])).toMatchObject({
      prompt: "a harbour\n\nStyle: flat vector illustration",
    });
  });

  it("sends the key as an api-key header, exactly as the other dialect does", async () => {
    const { provider, fetch } = maiProviderWith([jsonResponse(IMAGE_RESPONSE)]);

    await provider.generate({ prompt: "x" }, { model_ref: "mai-image-2.6" });

    expect(fetch.calls[0]?.init.headers).toEqual({
      "api-key": API_KEY,
      Accept: "application/json",
      "Content-Type": "application/json",
    });
  });

  it("asks the token provider for the cognitiveservices scope, not ai.azure.com", async () => {
    const fetch = recordingFetch([jsonResponse(IMAGE_RESPONSE)]);
    const scopes: string[] = [];
    const provider = new AzureProvider({
      endpoint: ENDPOINT,
      auth: "entra",
      deployments: {
        ...MAI_DEPLOYMENTS,
        "gpt-image-2": "my-gpt-image-2",
      },
      getAccessToken: (scope: string) => {
        scopes.push(scope);
        return Promise.resolve("entra-token");
      },
      fetch: fetch.impl,
    });

    await provider.generate({ prompt: "x" }, { model_ref: "mai-image-2.6" });

    expect(scopes).toEqual([AZURE_MAI_ENTRA_SCOPE]);
    expect(AZURE_MAI_ENTRA_SCOPE).toBe("https://cognitiveservices.azure.com/.default");
    expect(fetch.calls[0]?.init.headers).toMatchObject({
      Authorization: "Bearer entra-token",
    });
  });

  it("keeps the ai.azure.com scope for the openai dialect on the same adapter", async () => {
    const fetch = recordingFetch([jsonResponse(IMAGE_RESPONSE)]);
    const scopes: string[] = [];
    const provider = new AzureProvider({
      endpoint: ENDPOINT,
      auth: "entra",
      deployments: {
        ...MAI_DEPLOYMENTS,
        "gpt-image-2": "my-gpt-image-2",
      },
      getAccessToken: (scope: string) => {
        scopes.push(scope);
        return Promise.resolve("entra-token");
      },
      fetch: fetch.impl,
    });

    await provider.generate({ prompt: "x" }, { model_ref: "gpt-image-2" });

    expect(scopes).toEqual([AZURE_ENTRA_SCOPE]);
    expect(AZURE_ENTRA_SCOPE).toBe("https://ai.azure.com/.default");
  });

  it("reports the size the PNG header actually carries, not the one asked for", async () => {
    const { provider, fetch } = maiProviderWith([
      jsonResponse({ data: [{ b64_json: pngBase64(1248, 832) }] }),
    ]);

    const result = await provider.generate(
      { prompt: "x", size: "1536x1024" },
      { model_ref: "mai-image-2.6" },
    );

    expect(fetch.calls).toHaveLength(1);
    expect(result.width).toBe(1248);
    expect(result.height).toBe(832);
    expect(result.model).toBe("mai-image-2.6");
  });
});

describe("Azure request shape — model discovery", () => {
  it("reports the configured deployments without touching the network", async () => {
    const fetch = recordingFetch([]);
    const provider = new AzureProvider({
      endpoint: ENDPOINT,
      auth: "api_key",
      apiKey: API_KEY,
      deployments: {
        "gpt-image-2": "my-gpt-image-2",
        "mai-image-2.6": { deployment: "mai-image-2-6", dialect: "mai" },
      },
      fetch: fetch.impl,
    });

    const models = await provider.listModels();

    expect(fetch.calls).toHaveLength(0);
    expect(models).toEqual([
      {
        id: "gpt-image-2",
        display_name: "gpt-image-2",
        capabilities: {
          deployment: "my-gpt-image-2",
          dialect: "openai",
          api_version: "2025-04-01-preview",
          source: "config",
          note: 'Served by the Azure deployment "my-gpt-image-2", as configured in providers.azure.deployments.',
        },
      },
      {
        id: "mai-image-2.6",
        display_name: "mai-image-2.6",
        capabilities: {
          deployment: "mai-image-2-6",
          dialect: "mai",
          source: "config",
          note: 'Served by the Azure deployment "mai-image-2-6", as configured in providers.azure.deployments.',
        },
      },
    ]);
  });
});
