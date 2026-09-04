/**
 * Where a provider key comes from, resolved at request time rather than once at
 * startup.
 *
 * Two layers:
 *
 * 1. A {@link SecretStore} — one named secret in, one value out. The only
 *    implementation that talks to a network is {@link createKeyVaultSecretStore},
 *    a single `GET {vault}/secrets/{name}?api-version=7.4` with a
 *    managed-identity bearer token. Third instance of the pattern ADR 0022 and
 *    ADR 0024 established: hand-rolled `fetch`, no `@azure/*` SDK, a cached
 *    token, shared in-flight requests, failures never cached.
 * 2. A {@link SecretResolver} — provider id in, `{ value, source }` out. It
 *    knows the config's `api_key_secret` / `api_key_env` names and the order
 *    they are tried in: **vault first, then the environment**, because the vault
 *    is the thing a person can change without a deployment and the environment
 *    is what the deployment baked in.
 *
 * Without a vault the resolver reads the environment and nothing else, which is
 * byte-for-byte the behaviour {@link resolveApiKey} has always had — the same
 * trick ADR 0024 used for the output sink, so every existing test stays honest.
 *
 * **No key value is ever put in a message, an error or a log line.** The most a
 * caller learns is the *name* of an environment variable or a vault secret,
 * which is what makes an answer actionable. See ADR 0004 and ADR 0026.
 */

import type { Config, ProviderConfig } from "./config-schema.js";
import type { Env } from "./config.js";
import { ImagineError } from "./errors.js";

export type FetchLike = typeof globalThis.fetch;
export type AccessTokenProvider = () => Promise<string>;

/** The vault URL, written by the deployment template rather than by a person. */
export const KEY_VAULT_URL_ENV = "IMAGINE_KEY_VAULT_URL";

/** What a token for the Key Vault data plane has to be issued for. */
export const AZURE_KEY_VAULT_SCOPE = "https://vault.azure.net/.default";

/** The data-plane api-version this file's one request speaks. */
export const KEY_VAULT_API_VERSION = "7.4";

/** How long a value that was found stays usable without asking again. */
export const SECRET_TTL_MS = 60_000;
/** How long a "there is no such secret" stays believed. Shorter on purpose. */
export const SECRET_MISS_TTL_MS = 15_000;

const DEFAULT_TIMEOUT_MS = 10_000;

/** Where a resolved key came from. Never accompanied by the value's shape. */
export type SecretSourceKind = "vault" | "env";

export interface SecretResolution {
  value: string;
  source: SecretSourceKind;
}

/**
 * A resolution attempt, with the names that would make it succeed. `missing` is
 * empty when a key was found; `note` is set when a source was configured but
 * could not be read, which is the difference between "you never set one" and
 * "I could not reach the vault just now".
 */
export interface SecretLookup {
  resolution: SecretResolution | null;
  /** Names only: `OPENROUTER_API_KEY`, `vault secret openrouter-api-key`. */
  missing: string[];
  note?: string;
}

export interface SecretResolver {
  /** The key for a provider, or `null` when no source holds one. */
  resolve(providerId: string): Promise<SecretResolution | null>;
  /** The same lookup, with what a `not_configured` provider is waiting for. */
  lookup(providerId: string): Promise<SecretLookup>;
  /**
   * Whether a source is configured at all, without reading a value. This is
   * what `isConfigured()` on an adapter comes to mean.
   */
  hasSource(providerId: string): boolean;
  /** Forget what was cached, so a write is visible to this replica at once. */
  invalidate(providerId?: string): void;
  /** Whether a Key Vault is configured for this process. */
  readonly hasVault: boolean;
}

/**
 * What an adapter is handed instead of a key string: a pair of questions it can
 * ask, rather than a value it was given once at startup.
 *
 * `has()` is synchronous and answers "is a source configured for me", which is
 * what `isConfigured()` and the router need and what they can afford to ask on
 * every call. `get()` is the request-time read.
 */
export interface ApiKeySource {
  has(): boolean;
  get(): Promise<string | null>;
}

/**
 * What the adapters accept. A plain string (or `null`) is the direct-use form —
 * a test, a script, anyone constructing an adapter by hand — and behaves exactly
 * as it always has.
 */
export type ApiKeyOption =
  string | null | ApiKeySource | (() => Promise<string | null>);

/** Normalises {@link ApiKeyOption} to the one shape an adapter reads. */
export function toApiKeySource(option: ApiKeyOption | undefined): ApiKeySource {
  if (option === undefined || option === null) {
    return { has: () => false, get: () => Promise.resolve(null) };
  }
  if (typeof option === "string") {
    const value = option.length === 0 ? null : option;
    return { has: () => value !== null, get: () => Promise.resolve(value) };
  }
  if (typeof option === "function") {
    return { has: () => true, get: option };
  }
  return option;
}

/** The {@link ApiKeySource} one provider's adapter reads through a resolver. */
export function apiKeySourceFor(
  resolver: SecretResolver,
  providerId: string,
): ApiKeySource {
  return {
    has: () => resolver.hasSource(providerId),
    get: async () => (await resolver.resolve(providerId))?.value ?? null,
  };
}

