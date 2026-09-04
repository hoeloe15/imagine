/**
 * The composition root: the one place that knows both what a provider adapter
 * is and how the server is assembled. Everything under `src/mcp/` is handed its
 * dependencies from here, which is what keeps the MCP layer free of provider
 * knowledge (PLAN.md §3).
 *
 * Startup never fails over a missing key. A provider without credentials simply
 * reports itself unconfigured, the server starts, and `generate_image` answers
 * with a failure envelope saying what is missing — a client that cannot start
 * the server cannot show the user why.
 *
 * Nor does startup *read* a key. Each adapter is handed a source it asks at
 * request time, so a key that appears in Key Vault after the container started
 * is used by the next call rather than by the next deployment (ADR 0026).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AZURE_STORAGE_SCOPE, createBlobSink } from "./core/blob-sink.js";
import { openCostLedger, type CostLedger } from "./core/budget.js";
import type { ObjectSink } from "./core/output.js";
import { loadConfig, type LoadConfigOptions } from "./core/config.js";
import { loadBundledModelKnowledge } from "./core/knowledge.js";
import {
  AZURE_KEY_VAULT_SCOPE,
  KEY_VAULT_URL_ENV,
  apiKeySourceFor,
  createKeyVaultSecretStore,
  createSecretResolver,
  type SecretResolver,
  type SecretStore,
} from "./core/secrets.js";
import {
  AZURE_ID,
  AzureProvider,
  AZURE_ENTRA_SCOPE,
  type AccessTokenProvider,
} from "./providers/azure.js";
import {
  IDENTITY_ENDPOINT_ENV,
  IDENTITY_HEADER_ENV,
  createManagedIdentityTokenProvider,
  hasManagedIdentity,
} from "./providers/managed-identity.js";
import type { Env } from "./core/config.js";
import { ImagineError } from "./core/errors.js";
import { OPENROUTER_ID, OpenRouterProvider } from "./providers/openrouter.js";
import type { ImageProvider } from "./providers/types.js";
import { createServer, type ServerDependencies } from "./mcp/server.js";

export interface BuildOptions extends LoadConfigOptions {
  /** Replaces the adapters this function would otherwise construct. */
  providers?: readonly ImageProvider[];
  /** Replaces the ledger this function would otherwise open. */
  ledger?: CostLedger;
  /** Replaces the output sink the `output` config would otherwise select. */
  sink?: ObjectSink;
  /** Replaces the secret resolver the environment would otherwise select. */
  secrets?: SecretResolver;
}

export async function buildDependencies(
  options: BuildOptions = {},
): Promise<ServerDependencies> {
  const { providers, ledger, sink, secrets, ...configOptions } = options;
  const loaded = loadConfig(configOptions);
  const { config } = loaded;
  const outputSink = sink ?? blobSink(loaded);
  const resolver = secrets ?? secretResolver(loaded);

  return {
    config,
    env: loaded.env,
    secrets: resolver,
    ...(outputSink === undefined ? {} : { sink: outputSink }),
    knowledge: loadBundledModelKnowledge(),
    ledger:
      ledger ??
      (await openCostLedger({
        budget: config.budget,
        costLog: config.logging.cost_log,
      })),
    providers: providers ?? [
      new OpenRouterProvider({ apiKey: apiKeySourceFor(resolver, OPENROUTER_ID) }),
      azureProvider(loaded, resolver),
    ],
  };
}

/**
 * Keys are read when a request needs one, not once at startup — so a key put
 * into Key Vault becomes usable without a redeploy (ADR 0026).
 *
 * Without `IMAGINE_KEY_VAULT_URL`, or without an identity to read that vault
 * with, this is an environment-only resolver: exactly the behaviour every
 * local installation has always had.
 */
function secretResolver(loaded: ReturnType<typeof loadConfig>): SecretResolver {
  const vault = keyVaultStore(loaded.env);
  return createSecretResolver({
    config: loaded.config,
    env: loaded.env,
    ...(vault === undefined ? {} : { vault }),
  });
}

