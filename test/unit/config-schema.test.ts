import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG,
  configFileSchema,
  configJsonSchema,
  configSchema,
} from "../../src/core/config-schema.js";

const publishedSchemaPath = fileURLToPath(
  new URL("../../schema/config.schema.json", import.meta.url),
);

describe("schema/config.schema.json", () => {
  it("is exactly what the zod file schema generates", () => {
    const published: unknown = JSON.parse(readFileSync(publishedSchemaPath, "utf8"));

    expect(published).toEqual(configJsonSchema());
  });

  it("advertises itself under the URL a config file points at", () => {
    expect(configJsonSchema().$id).toBe(
      "https://raw.githubusercontent.com/hoeloe15/imagine/main/schema/config.schema.json",
    );
  });
});

describe("the two schemas describe the same shape", () => {
  it("accepts the fully populated example from PLAN.md §7 as a file", () => {
    const example = {
      $schema:
        "https://raw.githubusercontent.com/hoeloe15/imagine/main/schema/config.schema.json",
      default: { model: "gemini-3.1-flash-image", size: "1024x1024" },
      providers: {
        openrouter: { enabled: true, api_key_env: "OPENROUTER_API_KEY" },
        azure: {
          enabled: true,
          endpoint: "https://my-resource.openai.azure.com",
          api_version: "2025-04-01-preview",
          auth: "entra",
          api_key_env: "AZURE_OPENAI_API_KEY",
          deployments: { "gpt-image-2": "my-gpt-image-2-deployment" },
        },
        google: { enabled: false, api_key_env: "GOOGLE_API_KEY" },
        xai: { enabled: false, api_key_env: "XAI_API_KEY" },
      },
      output: {
        dir: "./imagine-output",
        filename: "{slug}-{hash}.{ext}",
        manifest: "./imagine-output/manifest.jsonl",
      },
      budget: {
        max_usd_per_session: 5.0,
        max_usd_per_day: 10.0,
        on_exceed: "refuse",
      },
      logging: { level: "info", cost_log: "./imagine-output/costs.jsonl" },
    };

    expect(configFileSchema.safeParse(example).success).toBe(true);
  });

  it("applies no defaults when parsing a file fragment, so merging stays honest", () => {
    const parsed = configFileSchema.parse({ providers: { google: {} } });

    expect(parsed).toEqual({ providers: { google: {} } });
  });

  it("round-trips the built-in defaults", () => {
    expect(configSchema.parse(DEFAULT_CONFIG)).toEqual(DEFAULT_CONFIG);
  });
});
