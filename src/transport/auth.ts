/**
 * Bearer-token authentication for `/mcp`, against Microsoft Entra ID.
 *
 * The endpoint is either open or it is guarded: with none of the four
 * `IMAGINE_AUTH_*` variables set, {@link authSettingsFromEnv} returns `null` and
 * the transport behaves exactly as it did before this module existed. With any
 * of them set, every POST must carry a token this server has verified itself —
 * signature, issuer, audience, tenant, lifetime and scope — before a tool runs.
 *
 * See ADR 0017 for the reasoning, and `docs/research/remote-mcp-2026-08.md` §3
 * for how the Claude clients actually present a token.
 */

import type { Env } from "../core/config.js";
import {
  KeysUnavailable,
  SigningKeys,
  TokenRejected,
  parseJwt,
  verifyJwt,
  type FetchLike,
  type JwtClaims,
} from "./jwt.js";

export const DEFAULT_REQUIRED_SCOPE = "access_as_user";
export const DEFAULT_CLOCK_SKEW_SECONDS = 60;
export const ENTRA_LOGIN_HOST = "https://login.microsoftonline.com";

export interface AuthSettings {
  tenantId: string;
  issuer: string;
  /** Accepted `aud` values, canonicalised. Usually one resource URI. */
  audiences: readonly string[];
  /** Accepted `scp` entries or `roles` entries; any one of them is enough. */
  requiredScopes: readonly string[];
  metadataUrl: string;
}

/**
 * The validated caller, as the tool layer will see it. `claims` is the whole
 * verified claim set for anything not named here; it is not for logging.
 * Consumed by the caller-identity work (issue #45), which keys the cost ledger
 * and per-caller budgets off `callerId`.
 */
export interface CallerIdentity {
  /** Stable per (user or service principal, tenant). The ledger key. */
  callerId: string;
  subject: string;
  objectId: string | null;
  tenantId: string | null;
  username: string | null;
  /** The calling application's own id, for tokens minted by an agent. */
  clientId: string | null;
  scopes: readonly string[];
  roles: readonly string[];
  issuer: string;
  audience: string;
  expiresAt: number;
  claims: JwtClaims;
}

export type BearerError = "invalid_request" | "invalid_token" | "insufficient_scope";

export type AuthOutcome =
  | { ok: true; caller: CallerIdentity }
  | { ok: false; status: number; error: BearerError | null; message: string };

export type Authenticator = (authorization: string | undefined) => Promise<AuthOutcome>;

export interface AuthenticatorOptions {
  fetch?: FetchLike;
  now?: () => number;
  clockSkewSeconds?: number;
  cacheTtlMs?: number;
  minRefreshIntervalMs?: number;
}

/**
 * Reads the auth configuration, or `null` for "no auth configured", which is
 * local mode. Anything half-configured throws at startup rather than failing
 * open at request time.
 */
export function authSettingsFromEnv(env: Env): AuthSettings | null {
  const tenantId = trimmed(env.IMAGINE_AUTH_TENANT_ID);
  const issuer = trimmed(env.IMAGINE_AUTH_ISSUER);
  const audience = trimmed(env.IMAGINE_AUTH_AUDIENCE);
  const requiredScope = trimmed(env.IMAGINE_AUTH_REQUIRED_SCOPE);

  if (!tenantId && !issuer && !audience && !requiredScope) return null;

  if (!tenantId) {
    throw new Error(
      "IMAGINE_AUTH_TENANT_ID is required once any other IMAGINE_AUTH_* variable is set. Unset them all to run the endpoint unauthenticated.",
    );
  }

  const audiences = splitList(audience).map(canonicalAudience);
  if (audiences.length === 0) {
    throw new Error(
      "IMAGINE_AUTH_AUDIENCE is required when authentication is on. Set it to the resource this server accepts tokens for — the Application ID URI of its Entra app registration, which must include the MCP endpoint URL itself.",
    );
  }

  const scopes = splitList(requiredScope);

  return {
    tenantId,
    issuer: issuer || `${ENTRA_LOGIN_HOST}/${tenantId}/v2.0`,
    audiences,
    requiredScopes: scopes.length > 0 ? scopes : [DEFAULT_REQUIRED_SCOPE],
    metadataUrl: `${ENTRA_LOGIN_HOST}/${tenantId}/v2.0/.well-known/openid-configuration`,
  };
}