/** One named secret in, one value out. `null` means "no such secret". */
export interface SecretStore {
  get(name: string): Promise<string | null>;
  invalidate(name?: string): void;
}

/**
 * The write half, which only the portal uses. It is a separate interface so
 * that reading a secret and replacing one stay two different capabilities: a
 * fake store in a test, or a future read-only store, satisfies
 * {@link SecretStore} without gaining the ability to overwrite anything.
 *
 * Both operations invalidate this store's own cache before returning, so the
 * replica that wrote sees the new value at once. Other replicas see it when
 * their cache expires, which is the honest "within a minute" of ADR 0026.
 */
export interface SecretWriter {
  set(name: string, value: string): Promise<void>;
  /** Deletes the secret. A secret that was not there is not an error. */
  remove(name: string): Promise<void>;
}

export type WritableSecretStore = SecretStore & SecretWriter;

/** Key Vault's own rule for a secret name, so a pasted key cannot be one. */
export const SECRET_NAME_PATTERN = /^[A-Za-z0-9-]{1,127}$/;

/**
 * The name of the Key Vault secret a provider's key lives in, derived from the
 * environment variable it names: lower-cased, underscores to hyphens.
 * `OPENROUTER_API_KEY` becomes `openrouter-api-key`, which is exactly the name
 * `infra/resources.bicep` already writes — so a deployed installation needs no
 * config change at all.
 */
export function derivedSecretName(apiKeyEnv: string): string {
  return apiKeyEnv.toLowerCase().replace(/_/g, "-");
}

/** The vault secret a provider reads, explicit or derived. */
export function secretNameFor(provider: ProviderConfig): string | null {
  if (provider.api_key_secret) return provider.api_key_secret;
  return provider.api_key_env ? derivedSecretName(provider.api_key_env) : null;
}

export interface KeyVaultSecretStoreOptions {
  /** e.g. `https://kv-imagine-abc.vault.azure.net/`; a trailing slash is fine. */
  vaultUrl: string;
  getAccessToken: AccessTokenProvider;
  fetch?: FetchLike;
  now?: () => number;
  ttlMs?: number;
  missTtlMs?: number;
  timeoutMs?: number;
}

interface CachedSecret {
  value: string | null;
  expiresAtMs: number;
}

/**
 * A {@link SecretStore} over the Key Vault data plane.
 *
 * A 404 is `null`, not an error: "no key has been set yet" is an ordinary state
 * of a fresh deployment, and turning it into a failure would make every
 * `list_capabilities` on an empty vault look broken. Anything else throws, and
 * the caller decides whether to fall back — a transient vault failure must not
 * silently look like "the key was deleted".
 */
