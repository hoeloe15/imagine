/**
 * The pieces of the MAI dialect that are worth testing away from the wire: the
 * size arithmetic, the host derivation, and how a deployments entry is read.
 * The wire shape itself is pinned in `test/contract/azure-request.test.ts`.
 */

import { describe, expect, it } from "vitest";
import {
  AZURE_ENTRA_SCOPE,
  AZURE_MAI_ENTRA_SCOPE,
  AzureProvider,
  MAI_MAX_AREA,
  MAI_MIN_SIDE,
  entraScopeFor,
  maiDimensions,
  maiHostFor,
} from "../../src/providers/azure.js";
import { configFileSchema } from "../../src/core/config-schema.js";

describe("maiDimensions", () => {
  it("passes the square through: 1024x1024 is exactly the budget", () => {
    expect(maiDimensions("1024x1024")).toEqual({ width: 1024, height: 1024 });
    expect(1024 * 1024).toBe(MAI_MAX_AREA);
  });

  it("shrinks a landscape request that does not fit, keeping the shape", () => {
    // 1536 x 1024 is 1,572,864 pixels — half again over the cap.
    expect(maiDimensions("1536x1024")).toEqual({ width: 1248, height: 832 });
  });

  it("shrinks the portrait request to the mirror image of the landscape one", () => {
    expect(maiDimensions("1024x1536")).toEqual({ width: 832, height: 1248 });
  });

  it("treats auto and an absent size as the square", () => {
    expect(maiDimensions("auto")).toEqual({ width: 1024, height: 1024 });
    expect(maiDimensions(undefined)).toEqual({ width: 1024, height: 1024 });
  });

  it("never leaves the documented envelope for any size the tool accepts", () => {
    for (const size of ["1024x1024", "1536x1024", "1024x1536", "auto"] as const) {
      const { width, height } = maiDimensions(size);

      expect(Number.isInteger(width)).toBe(true);
      expect(Number.isInteger(height)).toBe(true);
      expect(width).toBeGreaterThanOrEqual(MAI_MIN_SIDE);
      expect(height).toBeGreaterThanOrEqual(MAI_MIN_SIDE);
      expect(width * height).toBeLessThanOrEqual(MAI_MAX_AREA);
    }
  });
});

describe("maiHostFor", () => {
  it("swaps the Azure OpenAI host for the Foundry one, keeping the resource", () => {
    expect(maiHostFor("https://my-resource.openai.azure.com")).toBe(
      "https://my-resource.services.ai.azure.com",
    );
  });

  it("leaves a host that is already the Foundry one alone", () => {
    expect(maiHostFor("https://my-resource.services.ai.azure.com/")).toBe(
      "https://my-resource.services.ai.azure.com",
    );
  });

  it("swaps the cognitiveservices host too", () => {
    expect(maiHostFor("https://my-resource.cognitiveservices.azure.com")).toBe(
      "https://my-resource.services.ai.azure.com",
    );
  });

  it("hands back something unparseable unchanged rather than inventing a host", () => {
    expect(maiHostFor("not a url")).toBe("not a url");
  });
});

describe("entraScopeFor", () => {
  it("gives each dialect the audience its endpoint accepts", () => {
    expect(entraScopeFor("mai")).toBe(AZURE_MAI_ENTRA_SCOPE);
    expect(entraScopeFor("openai")).toBe(AZURE_ENTRA_SCOPE);
    expect(AZURE_MAI_ENTRA_SCOPE).not.toBe(AZURE_ENTRA_SCOPE);
  });
});

describe("reading a deployments entry", () => {
  function dialectsOf(deployments: Record<string, unknown>) {
    const provider = new AzureProvider({
      endpoint: "https://my-resource.openai.azure.com",
      auth: "api_key",
      apiKey: "azure-test-key",
      deployments: deployments as never,
    });
    return provider
      .listModels()
      .then((models) =>
        models.map((model) => [model.id, model.capabilities?.["dialect"]]),
      );
  }

  it("reads a bare string as the openai dialect, as every old config meant", async () => {
    expect(await dialectsOf({ "gpt-image-2": "my-gpt-image-2" })).toEqual([
      ["gpt-image-2", "openai"],
    ]);
  });

  it("defaults the object form to the openai dialect as well", async () => {
    expect(await dialectsOf({ "gpt-image-2": { deployment: "d" } })).toEqual([
      ["gpt-image-2", "openai"],
    ]);
  });

  it("reads an explicit dialect", async () => {
    expect(
      await dialectsOf({
        "gpt-image-2": "my-gpt-image-2",
        "mai-image-2.6": { deployment: "mai-image-2-6", dialect: "mai" },
      }),
    ).toEqual([
      ["gpt-image-2", "openai"],
      ["mai-image-2.6", "mai"],
    ]);
  });

  it("counts an object entry towards isConfigured just as a string does", () => {
    const provider = new AzureProvider({
      endpoint: "https://my-resource.openai.azure.com",
      auth: "api_key",
      apiKey: "azure-test-key",
      deployments: { "mai-image-2.6": { deployment: "d", dialect: "mai" } },
    });

    expect(provider.isConfigured()).toBe(true);
  });
});

describe("the config schema on deployments", () => {
  function parse(deployments: unknown) {
    return configFileSchema.safeParse({
      providers: { azure: { deployments } },
    });
  }

  it("accepts the string form and the object form side by side", () => {
    expect(
      parse({
        "gpt-image-2": "my-gpt-image-2",
        "mai-image-2.6": {
          deployment: "mai-image-2-6",
          dialect: "mai",
          endpoint: "https://my-resource.services.ai.azure.com",
        },
      }).success,
    ).toBe(true);
  });

  it("rejects a dialect nobody implements", () => {
    expect(parse({ x: { deployment: "d", dialect: "litellm" } }).success).toBe(false);
  });

  it("rejects an object with no deployment name", () => {
    expect(parse({ x: { dialect: "mai" } }).success).toBe(false);
  });

  it("rejects an unknown key rather than ignoring it", () => {
    expect(parse({ x: { deployment: "d", api_version: "2026-01-01" } }).success).toBe(
      false,
    );
  });

  it("rejects an endpoint that is not a URL", () => {
    expect(parse({ x: { deployment: "d", endpoint: "my-resource" } }).success).toBe(
      false,
    );
  });
});
