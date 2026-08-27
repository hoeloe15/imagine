/**
 * Live checks against a real Azure OpenAI deployment. They cost real money and
 * are skipped entirely unless all three variables are set, so the default
 * `vitest run` never touches the network:
 *
 *   $env:AZURE_OPENAI_ENDPOINT   = "https://my-resource.openai.azure.com"
 *   $env:AZURE_OPENAI_API_KEY    = "…"
 *   $env:AZURE_OPENAI_DEPLOYMENT = "my-gpt-image-2"
 *   npx vitest run test/live/azure.test.ts
 *
 * `AZURE_OPENAI_API_VERSION` overrides the adapter's default. Entra is not
 * covered here: this build has no token provider for it (ADR 0014, issue #23).
 */

import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AzureProvider } from "../../src/providers/azure.js";

const endpoint = process.env["AZURE_OPENAI_ENDPOINT"];
const apiKey = process.env["AZURE_OPENAI_API_KEY"];
const deployment = process.env["AZURE_OPENAI_DEPLOYMENT"];
const apiVersion = process.env["AZURE_OPENAI_API_VERSION"];
const model = process.env["AZURE_OPENAI_MODEL"] ?? "gpt-image-2";

const live = endpoint && apiKey && deployment ? describe : describe.skip;

live("Azure OpenAI, live", () => {
  const provider = new AzureProvider({
    endpoint: endpoint ?? null,
    auth: "api_key",
    apiKey: apiKey ?? null,
    deployments: { [model]: deployment ?? "" },
    ...(apiVersion === undefined ? {} : { apiVersion }),
  });

  it("reports itself configured", () => {
    expect(provider.isConfigured()).toBe(true);
  });

  it("reports the configured deployment as its model", async () => {
    const models = await provider.listModels();

    expect(models.map((entry) => entry.id)).toContain(model);
  });

  it("generates an image and writes it to disk", async () => {
    const result = await provider.generate(
      {
        prompt: "a single flat-vector orange circle on a white background",
        size: "1024x1024",
      },
      { model_ref: model },
    );

    const directory = mkdtempSync(join(tmpdir(), "imagine-live-"));
    const path = join(directory, "azure-live.png");
    writeFileSync(path, result.bytes);

    expect(statSync(path).size).toBe(result.bytes.length);
    expect(result.bytes.length).toBeGreaterThan(1024);
    expect(result.mime_type).toMatch(/^image\//);
    expect(result.width).toBeGreaterThan(0);
    expect(result.height).toBeGreaterThan(0);
    expect(result.provider).toBe("azure");
    expect(result.model).toBe(model);

    console.log(`live image written to ${path}`);
  }, 180_000);
});