function keyVaultStore(env: Env): SecretStore | undefined {
  const vaultUrl = env[KEY_VAULT_URL_ENV]?.trim();
  if (!vaultUrl || !hasManagedIdentity(env)) return undefined;

  return createKeyVaultSecretStore({
    vaultUrl,
    getAccessToken: createManagedIdentityTokenProvider({
      env,
      scope: AZURE_KEY_VAULT_SCOPE,
    }),
  });
}

/**
 * The blob sink, when the config asks for it. Local mode gets `undefined` and
 * `writeImage` keeps writing files, unchanged (ADR 0024).
 */
function blobSink(loaded: ReturnType<typeof loadConfig>): ObjectSink | undefined {
  const { sink, blob } = loaded.config.output;
  if (sink !== "blob" || blob === null) return undefined;

  return createBlobSink({
    accountUrl: blob.account_url,
    container: blob.container,
    urlTtlHours: blob.url_ttl_hours,
    getAccessToken: hasManagedIdentity(loaded.env)
      ? createManagedIdentityTokenProvider({
          env: loaded.env,
          scope: AZURE_STORAGE_SCOPE,
        })
      : noManagedIdentityForStorage,
  });
}

function noManagedIdentityForStorage(): Promise<string> {
  return Promise.reject(
    new ImagineError(
      "auth_failed",
      `output.sink is "blob", but this process has no managed identity to obtain a token for ${AZURE_STORAGE_SCOPE} with: ${IDENTITY_ENDPOINT_ENV} and ${IDENTITY_HEADER_ENV} are not both set. The blob sink exists for hosted deployments, where the platform provides an identity; on a developer machine leave output.sink at "local".`,
    ),
  );
}

function azureProvider(
  loaded: ReturnType<typeof loadConfig>,
  secrets: SecretResolver,
): AzureProvider {
  const provider = loaded.config.providers[AZURE_ID];
  const auth = provider?.auth ?? "entra";

  return new AzureProvider({
    enabled: provider?.enabled ?? false,
    ...(provider?.endpoint === undefined ? {} : { endpoint: provider.endpoint }),
    ...(provider?.api_version === undefined
      ? {}
      : { apiVersion: provider.api_version }),
    auth,
    apiKey: apiKeySourceFor(secrets, AZURE_ID),
    ...(provider?.deployments === undefined
      ? {}
      : { deployments: provider.deployments }),
    ...(auth === "entra" ? { getAccessToken: entraTokenProvider(loaded.env) } : {}),
  });
}

/**
 * Hosted, the platform's managed identity mints the token. Locally there is no
 * identity to mint one with, and the adapter is wired with a provider that says
 * exactly that rather than reporting itself unconfigured for a reason the config
 * cannot show. See ADR 0014 and ADR 0022.
 */
function entraTokenProvider(env: Env): AccessTokenProvider {
  return hasManagedIdentity(env)
    ? createManagedIdentityTokenProvider({ env, scope: AZURE_ENTRA_SCOPE })
    : noManagedIdentity;
}

function noManagedIdentity(): Promise<string> {
  return Promise.reject(
    new ImagineError(
      "auth_failed",
      `providers.${AZURE_ID}.auth is "entra", but this process has no managed identity to obtain a token for ${AZURE_ENTRA_SCOPE} with: ${IDENTITY_ENDPOINT_ENV} and ${IDENTITY_HEADER_ENV} are not both set. Entra authentication works where the platform provides an identity, such as Azure Container Apps. On a developer machine set providers.${AZURE_ID}.auth to "api_key" and providers.${AZURE_ID}.api_key_env to the variable holding your key, or construct AzureProvider yourself with a getAccessToken option.`,
    ),
  );
}

export async function createImagineServer(
  options: BuildOptions = {},
): Promise<McpServer> {
  return createServer(await buildDependencies(options));
}
