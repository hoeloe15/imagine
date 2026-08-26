import { describe, expect, it } from "vitest";
import { ImagineError, type FailureReason } from "../../src/core/errors.js";
import {
  OpenRouterProvider,
  imageDimensions,
  type FetchLike,
} from "../../src/providers/openrouter.js";

const API_KEY = "sk-or-test-key";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function respondingWith(...responses: Response[]): FetchLike {
  const queue = [...responses];
  return (input) => {
    const next = queue.shift();
    if (!next) throw new Error(`unexpected fetch call to ${String(input)}`);
    return Promise.resolve(next);
  };
}

function failingWith(cause: unknown): FetchLike {
  return () => Promise.reject(cause);
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

function provider(fetch: FetchLike, apiKey: string | null = API_KEY) {
  return new OpenRouterProvider({ apiKey, fetch });
}

async function failureOf(promise: Promise<unknown>): Promise<ImagineError> {
  try {
    await promise;
  } catch (cause) {
    if (cause instanceof ImagineError) return cause;
    throw cause;
  }
  throw new Error("expected the call to fail");
}

describe("OpenRouterProvider.isConfigured", () => {
  it("is configured only with a non-empty key", () => {
    expect(provider(respondingWith(), null).isConfigured()).toBe(false);
    expect(provider(respondingWith(), "").isConfigured()).toBe(false);
    expect(provider(respondingWith()).isConfigured()).toBe(true);
  });

  it("fails with auth_failed before touching the network when unconfigured", async () => {
    const unconfigured = new OpenRouterProvider({
      apiKey: null,
      fetch: failingWith(new Error("must not be called")),
    });

    const error = await failureOf(unconfigured.generate({ prompt: "x" }));

    expect(error.reason).toBe("auth_failed");
    expect(error.retryable).toBe(false);
    expect(error.billed).toBe(false);
  });
});

describe("OpenRouterProvider.generate", () => {
  const body = {
    data: [{ b64_json: pngBase64(1536, 1024), media_type: "image/png" }],
    usage: { cost: 0.039 },
  };

  it("decodes base64 into bytes and reports the provider's cost", async () => {
    const result = await provider(respondingWith(jsonResponse(body))).generate({
      prompt: "a red bicycle",
    });

    expect(result.bytes).toBeInstanceOf(Uint8Array);
    expect([...result.bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(result.mime_type).toBe("image/png");
    expect(result.provider).toBe("openrouter");
    expect(result.model).toBe("google/gemini-3.1-flash-image");
    expect(result.cost_usd).toBe(0.039);
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("reports the dimensions actually produced, not the ones requested", async () => {
    const result = await provider(respondingWith(jsonResponse(body))).generate({
      prompt: "x",
      size: "1024x1024",
    });

    expect(result.width).toBe(1536);
    expect(result.height).toBe(1024);
  });

  it("prefers dimensions the response states over the ones in the bytes", async () => {
    const stated = {
      data: [
        { b64_json: pngBase64(8, 8), media_type: "image/png", width: 64, height: 32 },
      ],
    };

    const result = await provider(respondingWith(jsonResponse(stated))).generate({
      prompt: "x",
    });

    expect([result.width, result.height]).toEqual([64, 32]);
  });

  it("falls back to the requested size when the bytes carry no readable header", async () => {
    const opaque = {
      data: [{ b64_json: Buffer.from("not an image").toString("base64") }],
    };

    const result = await provider(respondingWith(jsonResponse(opaque))).generate({
      prompt: "x",
      size: "1024x1536",
    });

    expect([result.width, result.height]).toEqual([1024, 1536]);
  });

  it("reports a null cost when the response carries no usage", async () => {
    const withoutUsage = { data: [{ b64_json: pngBase64(1024, 1024) }] };

    const result = await provider(respondingWith(jsonResponse(withoutUsage))).generate({
      prompt: "x",
    });

    expect(result.cost_usd).toBeNull();
    expect(result.mime_type).toBe("image/png");
  });

  it("echoes the model the response names, which may differ from the one asked for", async () => {
    const routed = { ...body, model: "google/gemini-3.1-flash-image:free" };

    const result = await provider(respondingWith(jsonResponse(routed))).generate({
      prompt: "x",
    });

    expect(result.model).toBe("google/gemini-3.1-flash-image:free");
  });

  it("fails rather than returning an empty image", async () => {
    const empty = { data: [], usage: { cost: 0 } };

    const error = await failureOf(
      provider(respondingWith(jsonResponse(empty))).generate({ prompt: "x" }),
    );

    expect(error.reason).toBe("unknown");
    expect(error.retryable).toBe(false);
    expect(error.billed).toBe(false);
  });

  it("treats a 200 body that reports an error as that error", async () => {
    const embedded = { error: { code: 429, message: "rate limit exceeded" } };

    const error = await failureOf(
      provider(respondingWith(jsonResponse(embedded))).generate({ prompt: "x" }),
    );

    expect(error.reason).toBe("rate_limited");
    expect(error.retryable).toBe(true);
  });
});

describe("OpenRouterProvider error mapping", () => {
  const cases: ReadonlyArray<{
    status: number;
    message: string;
    reason: FailureReason;
    retryable: boolean;
  }> = [
    {
      status: 400,
      message: "prompt is required",
      reason: "invalid_request",
      retryable: false,
    },
    {
      status: 400,
      message: "Your prompt violates the content policy",
      reason: "content_filtered",
      retryable: false,
    },
    {
      status: 401,
      message: "No auth credentials found",
      reason: "auth_failed",
      retryable: false,
    },
    {
      status: 402,
      message: "Insufficient credits",
      reason: "auth_failed",
      retryable: false,
    },
    {
      status: 403,
      message: "flagged by moderation",
      reason: "content_filtered",
      retryable: false,
    },
    {
      status: 404,
      message: "No endpoints found",
      reason: "provider_unavailable",
      retryable: false,
    },
    { status: 408, message: "Request timed out", reason: "timeout", retryable: true },
    {
      status: 422,
      message: "unsupported size",
      reason: "invalid_request",
      retryable: false,
    },
    {
      status: 429,
      message: "Rate limit exceeded",
      reason: "rate_limited",
      retryable: true,
    },
    {
      status: 500,
      message: "internal error",
      reason: "provider_unavailable",
      retryable: true,
    },
    {
      status: 502,
      message: "upstream failed",
      reason: "provider_unavailable",
      retryable: true,
    },
    {
      status: 503,
      message: "overloaded",
      reason: "provider_unavailable",
      retryable: true,
    },
    { status: 504, message: "gateway timeout", reason: "timeout", retryable: true },
  ];

  for (const testCase of cases) {
    it(`maps ${testCase.status} "${testCase.message}" to ${testCase.reason}`, async () => {
      const response = jsonResponse(
        { error: { code: testCase.status, message: testCase.message } },
        testCase.status,
      );

      const error = await failureOf(
        provider(respondingWith(response)).generate({ prompt: "x" }),
      );

      expect(error.reason).toBe(testCase.reason);
      expect(error.retryable).toBe(testCase.retryable);
      expect(error.billed).toBe(false);
      expect(error.message).toContain(testCase.message);
    });
  }

  it("surfaces moderation reasons from the error metadata", async () => {
    const response = jsonResponse(
      {
        error: {
          code: 403,
          message: "Input flagged",
          metadata: { reasons: ["violence", "minors"] },
        },
      },
      403,
    );

    const error = await failureOf(
      provider(respondingWith(response)).generate({ prompt: "x" }),
    );

    expect(error.reason).toBe("content_filtered");
    expect(error.message).toContain("violence, minors");
  });

  it("maps a non-JSON error body without losing the status", async () => {
    const response = new Response("<html>Bad Gateway</html>", { status: 502 });

    const error = await failureOf(
      provider(respondingWith(response)).generate({ prompt: "x" }),
    );

    expect(error.reason).toBe("provider_unavailable");
    expect(error.retryable).toBe(true);
    expect(error.message).toContain("502");
  });

  it("maps a transport failure to a retryable provider_unavailable", async () => {
    const error = await failureOf(
      provider(failingWith(new TypeError("fetch failed"))).generate({ prompt: "x" }),
    );

    expect(error.reason).toBe("provider_unavailable");
    expect(error.retryable).toBe(true);
  });

  it("maps an aborted request to a retryable timeout", async () => {
    const aborted = new Error("The operation timed out.");
    aborted.name = "TimeoutError";

    const error = await failureOf(
      provider(failingWith(aborted)).generate({ prompt: "x" }),
    );

    expect(error.reason).toBe("timeout");
    expect(error.retryable).toBe(true);
  });
});

describe("OpenRouterProvider.listModels", () => {
  it("maps discovered models, keeping the raw fields as capabilities", async () => {
    const response = jsonResponse({
      data: [
        {
          id: "google/gemini-3.1-flash-image",
          name: "Google: Gemini 3.1 Flash Image",
          pricing: { image: "0.039" },
          output_modalities: ["image"],
        },
        { name: "nameless models are skipped" },
      ],
    });

    const models = await provider(respondingWith(response)).listModels();

    expect(models).toEqual([
      {
        id: "google/gemini-3.1-flash-image",
        display_name: "Google: Gemini 3.1 Flash Image",
        capabilities: {
          pricing: { image: "0.039" },
          output_modalities: ["image"],
        },
      },
    ]);
  });

  it("falls back to the general catalogue when the image endpoint fails", async () => {
    const models = await provider(
      respondingWith(
        jsonResponse({ error: { code: 404, message: "not found" } }, 404),
        jsonResponse({ data: [{ id: "openai/gpt-image-2" }] }),
      ),
    ).listModels();

    expect(models.map((model) => model.id)).toEqual(["openai/gpt-image-2"]);
  });

  it("does not retry the fallback when the key itself is rejected", async () => {
    const error = await failureOf(
      provider(
        respondingWith(jsonResponse({ error: { code: 401, message: "no auth" } }, 401)),
      ).listModels(),
    );

    expect(error.reason).toBe("auth_failed");
  });
});

describe("imageDimensions", () => {
  it("reads PNG, GIF and WebP headers", () => {
    const png = Buffer.from(pngBase64(320, 240), "base64");
    expect(imageDimensions(new Uint8Array(png))).toEqual({ width: 320, height: 240 });

    const gif = new Uint8Array(10);
    gif.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0);
    new DataView(gif.buffer).setUint16(6, 200, true);
    new DataView(gif.buffer).setUint16(8, 100, true);
    expect(imageDimensions(gif)).toEqual({ width: 200, height: 100 });

    const webp = new Uint8Array(30);
    webp.set([0x52, 0x49, 0x46, 0x46], 0);
    webp.set([0x57, 0x45, 0x42, 0x50], 8);
    webp.set([0x56, 0x50, 0x38, 0x20], 12);
    new DataView(webp.buffer).setUint16(26, 512, true);
    new DataView(webp.buffer).setUint16(28, 256, true);
    expect(imageDimensions(webp)).toEqual({ width: 512, height: 256 });
  });

  it("reads a JPEG start-of-frame marker", () => {
    const jpeg = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08,
      0x02, 0x00, 0x04, 0x00, 0x03, 0x01, 0x22, 0x00,
    ]);

    expect(imageDimensions(jpeg)).toEqual({ width: 1024, height: 512 });
  });

  it("returns undefined for bytes it cannot read", () => {
    expect(imageDimensions(new Uint8Array([1, 2, 3, 4]))).toBeUndefined();
  });
});
