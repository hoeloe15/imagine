/**
 * What goes on the wire to Azure OpenAI. These assertions are the point of the
 * hand-written adapter: the deployment name belongs in the URL path and must
 * never appear as `model` in the body — the exact mistake that broke LiteLLM
 * (research §2, §5, issue #9).
 */

import { describe, expect, it } from "vitest";
import { AzureProvider, type FetchLike } from "../../src/providers/azure.js";

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

describe("Azure request shape — model discovery", () => {
  it("reports the configured deployments without touching the network", async () => {
    const fetch = recordingFetch([]);
    const provider = new AzureProvider({
      endpoint: ENDPOINT,
      auth: "api_key",
      apiKey: API_KEY,
      deployments: { "gpt-image-2": "my-gpt-image-2" },
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
          api_version: "2025-04-01-preview",
          source: "config",
          note: 'Served by the Azure deployment "my-gpt-image-2", as configured in providers.azure.deployments.',
        },
      },
    ]);
  });
});