export function createKeyVaultSecretStore(
  options: KeyVaultSecretStoreOptions,
): WritableSecretStore {
  const base = stripTrailingSlash(options.vaultUrl);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? SECRET_TTL_MS;
  const missTtlMs = options.missTtlMs ?? SECRET_MISS_TTL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const cache = new Map<string, CachedSecret>();
  const inFlight = new Map<string, Promise<CachedSecret>>();

  function secretUrl(name: string): string {
    return `${base}/secrets/${encodeURIComponent(name)}?api-version=${KEY_VAULT_API_VERSION}`;
  }

  async function bearer(name: string, verb: string): Promise<string> {
    const token = await options.getAccessToken();
    if (token.trim() === "") {
      throw new ImagineError(
        "auth_failed",
        `The token provider returned an empty token for ${AZURE_KEY_VAULT_SCOPE}, so secret "${name}" at ${base} cannot be ${verb}.`,
      );
    }
    return token;
  }

  /**
   * The write half. The body is never quoted back into an error: a failed PUT
   * must not be the thing that puts a key into a log line.
   */
  async function write(
    name: string,
    method: "PUT" | "DELETE",
    value?: string,
  ): Promise<void> {
    const token = await bearer(name, method === "PUT" ? "written" : "deleted");

    let response: Response;
    try {
      response = await fetchImpl(secretUrl(name), {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(value === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(value === undefined ? {} : { body: JSON.stringify({ value }) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      throw new ImagineError(
        "provider_unavailable",
        `Could not reach Key Vault at ${base} while writing secret "${name}": ${describe(cause)}`,
        { cause, retryable: true },
      );
    }

    // Deleting something that is not there leaves the world as the caller asked
    // for it, so it is a success rather than a puzzle to explain on a web page.
    if (method === "DELETE" && response.status === 404) {
      await bodyText(response);
      cache.delete(name);
      return;
    }

    if (!response.ok)
      throw vaultError(response.status, await bodyText(response), base, name);

    await bodyText(response);
    cache.delete(name);
  }

  async function request(name: string): Promise<CachedSecret> {
    const url = secretUrl(name);
    const token = await bearer(name, "read");

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      throw new ImagineError(
        "provider_unavailable",
        `Could not reach Key Vault at ${base} while reading secret "${name}": ${describe(cause)}`,
        { cause, retryable: true },
      );
    }

    if (response.status === 404) {
      await bodyText(response);
      return { value: null, expiresAtMs: now() + missTtlMs };
    }

    const raw = await bodyText(response);
    if (!response.ok) {
      throw vaultError(response.status, raw, base, name);
    }

    const value = readString(parseJson(raw), "value");
    if (value === undefined) {
      throw new ImagineError(
        "unknown",
        `Key Vault answered ${response.status} for secret "${name}" without a value field.`,
      );
    }

    return { value, expiresAtMs: now() + ttlMs };
  }

  return {
    async get(name: string): Promise<string | null> {
      const cached = cache.get(name);
      if (cached !== undefined && now() < cached.expiresAtMs) return cached.value;

      let attempt = inFlight.get(name);
      if (attempt === undefined) {
        attempt = request(name);
        inFlight.set(name, attempt);
      }

      try {
        const fresh = await attempt;
        cache.set(name, fresh);
        return fresh.value;
      } catch (cause) {
        // A stale value beats an outage: the key has not changed just because
        // the vault is briefly unreachable. Failures themselves are never cached.
        if (cached !== undefined && cached.value !== null) return cached.value;
        throw cause;
      } finally {
        inFlight.delete(name);
      }
    },

    invalidate(name?: string): void {
      if (name === undefined) cache.clear();
      else cache.delete(name);
    },

    set(name: string, value: string): Promise<void> {
      return write(name, "PUT", value);
    },

    remove(name: string): Promise<void> {
      return write(name, "DELETE");
    },
  };
}

export interface SecretResolverOptions {
  config: Config;
  /** The environment `api_key_env` names are read from. */
  env: Env;
  /** Absent means environment-only, which is local mode. */
  vault?: SecretStore;
}

export function createSecretResolver(options: SecretResolverOptions): SecretResolver {
  const { config, env } = options;
  const vault = options.vault;

  function providerOf(providerId: string): ProviderConfig | undefined {
    return config.providers[providerId];
  }

  function names(provider: ProviderConfig): {
    envVar: string | null;
    secret: string | null;
  } {
    return {
      envVar: provider.api_key_env,
      secret: vault === undefined ? null : secretNameFor(provider),
    };
  }

  async function lookup(providerId: string): Promise<SecretLookup> {
    const provider = providerOf(providerId);
    if (provider === undefined || !provider.enabled || provider.auth === "entra") {
      return { resolution: null, missing: [] };
    }

    const { envVar, secret } = names(provider);
    let note: string | undefined;

    if (vault !== undefined && secret !== null) {
      try {
        const value = await vault.get(secret);
        if (value !== null && value.length > 0) {
          return { resolution: { value, source: "vault" }, missing: [] };
        }
      } catch (cause) {
        note = `Key Vault could not be read just now (${describe(cause)}), so only the environment was consulted.`;
      }
    }

    const fromEnv = envVar === null ? undefined : env[envVar];
    if (fromEnv !== undefined && fromEnv.length > 0) {
      return { resolution: { value: fromEnv, source: "env" }, missing: [] };
    }

    const missing = [
      ...(envVar === null ? [] : [envVar]),
      ...(secret === null ? [] : [`vault secret ${secret}`]),
    ];

    return { resolution: null, missing, ...(note === undefined ? {} : { note }) };
  }

  return {
    lookup,

    async resolve(providerId: string): Promise<SecretResolution | null> {
      return (await lookup(providerId)).resolution;
    },

    hasSource(providerId: string): boolean {
      const provider = providerOf(providerId);
      if (provider === undefined || !provider.enabled) return false;
      if (provider.auth === "entra") return false;

      const { envVar, secret } = names(provider);
      if (secret !== null) return true;
      return envVar !== null && (env[envVar] ?? "").length > 0;
    },

    invalidate(providerId?: string): void {
      if (vault === undefined) return;
      if (providerId === undefined) {
        vault.invalidate();
        return;
      }
      const provider = providerOf(providerId);
      const secret = provider === undefined ? null : secretNameFor(provider);
      if (secret !== null) vault.invalidate(secret);
    },

    hasVault: vault !== undefined,
  };
}

function vaultError(
  status: number,
  body: string,
  base: string,
  name: string,
): ImagineError {
  const detail = `Key Vault refused to read secret "${name}" from ${base} with status ${status}: ${truncate(body)}`;

  if (status === 401 || status === 403) {
    return new ImagineError(
      "auth_failed",
      `${detail} The container identity needs the Key Vault Secrets User role (Secrets Officer if it also writes) on this vault.`,
    );
  }
  if (status === 429)
    return new ImagineError("rate_limited", detail, { retryable: true });
  if (status >= 500) {
    return new ImagineError("provider_unavailable", detail, { retryable: true });
  }
  return new ImagineError("unknown", detail);
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

async function bodyText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function parseJson(raw: string): Record<string, unknown> | null {
  if (raw.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readString(
  record: Record<string, unknown> | null,
  key: string,
): string | undefined {
  if (record === null) return undefined;
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Bodies from a secrets endpoint are never echoed whole, and never a value. */
function truncate(raw: string, limit = 200): string {
  const trimmed = raw.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
