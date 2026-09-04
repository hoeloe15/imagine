/**
 * Live checks against a real MAI-Image deployment on Azure AI Foundry. They cost
 * real money and are skipped entirely unless the endpoint, a credential and a
 * deployment name are all set, so the default `vitest run` never touches the
 * network:
 *
 *   $env:AZURE_MAI_ENDPOINT   = "https://my-resource.services.ai.azure.com"
 *   $env:AZURE_MAI_API_KEY    = "…"
 *   $env:AZURE_MAI_DEPLOYMENT = "mai-image-2-6"
 *   npx vitest run test/live/azure-mai.test.ts
 *
 * `AZURE_MAI_ENDPOINT` may also be the Azure OpenAI host of the same resource —
 * the adapter derives the Foundry host from it. `AZURE_MAI_MODEL` overrides the
 * curated model id the deployment is registered under.
 *
 * Entra is not covered here: this file has no token provider. The quota on a
 * capacity-1 GlobalStandard deployment is a couple of requests per minute, so
 * expect a 429 if these run alongside anything else.
 */

import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AzureProvider } from "../../src/providers/azure.js";

const endpoint = process.env["AZURE_MAI_ENDPOINT"];
const apiKey = process.env["AZURE_MAI_API_KEY"];
const deployment = process.env["AZURE_MAI_DEPLOYMENT"];
const model = process.env["AZURE_MAI_MODEL"] ?? "mai-image-2.6";

const live = endpoint && apiKey && deployment ? describe : describe.skip;

live("Azure MAI-Image, live", () => {
  const provider = new AzureProvider({
    endpoint: endpoint ?? null,
    auth: "api_key",
    apiKey: apiKey ?? null,
    deployments: {
      [model]: { deployment: deployment ?? "", dialect: "mai" },
    },
  });

  it("reports itself configured", () => {
    expect(provider.isConfigured()).toBe(true);
  });

  it("reports the deployment as speaking the mai dialect", async () => {
    const models = await provider.listModels();

    expect(models).toMatchObject([{ id: model, capabilities: { dialect: "mai" } }]);
  });

  it("generates a square image and writes it to disk", async () => {
    const result = await provider.generate(
      {
        prompt: "a single flat-vector orange circle on a white background",
        size: "1024x1024",
      },
      { model_ref: model },
    );

    const directory = mkdtempSync(join(tmpdir(), "imagine-live-"));
    const path = join(directory, "azure-mai-live.png");
    writeFileSync(path, result.bytes);

    expect(statSync(path).size).toBe(result.bytes.length);
    expect(result.bytes.length).toBeGreaterThan(1024);
    /** MAI always answers PNG (`mai-image-2026-09.md` §1.4). */
    expect(result.mime_type).toBe("image/png");
    expect(result.width).toBe(1024);
    expect(result.height).toBe(1024);
    expect(result.provider).toBe("azure");
    expect(result.model).toBe(model);

    console.log(`live image written to ${path}`);
  }, 180_000);

  it("accepts a landscape request by shrinking it into the pixel budget", async () => {
    const result = await provider.generate(
      { prompt: "a wide empty beach at sunrise", size: "1536x1024" },
      { model_ref: model },
    );

    expect(result.width * result.height).toBeLessThanOrEqual(1_048_576);
    expect(result.width).toBeGreaterThan(result.height);
    expect(result.height).toBeGreaterThanOrEqual(768);
  }, 180_000);
});