export function createAuthenticator(
  settings: AuthSettings,
  options: AuthenticatorOptions = {},
): Authenticator {
  const keys = new SigningKeys({
    metadataUrl: settings.metadataUrl,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.cacheTtlMs !== undefined ? { cacheTtlMs: options.cacheTtlMs } : {}),
    ...(options.minRefreshIntervalMs !== undefined
      ? { minRefreshIntervalMs: options.minRefreshIntervalMs }
      : {}),
  });
  const now = options.now ?? Date.now;
  const skew = options.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS;

  return async (authorization) => {
    const token = bearerToken(authorization);
    if (token === null) {
      return {
        ok: false,
        status: 401,
        error: null,
        message:
          "Authentication required. Send an Authorization: Bearer <token> header with a Microsoft Entra ID access token for this server.",
      };
    }
    if (token === "") {
      return {
        ok: false,
        status: 401,
        error: "invalid_request",
        message:
          "The Authorization header is not a bearer credential. It must read: Authorization: Bearer <token>.",
      };
    }

    try {
      return { ok: true, caller: await validate(token, settings, keys, now, skew) };
    } catch (error) {
      if (error instanceof InsufficientScope) {
        return {
          ok: false,
          status: 403,
          error: "insufficient_scope",
          message: error.message,
        };
      }
      if (error instanceof TokenRejected) {
        return {
          ok: false,
          status: 401,
          error: "invalid_token",
          message: error.message,
        };
      }
      if (error instanceof KeysUnavailable) {
        return {
          ok: false,
          status: 503,
          error: null,
          message: `The token could not be checked because the tenant's signing keys are unreachable: ${error.message}`,
        };
      }
      throw error;
    }
  };
}

class InsufficientScope extends Error {
  override readonly name = "InsufficientScope";
}

async function validate(
  token: string,
  settings: AuthSettings,
  keys: SigningKeys,
  now: () => number,
  skewSeconds: number,
): Promise<CallerIdentity> {
  const parsed = parseJwt(token);

  const kid = parsed.header.kid;
  if (typeof kid !== "string" || kid === "") {
    throw new TokenRejected(
      "The token header has no kid, so its signing key cannot be identified.",
    );
  }

  await verifyJwt(parsed, await keys.find(kid));

  const claims = parsed.claims;
  const seconds = Math.floor(now() / 1000);

  const issuer = stringClaim(claims, "iss");
  if (issuer === null || issuer !== settings.issuer) {
    throw new TokenRejected(
      `The token was issued by ${issuer ?? "nobody"}, and this server accepts only ${settings.issuer}.`,
    );
  }

  const audience = audienceOf(claims).find((value) =>
    settings.audiences.includes(canonicalAudience(value)),
  );
  if (audience === undefined) {
    throw new TokenRejected(
      `The token was minted for another resource. This server accepts only tokens whose aud is ${settings.audiences.join(" or ")}.`,
    );
  }

  const tenantId = stringClaim(claims, "tid");
  if (tenantId !== null && tenantId !== settings.tenantId) {
    throw new TokenRejected(
      `The token comes from tenant ${tenantId}, and this server serves tenant ${settings.tenantId}.`,
    );
  }

  const expiresAt = numberClaim(claims, "exp");
  if (expiresAt === null) {
    throw new TokenRejected("The token has no exp, so it never expires. Refused.");
  }
  if (seconds > expiresAt + skewSeconds) {
    throw new TokenRejected("The token has expired.");
  }

  const notBefore = numberClaim(claims, "nbf");
  if (notBefore !== null && seconds + skewSeconds < notBefore) {
    throw new TokenRejected("The token is not valid yet.");
  }

  const scopes = scopesOf(claims);
  const roles = rolesOf(claims);
  const granted = [...scopes, ...roles];
  if (!settings.requiredScopes.some((required) => granted.includes(required))) {
    throw new InsufficientScope(
      `The token carries none of the required permissions (${settings.requiredScopes.join(", ")}). Grant the delegated scope or the app role on the Entra app registration and consent to it.`,
    );
  }

  const subject = stringClaim(claims, "sub") ?? "";
  const objectId = stringClaim(claims, "oid");
  const username =
    stringClaim(claims, "preferred_username") ?? stringClaim(claims, "upn");

  return Object.freeze({
    callerId: `${tenantId ?? settings.tenantId}:${objectId ?? subject}`,
    subject,
    objectId,
    tenantId,
    username,
    clientId: stringClaim(claims, "azp") ?? stringClaim(claims, "appid"),
    scopes,
    roles,
    issuer,
    audience,
    expiresAt,
    claims,
  });
}

