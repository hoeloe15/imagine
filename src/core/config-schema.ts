/**
 * The config vocabulary, as two zod schemas over the same shape.
 *
 * `configFileSchema` describes what a *user writes*: every field optional, no
 * defaults, so a fragment can be merged without a file silently contributing
 * values its author never typed. `configSchema` describes the *merged* result
 * and is the only place defaults are applied. See ADR 0004.
 */

import { z } from "zod/v4";
import { USE_CASES, type ImageSize } from "./types.js";

const IMAGE_SIZES = [
  "1024x1024",
  "1536x1024",
  "1024x1536",
  "auto",
] as const satisfies readonly ImageSize[];

const size = z.enum(IMAGE_SIZES);
const useCase = z.enum(USE_CASES);
const auth = z.enum(["entra", "api_key"]);
const onExceed = z.enum(["refuse", "warn"]);
const logLevel = z.enum(["error", "warn", "info", "debug"]);

const envVarName = z
  .string()
  .regex(
    /^[A-Za-z_][A-Za-z0-9_]*$/,
    "expected the NAME of an environment variable (letters, digits and underscores), not a key value",
  );

const path = z.string().min(1, "expected a non-empty path");
const usd = z.number().positive("expected a positive amount in US dollars");

const providerFileSchema = z
  .strictObject({
    enabled: z.boolean(),
    api_key_env: envVarName.nullable(),
    endpoint: z.url("expected an absolute URL, e.g. https://example.openai.azure.com"),
    api_version: z.string().min(1),
    auth,
    deployments: z.record(z.string().min(1), z.string().min(1)),
  })
  .partial();

const providerSchema = z.strictObject({
  enabled: z.boolean().default(true),
  api_key_env: envVarName.nullable().default(null),
  endpoint: z.url().optional(),
  api_version: z.string().min(1).optional(),
  auth: auth.optional(),
  deployments: z.record(z.string().min(1), z.string().min(1)).optional(),
});

/** What a `config.json` on disk may contain. Everything is optional. */
export const configFileSchema = z
  .strictObject({
    $schema: z.string(),
    default: z
      .strictObject({
        model: z.string().min(1).nullable(),
        size,
        use_case: useCase.nullable(),
      })
      .partial(),
    providers: z.record(z.string().min(1), providerFileSchema),
    output: z
      .strictObject({ dir: path, filename: path, manifest: path.nullable() })
      .partial(),
    budget: z
      .strictObject({
        max_usd_per_session: usd.nullable(),
        max_usd_per_day: usd.nullable(),
        on_exceed: onExceed,
      })
      .partial(),
    logging: z.strictObject({ level: logLevel, cost_log: path.nullable() }).partial(),
  })
  .partial();

/** The merged configuration, after defaults and cross-field checks. */
export const configSchema = z
  .strictObject({
    default: z.strictObject({
      model: z.string().min(1).nullable(),
      size,
      use_case: useCase.nullable(),
    }),
    providers: z.record(z.string().min(1), providerSchema),
    output: z.strictObject({
      dir: path,
      filename: path,
      manifest: path.nullable(),
    }),
    budget: z.strictObject({
      max_usd_per_session: usd.nullable(),
      max_usd_per_day: usd.nullable(),
      on_exceed: onExceed,
    }),
    logging: z.strictObject({ level: logLevel, cost_log: path.nullable() }),
  })
  .superRefine((value, ctx) => {
    for (const [id, provider] of Object.entries(value.providers)) {
      if (!provider.enabled) continue;

      if (provider.auth === "entra") {
        if (!provider.endpoint) {
          ctx.addIssue({
            code: "custom",
            path: ["providers", id, "endpoint"],
            message: `required: provider "${id}" uses Entra authentication, which needs the resource endpoint`,
          });
        }
        continue;
      }

      if (!provider.api_key_env) {
        ctx.addIssue({
          code: "custom",
          path: ["providers", id, "api_key_env"],
          message: `required: provider "${id}" is enabled, so it needs the name of the environment variable holding its key (or "auth": "entra")`,
        });
      }
    }
  });

/**
 * The published JSON Schema for a `config.json`, kept in step with
 * {@link configFileSchema} by generation rather than by hand. `schema/
 * config.schema.json` is this value; a unit test fails if the two drift.
 */
export function configJsonSchema(): Record<string, unknown> {
  const { $schema, ...rest } = z.toJSONSchema(configFileSchema, {
    io: "input",
  });
  return {
    $schema,
    $id: "https://raw.githubusercontent.com/hoeloe15/imagine/main/schema/config.schema.json",
    title: "imagine configuration",
    description:
      "Configuration for the imagine MCP server. API keys are never stored here: api_key_env names the environment variable holding the key.",
    ...rest,
  };
}

export type ConfigFile = z.infer<typeof configFileSchema>;
export type Config = z.infer<typeof configSchema>;
export type ProviderConfig = Config["providers"][string];
export type LogLevel = z.infer<typeof logLevel>;
export type OnBudgetExceeded = z.infer<typeof onExceed>;
export type ProviderAuth = z.infer<typeof auth>;

/**
 * The zero-config baseline: OpenRouter on, everything else off but named, so a
 * user only has to flip `enabled` rather than remember the env var name.
 */
export const DEFAULT_CONFIG: Config = configSchema.parse({
  default: { model: null, size: "1024x1024", use_case: null },
  providers: {
    openrouter: { enabled: true, api_key_env: "OPENROUTER_API_KEY" },
    azure: { enabled: false, api_key_env: "AZURE_OPENAI_API_KEY" },
    google: { enabled: false, api_key_env: "GOOGLE_API_KEY" },
    xai: { enabled: false, api_key_env: "XAI_API_KEY" },
  },
  output: {
    dir: "./imagine-output",
    filename: "{slug}-{hash}.{ext}",
    manifest: "./imagine-output/manifest.jsonl",
  },
  budget: {
    max_usd_per_session: 5,
    max_usd_per_day: 10,
    on_exceed: "refuse",
  },
  logging: { level: "info", cost_log: "./imagine-output/costs.jsonl" },
});
