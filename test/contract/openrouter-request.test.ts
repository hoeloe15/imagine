/**
 * What goes on the wire. These assertions are deliberately exact: the whole
 * reason for hand-written adapters (research §5) is that a routing library got
 * the request shape wrong, so the shape is pinned here rather than described.
 */

import { describe, expect, it } from "vitest";
import { OpenRouterProvider, type FetchLike } from "../../src/providers/openrouter.js";

const API_KEY = "sk-or-test-key";

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

/** A PNG header is enough: the adapter reads dimensions out of IHDR. */
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

const IMAGE_RESPONSE = {
  data: [{ b64_json: pngBase64(1024, 1024), media_type: "image/png" }],
  usage: { cost: 0.039 },
};

function providerWith(responses: Response[]) {
  const fetch = recordingFetch(responses);
  const provider = new OpenRouterProvider({ apiKey: API_KEY, fetch: fetch.impl });
  return { provider, fetch };
}

describe("OpenRouter request shape — generate", () => {
  it("posts model, prompt and size to /api/v1/images with a bearer key", async () => {
    const { provider, fetch } = providerWith([jsonResponse(IMAGE_RESPONSE)]);

    await provider.generate({ prompt: "a red bicycle", size: "1536x1024" });

    expect(fetch.calls).toHaveLength(1);
    const call = fetch.calls[0];
    expect(call?.url).toBe("https://openrouter.ai/api/v1/images");
    expect(call?.init.method).toBe("POST");
    expect(call?.init.headers).toEqual({
      Authorization: `Bearer ${API_KEY}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/hoeloe15/imagine",
      "X-Title": "imagine",
    });
    expect(JSON.parse(String(call?.init.body))).toEqual({
      model: "google/gemini-3.1-flash-image",
      prompt: "a red bicycle",
      size: "1536x1024",
    });
  });

  it("omits size entirely when the caller asked for auto or for nothing", async () => {
    const { provider, fetch } = providerWith([
      jsonResponse(IMAGE_RESPONSE),
      jsonResponse(IMAGE_RESPONSE),
    ]);

    await provider.generate({ prompt: "one", size: "auto" });
    await provider.generate({ prompt: "two" });

    for (const call of fetch.calls) {
      expect(JSON.parse(String(call.init.body))).not.toHaveProperty("size");
    }
  });

  it("appends style to the prompt, because the API has no style parameter", async () => {
    const { provider, fetch } = providerWith([jsonResponse(IMAGE_RESPONSE)]);

    await provider.generate({ prompt: "a harbour", style: "flat vector illustration" });

    expect(JSON.parse(String(fetch.calls[0]?.init.body))).toMatchObject({
      prompt: "a harbour\n\nStyle: flat vector illustration",
    });
  });

  it("sends the model the router resolved", async () => {
    const { provider, fetch } = providerWith([jsonResponse(IMAGE_RESPONSE)]);

    await provider.generate({ prompt: "x" }, { model_ref: "openai/gpt-image-2" });

    expect(JSON.parse(String(fetch.calls[0]?.init.body))).toMatchObject({
      model: "openai/gpt-image-2",
    });
  });

  it("never reads provider_hint as a model reference", async () => {
    const { provider, fetch } = providerWith([jsonResponse(IMAGE_RESPONSE)]);

    await provider.generate({ prompt: "x", provider_hint: "openai/gpt-image-2" });

    expect(JSON.parse(String(fetch.calls[0]?.init.body))).toMatchObject({
      model: "google/gemini-3.1-flash-image",
    });
  });

  it("uses the configured default model over the built-in one", async () => {
    const fetch = recordingFetch([jsonResponse(IMAGE_RESPONSE)]);
    const provider = new OpenRouterProvider({
      apiKey: API_KEY,
      fetch: fetch.impl,
      model: "black-forest-labs/flux-2-pro",
    });

    await provider.generate({ prompt: "x" });

    expect(JSON.parse(String(fetch.calls[0]?.init.body))).toMatchObject({
      model: "black-forest-labs/flux-2-pro",
    });
  });
});

describe("OpenRouter request shape — model discovery", () => {
  const MODELS = { data: [{ id: "google/gemini-3.1-flash-image", name: "Gemini" }] };

  it("gets /api/v1/images/models with no request body", async () => {
    const { provider, fetch } = providerWith([jsonResponse(MODELS)]);

    await provider.listModels();

    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]?.url).toBe("https://openrouter.ai/api/v1/images/models");
    expect(fetch.calls[0]?.init.method).toBe("GET");
    expect(fetch.calls[0]?.init.body).toBeUndefined();
    expect(fetch.calls[0]?.init.headers).toEqual({
      Authorization: `Bearer ${API_KEY}`,
      Accept: "application/json",
      "HTTP-Referer": "https://github.com/hoeloe15/imagine",
      "X-Title": "imagine",
    });
  });

  it("falls back to /api/v1/models?output_modalities=image", async () => {
    const { provider, fetch } = providerWith([
      jsonResponse({ error: { code: 404, message: "not found" } }, 404),
      jsonResponse(MODELS),
    ]);

    await provider.listModels();

    expect(fetch.calls.map((call) => call.url)).toEqual([
      "https://openrouter.ai/api/v1/images/models",
      "https://openrouter.ai/api/v1/models?output_modalities=image",
    ]);
  });
});
