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

/**
 * A Key Vault secret name, which is what Azure itself accepts: letters, digits
 * and hyphens, up to 127 characters. The regex is here for the same reason
 * `envVarName`'s is — most things a person could paste into this field by
 * accident become a validation error naming the field rather than a secret
 * sitting in a config file. It is not a perfect sieve, and does not claim to
 * be: a key made only of letters, digits and hyphens is a legal secret name.
 * See ADR 0004 and ADR 0026.
 */
const secretName = z
  .string()
  .regex(
    /^[A-Za-z0-9-]{1,127}$/,
    "expected the NAME of a Key Vault secret (letters, digits and hyphens), not a key value",
  );

const path = z.string().min(1, "expected a non-empty path");
const usd = z.number().positive("expected a positive amount in US dollars");
const sink = z.enum(["local", "blob"]);

const accountUrl = z.url(
  "expected an absolute URL, e.g. https://mystorage.blob.core.windows.net",
);
const containerName = z
  .string()
  .regex(
    /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/,
    "expected an Azure blob container name: 3 to 63 lowercase letters, digits and hyphens",
  );
/** A user delegation key is only valid for seven days, so neither is a URL. */
const urlTtlHours = z.number().int().min(1).max(168);

const blobFileSchema = z
  .strictObject({
    account_url: accountUrl,
    container: containerName,
    url_ttl_hours: urlTtlHours,
  })
  .partial();

const blobSchema = z.strictObject({
  account_url: accountUrl,
  container: containerName,
  url_ttl_hours: urlTtlHours.default(1),
});

const providerFileSchema = z
  .strictObject({
    enabled: z.boolean(),
    api_key_env: envVarName.nullable(),
    api_key_secret: secretName.nullable(),
    endpoint: z.url("expected an absolute URL, e.g. https://example.openai.azure.com"),
    api_version: z.string().min(1),
    auth,
    deployments: z.record(z.string().min(1), z.string().min(1)),
  })
  .partial();

const providerSchema = z.strictObject({
  enabled: z.boolean().default(true),
  api_key_env: envVarName.nullable().default(null),
  api_key_secret: secretName.nullable().default(null),
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
      .strictObject({
        dir: path,
        filename: path,
        manifest: path.nullable(),
        sink,
        blob: blobFileSchema.nullable(),
      })
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
      sink: sink.default("local"),
      blob: blobSchema.nullable().default(null),
    }),
    budget: z.strictObject({
      max_usd_per_session: usd.nullable(),
      max_usd_per_day: usd.nullable(),
      on_exceed: onExceed,
    }),
    logging: z.strictObject({ level: logLevel, cost_log: path.nullable() }),
  })
  .superRefine((value, ctx) => {
    if (value.output.sink === "blob" && value.output.blob === null) {
      ctx.addIssue({
        code: "custom",
        path: ["output", "blob"],
        message:
          'required: output.sink is "blob", so the account URL and container to upload to have to be named',
      });
    }

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

      if (!provider.api_key_env && !provider.api_key_secret) {
        ctx.addIssue({
          code: "custom",
          path: ["providers", id, "api_key_env"],
          message: `required: provider "${id}" is enabled, so it needs the name of the environment variable holding its key (or a Key Vault secret in api_key_secret, or "auth": "entra")`,
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
      "Configuration for the imagine MCP server. API keys are never stored here: api_key_env names the environment variable holding the key, and api_key_secret names a Key Vault secret.",
    ...rest,
  };
}

export type ConfigFile = z.infer<typeof configFileSchema>;
export type Config = z.infer<typeof configSchema>;
export type ProviderConfig = Config["providers"][string];
export type LogLevel = z.infer<typeof logLevel>;
export type OnBudgetExceeded = z.infer<typeof onExceed>;
export type ProviderAuth = z.infer<typeof auth>;
export type OutputSink = z.infer<typeof sink>;
export type BlobOutputConfig = z.infer<typeof blobSchema>;

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
    sink: "local",
    blob: null,
  },
  budget: {
    max_usd_per_session: 5,
    max_usd_per_day: 10,
    on_exceed: "refuse",
  },
  logging: { level: "info", cost_log: "./imagine-output/costs.jsonl" },
});
