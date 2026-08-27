import { describe, expect, it } from "vitest";
import { ImagineError, type FailureReason } from "../../src/core/errors.js";
import { AzureProvider, type FetchLike } from "../../src/providers/azure.js";

const ENDPOINT = "https://my-resource.openai.azure.com";
const API_KEY = "azure-test-key";
const DEPLOYMENTS = { "gpt-image-2": "my-gpt-image-2" };

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

function provider(fetch: FetchLike) {
  return new AzureProvider({
    endpoint: ENDPOINT,
    auth: "api_key",
    apiKey: API_KEY,
    deployments: DEPLOYMENTS,
    fetch,
  });
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

describe("AzureProvider.isConfigured", () => {
  const complete = {
    enabled: true,
    endpoint: ENDPOINT,
    auth: "api_key",
    apiKey: API_KEY,
    deployments: DEPLOYMENTS,
  } as const;

  it("needs enabled, an endpoint, a credential and a deployment", () => {
    expect(new AzureProvider(complete).isConfigured()).toBe(true);
    expect(new AzureProvider({ ...complete, enabled: false }).isConfigured()).toBe(
      false,
    );
    expect(new AzureProvider({ ...complete, endpoint: null }).isConfigured()).toBe(
      false,
    );
    expect(new AzureProvider({ ...complete, apiKey: null }).isConfigured()).toBe(false);
    expect(new AzureProvider({ ...complete, deployments: {} }).isConfigured()).toBe(
      false,
    );
  });

  it("counts a token provider as the credential in entra mode", () => {
    const withoutToken = new AzureProvider({
      ...complete,
      auth: "entra",
      apiKey: null,
    });
    const withToken = new AzureProvider({
      ...complete,
      auth: "entra",
      apiKey: null,
      getAccessToken: () => Promise.resolve("token"),
    });

    expect(withoutToken.isConfigured()).toBe(false);
    expect(withToken.isConfigured()).toBe(true);
  });
});

describe("AzureProvider deployment mapping", () => {
  it("names the config key to add when a model has no deployment", async () => {
    const error = await failureOf(
      provider(failingWith(new Error("must not be called"))).generate(
        { prompt: "x" },
        { model_ref: "flux-2-pro" },
      ),
    );

    expect(error.reason).toBe("invalid_request");
    expect(error.message).toContain('providers.azure.deployments["flux-2-pro"]');
    expect(error.message).toContain("gpt-image-2");
  });

  it("refuses to guess when no deployment is configured at all", async () => {
    const empty = new AzureProvider({
      endpoint: ENDPOINT,
      auth: "api_key",
      apiKey: API_KEY,
      deployments: {},
      fetch: failingWith(new Error("must not be called")),
    });

    const error = await failureOf(empty.generate({ prompt: "x" }));

    expect(error.reason).toBe("invalid_request");
    expect(error.message).toContain("providers.azure.deployments");
  });

  it("refuses to guess between several deployments without a resolved model", async () => {
    const several = new AzureProvider({
      endpoint: ENDPOINT,
      auth: "api_key",
      apiKey: API_KEY,
      deployments: { "gpt-image-2": "a", "gemini-3.1-flash-image": "b" },
      fetch: failingWith(new Error("must not be called")),
    });

    const error = await failureOf(several.generate({ prompt: "x" }));

    expect(error.reason).toBe("invalid_request");
    expect(error.message).toContain("gpt-image-2");
    expect(error.message).toContain("model_ref");
  });
});

describe("AzureProvider.generate", () => {
  const body = { created: 1, data: [{ b64_json: pngBase64(1536, 1024) }] };

  it("decodes the image and reports the curated model id", async () => {
    const result = await provider(respondingWith(jsonResponse(body))).generate(
      { prompt: "x", size: "1536x1024" },
      { model_ref: "gpt-image-2" },
    );

    expect(result.provider).toBe("azure");
    expect(result.model).toBe("gpt-image-2");
    expect(result.mime_type).toBe("image/png");
    expect(result.width).toBe(1536);
    expect(result.height).toBe(1024);
    expect(result.bytes.length).toBeGreaterThan(0);
  });

  it("reports no cost, because Azure prices nothing in the response", async () => {
    const result = await provider(respondingWith(jsonResponse(body))).generate(
      { prompt: "x" },
      { model_ref: "gpt-image-2" },
    );

    expect(result.cost_usd).toBeNull();
  });

  it("fails when the response carries no image", async () => {
    const error = await failureOf(
      provider(respondingWith(jsonResponse({ created: 1, data: [] }))).generate(
        { prompt: "x" },
        { model_ref: "gpt-image-2" },
      ),
    );

    expect(error.reason).toBe("unknown");
    expect(error.billed).toBe(false);
  });
});

describe("AzureProvider authentication", () => {
  it("fails with auth_failed before the network when no key is set", async () => {
    const unconfigured = new AzureProvider({
      endpoint: ENDPOINT,
      auth: "api_key",
      apiKey: null,
      deployments: DEPLOYMENTS,
      fetch: failingWith(new Error("must not be called")),
    });

    const error = await failureOf(unconfigured.generate({ prompt: "x" }));

    expect(error.reason).toBe("auth_failed");
    expect(error.message).toContain("AZURE_OPENAI_API_KEY");
  });

  it("fails with auth_failed when entra mode has no token provider", async () => {
    const unconfigured = new AzureProvider({
      endpoint: ENDPOINT,
      auth: "entra",
      deployments: DEPLOYMENTS,
      fetch: failingWith(new Error("must not be called")),
    });

    const error = await failureOf(unconfigured.generate({ prompt: "x" }));

    expect(error.reason).toBe("auth_failed");
    expect(error.message).toContain("https://ai.azure.com/.default");
  });

  it("passes an ImagineError from the token provider through unchanged", async () => {
    const failing = new AzureProvider({
      endpoint: ENDPOINT,
      auth: "entra",
      deployments: DEPLOYMENTS,
      getAccessToken: () =>
        Promise.reject(new ImagineError("auth_failed", "see issue #23")),
      fetch: failingWith(new Error("must not be called")),
    });

    const error = await failureOf(failing.generate({ prompt: "x" }));

    expect(error.reason).toBe("auth_failed");
    expect(error.message).toBe("see issue #23");
  });

  it("wraps any other token-provider failure as auth_failed", async () => {
    const failing = new AzureProvider({
      endpoint: ENDPOINT,
      auth: "entra",
      deployments: DEPLOYMENTS,
      getAccessToken: () => Promise.reject(new Error("no managed identity")),
      fetch: failingWith(new Error("must not be called")),
    });

    const error = await failureOf(failing.generate({ prompt: "x" }));

    expect(error.reason).toBe("auth_failed");
    expect(error.message).toContain("no managed identity");
  });

  it("fails with invalid_request when no endpoint is configured", async () => {
    const noEndpoint = new AzureProvider({
      auth: "api_key",
      apiKey: API_KEY,
      deployments: DEPLOYMENTS,
      fetch: failingWith(new Error("must not be called")),
    });

    const error = await failureOf(noEndpoint.generate({ prompt: "x" }));

    expect(error.reason).toBe("invalid_request");
    expect(error.message).toContain("providers.azure.endpoint");
  });
});

describe("AzureProvider error mapping", () => {
  const cases: ReadonlyArray<{
    status: number;
    reason: FailureReason;
    retryable: boolean;
  }> = [
    { status: 400, reason: "invalid_request", retryable: false },
    { status: 401, reason: "auth_failed", retryable: false },
    { status: 403, reason: "auth_failed", retryable: false },
    { status: 404, reason: "provider_unavailable", retryable: false },
    { status: 408, reason: "timeout", retryable: true },
    { status: 422, reason: "invalid_request", retryable: false },
    { status: 429, reason: "rate_limited", retryable: true },
    { status: 500, reason: "provider_unavailable", retryable: true },
    { status: 504, reason: "timeout", retryable: true },
    { status: 418, reason: "unknown", retryable: false },
  ];

  for (const expected of cases) {
    it(`maps ${expected.status} to ${expected.reason}`, async () => {
      const response = jsonResponse(
        { error: { code: "Something", message: "went wrong" } },
        expected.status,
      );

      const error = await failureOf(
        provider(respondingWith(response)).generate(
          { prompt: "x" },
          { model_ref: "gpt-image-2" },
        ),
      );

      expect(error.reason).toBe(expected.reason);
      expect(error.retryable).toBe(expected.retryable);
      expect(error.billed).toBe(false);
      expect(error.message).toContain("went wrong");
    });
  }

  it("says a wrong deployment name is the usual cause of a 404", async () => {
    const error = await failureOf(
      provider(
        respondingWith(
          jsonResponse(
            { error: { code: "DeploymentNotFound", message: "not found" } },
            404,
          ),
        ),
      ).generate({ prompt: "x" }, { model_ref: "gpt-image-2" }),
    );

    expect(error.message).toContain("my-gpt-image-2");
    expect(error.message).toContain("providers.azure.deployments");
  });

  it("reads a content filter out of Azure's own error code", async () => {
    const error = await failureOf(
      provider(
        respondingWith(
          jsonResponse(
            {
              error: {
                code: "content_policy_violation",
                message: "Your request was rejected.",
              },
            },
            400,
          ),
        ),
      ).generate({ prompt: "x" }, { model_ref: "gpt-image-2" }),
    );

    expect(error.reason).toBe("content_filtered");
    expect(error.retryable).toBe(false);
  });

  it("reads a content filter out of the innererror code", async () => {
    const error = await failureOf(
      provider(
        respondingWith(
          jsonResponse(
            {
              error: {
                code: "BadRequest",
                message: "The request was rejected.",
                innererror: { code: "ResponsibleAIPolicyViolation" },
              },
            },
            400,
          ),
        ),
      ).generate({ prompt: "x" }, { model_ref: "gpt-image-2" }),
    );

    expect(error.reason).toBe("content_filtered");
  });

  it("maps a timeout and a transport failure apart", async () => {
    const timedOut = await failureOf(
      provider(failingWith(named("TimeoutError"))).generate(
        { prompt: "x" },
        { model_ref: "gpt-image-2" },
      ),
    );
    const unreachable = await failureOf(
      provider(failingWith(new Error("ECONNREFUSED"))).generate(
        { prompt: "x" },
        { model_ref: "gpt-image-2" },
      ),
    );

    expect(timedOut.reason).toBe("timeout");
    expect(timedOut.retryable).toBe(true);
    expect(unreachable.reason).toBe("provider_unavailable");
    expect(unreachable.retryable).toBe(true);
  });

  it("reports a non-JSON body rather than pretending it parsed", async () => {
    const error = await failureOf(
      provider(respondingWith(new Response("<html>gateway</html>"))).generate(
        { prompt: "x" },
        { model_ref: "gpt-image-2" },
      ),
    );

    expect(error.reason).toBe("unknown");
    expect(error.message).toContain("gateway");
  });
});

function named(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}
