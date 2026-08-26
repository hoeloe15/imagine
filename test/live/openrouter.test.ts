/**
 * Live checks against the real OpenRouter API. They cost real money (a few
 * cents) and are skipped entirely unless OPENROUTER_API_KEY is set, so the
 * default `vitest run` never touches the network.
 *
 *   $env:OPENROUTER_API_KEY = "sk-or-…"; npx vitest run test/live/openrouter.test.ts
 */

import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OpenRouterProvider } from "../../src/providers/openrouter.js";

const apiKey = process.env["OPENROUTER_API_KEY"];
const live = apiKey ? describe : describe.skip;

live("OpenRouter, live", () => {
  const provider = new OpenRouterProvider({ apiKey });

  it("reports itself configured", () => {
    expect(provider.isConfigured()).toBe(true);
  });

  it("discovers image models", async () => {
    const models = await provider.listModels();

    expect(models.length).toBeGreaterThan(0);
    expect(models[0]?.id).toMatch(/\//);
  });

  it("generates an image and writes it to disk", async () => {
    const result = await provider.generate({
      prompt: "a single flat-vector orange circle on a white background",
      size: "1024x1024",
    });

    const directory = mkdtempSync(join(tmpdir(), "imagine-live-"));
    const path = join(directory, "openrouter-live.png");
    writeFileSync(path, result.bytes);

    expect(statSync(path).size).toBe(result.bytes.length);
    expect(result.bytes.length).toBeGreaterThan(1024);
    expect(result.mime_type).toMatch(/^image\//);
    expect(result.width).toBeGreaterThan(0);
    expect(result.height).toBeGreaterThan(0);
    expect(result.cost_usd === null || result.cost_usd >= 0).toBe(true);

    console.log(`live image written to ${path} (${result.cost_usd ?? "unknown"} USD)`);
  }, 120_000);
});
