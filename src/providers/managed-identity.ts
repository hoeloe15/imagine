/**
 * An {@link AccessTokenProvider} backed by the platform's managed identity.
 *
 * Container Apps (and App Service) inject `IDENTITY_ENDPOINT` and
 * `IDENTITY_HEADER`; a GET against that endpoint with the header returns a token
 * for the resource asked for. That is the whole protocol, which is why this is
 * hand-rolled rather than taken as a dependency — see ADR 0022.
 *
 * No token value is ever put in a message or an error.
 */

import { ImagineError } from "../core/errors.js";
import type { Env } from "../core/config.js";
/**
 * The scope is bound when the provider is built, so what comes back takes no
 * arguments — unlike `azure.ts`'s `AccessTokenProvider`, which is handed a scope
 * per call because the two Azure wire dialects want different audiences
 * (ADR 0027).
 */
import type { AccessTokenProvider } from "../core/secrets.js";
import { AZURE_ENTRA_SCOPE, type FetchLike } from "./azure.js";

export const IDENTITY_ENDPOINT_ENV = "IDENTITY_ENDPOINT";
export const IDENTITY_HEADER_ENV = "IDENTITY_HEADER";
/** Which identity to ask for, when more than one is assigned to the app. */
export const IDENTITY_CLIENT_ID_ENV = "AZURE_CLIENT_ID";

/** The api-version Container Apps and App Service both speak. */
export const MANAGED_IDENTITY_API_VERSION = "2019-08-01";

/** Refresh this far ahead of expiry, so a call never races the clock. */
const DEFAULT_EXPIRY_SLACK_MS = 300_000;
const DEFAULT_TIMEOUT_MS = 10_000;
/** Used only if the platform answers without an expiry, which it should not. */
const FALLBACK_LIFETIME_MS = 600_000;

export interface ManagedIdentityEnvironment {
  endpoint: string;
  header: string;
  clientId?: string;
}

export interface ManagedIdentityTokenProviderOptions {
  /** The ambient environment. Defaults to `process.env`. */
  env?: Env;
  /** Defaults to {@link AZURE_ENTRA_SCOPE}. */
  scope?: string;
  fetch?: FetchLike;
  now?: () => number;
  expirySlackMs?: number;
  timeoutMs?: number;
}

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

/**
 * The managed identity the platform has injected, or `null` when there is none
 * — which is the normal state on a developer's machine.
 */
export function managedIdentityEnvironment(
  env: Env,
): ManagedIdentityEnvironment | null {
  const endpoint = nonEmpty(env[IDENTITY_ENDPOINT_ENV]);
  const header = nonEmpty(env[IDENTITY_HEADER_ENV]);
  if (endpoint === undefined || header === undefined) return null;

  const clientId = nonEmpty(env[IDENTITY_CLIENT_ID_ENV]);
  return { endpoint, header, ...(clientId === undefined ? {} : { clientId }) };
}

export function hasManagedIdentity(env: Env): boolean {
  return managedIdentityEnvironment(env) !== null;
}

export function createManagedIdentityTokenProvider(
  options: ManagedIdentityTokenProviderOptions = {},
): AccessTokenProvider {
  const env = options.env ?? process.env;
  const scope = options.scope ?? AZURE_ENTRA_SCOPE;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const slackMs = options.expirySlackMs ?? DEFAULT_EXPIRY_SLACK_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let cached: CachedToken | null = null;
  let inFlight: Promise<CachedToken> | null = null;

  return async () => {
    const current = cached;
    if (current !== null && now() + slackMs < current.expiresAtMs) return current.token;

    inFlight ??= requestToken({ env, scope, fetch: fetchImpl, now, timeoutMs });
    try {
      const fresh = await inFlight;
      cached = fresh;
      return fresh.token;
    } finally {
      inFlight = null;
    }
  };
}

async function requestToken(context: {
  env: Env;
  scope: string;
  fetch: FetchLike;
  now: () => number;
  timeoutMs: number;
}): Promise<CachedToken> {
  const identity = managedIdentityEnvironment(context.env);
  if (identity === null) {
    throw new ImagineError(
      "auth_failed",
      `No managed identity is available: ${IDENTITY_ENDPOINT_ENV} and ${IDENTITY_HEADER_ENV} are not both set, so this process is not running under an Azure managed identity and there is no way to obtain a token for ${context.scope}. On a developer machine set providers.azure.auth to "api_key" and providers.azure.api_key_env to the variable holding your key; hosted, check that the container app has a user-assigned identity.`,
    );
  }

  const url = buildTokenUrl(identity, context.scope);

  let response: Response;
  try {
    response = await context.fetch(url, {
      method: "GET",
      headers: {
        "X-IDENTITY-HEADER": identity.header,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(context.timeoutMs),
    });
  } catch (cause) {
    throw new ImagineError(
      "auth_failed",
      `Could not reach the managed identity endpoint at ${identity.endpoint}: ${describe(cause)}`,
      { cause, retryable: true },
    );
  }

  const raw = await readBodyText(response);
  if (!response.ok) {
    throw new ImagineError(
      "auth_failed",
      `The managed identity endpoint refused a token for ${context.scope} with status ${response.status}: ${truncate(raw)}. The usual cause is that the app has no identity assigned, or that ${IDENTITY_CLIENT_ID_ENV} names one it does not have.`,
    );
  }

  const payload = parseJson(raw);
  const token = payload === null ? undefined : readString(payload, "access_token");
  if (token === undefined) {
    throw new ImagineError(
      "auth_failed",
      `The managed identity endpoint answered ${response.status} without an access_token for ${context.scope}.`,
    );
  }

  return {
    token,
    expiresAtMs:
      expiryMs(payload?.["expires_on"]) ?? context.now() + FALLBACK_LIFETIME_MS,
  };
}

function buildTokenUrl(identity: ManagedIdentityEnvironment, scope: string): string {
  const url = new URL(identity.endpoint);
  url.searchParams.set("api-version", MANAGED_IDENTITY_API_VERSION);
  url.searchParams.set("resource", resourceFor(scope));
  if (identity.clientId !== undefined) {
    url.searchParams.set("client_id", identity.clientId);
  }
  return url.toString();
}

/** The endpoint takes an AAD v1 resource, not a v2 scope. */
function resourceFor(scope: string): string {
  return scope.endsWith("/.default") ? scope.slice(0, -"/.default".length) : scope;
}

/** Epoch seconds, as a number or a string, is what the platform sends today. */
function expiryMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value * 1000;
  if (typeof value !== "string" || value.length === 0) return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim().length > 0 ? value : undefined;
}

async function readBodyText(response: Response): Promise<string> {
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

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function truncate(raw: string, limit = 300): string {
  const trimmed = raw.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
