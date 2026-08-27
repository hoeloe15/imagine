import { describe, expect, it } from "vitest";
import { StubProvider } from "../../src/providers/stub.js";

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

describe("StubProvider", () => {
  it("reports itself configured under the id it was given", async () => {
    const provider = new StubProvider("stub-a");

    expect(provider.id).toBe("stub-a");
    expect(provider.isConfigured()).toBe(true);
    await expect(provider.listModels()).resolves.toHaveLength(1);
  });

  it("returns decoded bytes, never base64", async () => {
    const result = await new StubProvider().generate({ prompt: "a blue square" });

    expect(result.bytes).toBeInstanceOf(Uint8Array);
    expect([...result.bytes.slice(0, 4)]).toEqual(PNG_MAGIC);
    expect(result.mime_type).toBe("image/png");
  });

  it("reports the metadata the router and ledger need", async () => {
    const result = await new StubProvider().generate({ prompt: "a blue square" });

    expect(result.provider).toBe("stub");
    expect(result.model).toBe("stub-image-1");
    expect(result.cost_usd).toBe(0);
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    expect(result.width).toBe(1);
    expect(result.height).toBe(1);
  });

  it("reports the model the router resolved when it is given one", async () => {
    const result = await new StubProvider().generate(
      { prompt: "a blue square", provider_hint: "openrouter" },
      { model_ref: "google/gemini-3.1-flash-image" },
    );

    expect(result.model).toBe("google/gemini-3.1-flash-image");
  });
});