/**
 * The RFC 6750 challenge. Issue #36 adds `resource_metadata` to it through
 * `params`; nothing else about the 401 has to change for that.
 */
export function bearerChallenge(
  outcome: Extract<AuthOutcome, { ok: false }>,
  params: Readonly<Record<string, string>> = {},
): string {
  const pairs = Object.entries(params).map(
    ([name, value]) => `${name}="${escapeQuoted(value)}"`,
  );

  if (outcome.error !== null) {
    pairs.unshift(`error_description="${escapeQuoted(outcome.message)}"`);
    pairs.unshift(`error="${outcome.error}"`);
  }

  return pairs.length === 0 ? "Bearer" : `Bearer ${pairs.join(", ")}`;
}

/** Safe to log: an identifier and nothing that was in the token. */
export function describeCaller(caller: CallerIdentity | null): string {
  return caller === null ? "anonymous" : caller.callerId;
}

function bearerToken(authorization: string | undefined): string | null {
  if (authorization === undefined || authorization.trim() === "") return null;

  const match = /^Bearer[ \t]+([^\s]+)[ \t]*$/i.exec(authorization.trim());
  return match?.[1] ?? "";
}

function escapeQuoted(value: string): string {
  return value.replace(/[\\"]/g, "\\$&");
}

/**
 * Audiences are compared as resources, not as strings: Entra hands back the
 * Application ID URI, and the operator may well have typed it with a different
 * case or a trailing slash than the one in the token.
 */
export function canonicalAudience(value: string): string {
  const trimmedValue = value.trim();
  try {
    const url = new URL(trimmedValue);
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${path}`;
  } catch {
    return trimmedValue.toLowerCase();
  }
}

function audienceOf(claims: JwtClaims): string[] {
  const value = claims["aud"];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((entry) => typeof entry === "string");
  return [];
}

function scopesOf(claims: JwtClaims): readonly string[] {
  const value = claims["scp"] ?? claims["scope"];
  if (typeof value === "string") return Object.freeze(splitList(value));
  if (Array.isArray(value)) {
    return Object.freeze(value.filter((entry) => typeof entry === "string"));
  }
  return Object.freeze([]);
}

function rolesOf(claims: JwtClaims): readonly string[] {
  const value = claims["roles"];
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(value.filter((entry) => typeof entry === "string"));
}

function stringClaim(claims: JwtClaims, name: string): string | null {
  const value = claims[name];
  return typeof value === "string" && value !== "" ? value : null;
}

function numberClaim(claims: JwtClaims, name: string): number | null {
  const value = claims[name];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function trimmed(value: string | undefined): string {
  return value?.trim() ?? "";
}

function splitList(value: string): string[] {
  return value
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}
