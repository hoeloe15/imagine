/**
 * Bearer-token authentication for `/mcp`.
 *
 * The endpoint is either open or it is guarded: with none of the
 * `IMAGINE_AUTH_*` variables set, {@link authSettingsFromEnv} returns `null` and
 * the transport behaves exactly as it did before this module existed. With any
 * of them set, every POST must carry a token this server has verified itself —
 * signature, issuer, audience, tenant, lifetime and scope — before a tool runs.
 *
 * There are two modes and one code path. **Entra mode** is chosen by
 * `IMAGINE_AUTH_TENANT_ID`: discovery and the `tid` check are the tenant's.
 * **Issuer mode** is chosen by `IMAGINE_AUTH_ISSUER` without a tenant: discovery
 * comes from the issuer's own well-known documents and there is no tenant claim
 * to check, so that check is skipped rather than defaulted. Any OIDC or RFC 8414
 * issuer that signs RSA JWTs fits; WorkOS AuthKit is the one ADR 0023 was
 * written for.
 *
 * See ADR 0017 for the validation rules, ADR 0023 for issuer mode, and
 * `docs/research/remote-mcp-2026-08.md` §3 for how the Claude clients actually
 * present a token.
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

/** RFC 8414 first, then OpenID Connect: issuers publish one, the other, or both. */
export const DISCOVERY_PATHS = Object.freeze([
  "/.well-known/oauth-authorization-server",
  "/.well-known/openid-configuration",
]);

export interface AuthSettings {
  /** The Entra tenant, or `null` in issuer mode, where the `tid` check is skipped. */
  tenantId: string | null;
  issuer: string;
  /** Accepted `aud` values, canonicalised. Usually one resource URI. */
  audiences: readonly string[];
  /**
   * Accepted `scp` entries or `roles` entries; any one of them is enough. Empty
   * means the issuer's own login is the whole authorization decision — which is
   * the default in issuer mode, because AuthKit publishes no custom scopes.
   */
  requiredScopes: readonly string[];
  /** Discovery documents to try, in order, for the `jwks_uri`. */
  metadataUrls: readonly string[];
}

/**
 * The validated caller, as the tool layer will see it. `claims` is the whole
 * verified claim set for anything not named here; it is not for logging.
 * Consumed by the caller-identity work (issue #45), which keys the cost ledger
 * and per-caller budgets off `callerId`.
 */
export interface CallerIdentity {
  /**
   * Stable per (user or service principal, tenant) in Entra mode, and per
   * (issuer, subject) in issuer mode. The ledger key.
   */
  callerId: string;
  subject: string;
  objectId: string | null;
  tenantId: string | null;
  username: string | null;
  email: string | null;
  name: string | null;
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
  const metadataUrl = trimmed(env.IMAGINE_AUTH_METADATA_URL);

  if (!tenantId && !issuer && !audience && !requiredScope && !metadataUrl) return null;

  if (!tenantId && !issuer) {
    throw new Error(
      "Authentication needs an authority: set IMAGINE_AUTH_TENANT_ID for a Microsoft Entra tenant, or IMAGINE_AUTH_ISSUER for any other OIDC issuer (the WorkOS AuthKit domain, for example). Unset every IMAGINE_AUTH_* variable to run the endpoint unauthenticated.",
    );
  }

  const audiences = splitList(audience).map(canonicalAudience);
  if (audiences.length === 0) {
    throw new Error(
      "IMAGINE_AUTH_AUDIENCE is required when authentication is on. Set it to the resource this server accepts tokens for, which must include the MCP endpoint URL itself.",
    );
  }

  const scopes = splitList(requiredScope);

  return {
    tenantId: tenantId || null,
    issuer: issuer || `${ENTRA_LOGIN_HOST}/${tenantId}/v2.0`,
    audiences,
    requiredScopes:
      scopes.length > 0 ? scopes : tenantId ? [DEFAULT_REQUIRED_SCOPE] : [],
    metadataUrls: discoveryUrls({ tenantId, issuer, metadataUrl }),
  };
}

/**
 * An explicit URL wins. A tenant means Entra, whose OpenID configuration is
 * where it has always been — an explicit `IMAGINE_AUTH_ISSUER` in that mode
 * names an alternative `iss` (`sts.windows.net`), not another authority. Only
 * with no tenant at all is discovery derived from the issuer, and then both
 * well-known documents are tried: WorkOS documents the RFC 8414 one and says
 * nothing about the OpenID Connect one.
 */
function discoveryUrls(configured: {
  tenantId: string;
  issuer: string;
  metadataUrl: string;
}): readonly string[] {
  if (configured.metadataUrl) return Object.freeze([configured.metadataUrl]);

  if (configured.tenantId) {
    return Object.freeze([
      `${ENTRA_LOGIN_HOST}/${configured.tenantId}/v2.0/.well-known/openid-configuration`,
    ]);
  }

  const base = issuerOrigin(configured.issuer);
  return Object.freeze(DISCOVERY_PATHS.map((path) => `${base}${path}`));
}

function issuerOrigin(issuer: string): string {
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    throw new Error(
      `IMAGINE_AUTH_ISSUER must be an absolute https URL, not ${JSON.stringify(issuer)}. For WorkOS AuthKit that is https://<your-project>.authkit.app.`,
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(
      `IMAGINE_AUTH_ISSUER must be an http or https URL, not ${JSON.stringify(issuer)}.`,
    );
  }
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
}

export function createAuthenticator(
  settings: AuthSettings,
  options: AuthenticatorOptions = {},
): Authenticator {
  const keys = new SigningKeys({
    metadataUrls: settings.metadataUrls,
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
        message: `Authentication required. Send an Authorization: Bearer <token> header with an access token this server's authorization server (${settings.issuer}) minted for it.`,
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
          message: `The token could not be checked because the authorization server's signing keys are unreachable: ${error.message}`,
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
  if (
    settings.tenantId !== null &&
    tenantId !== null &&
    tenantId !== settings.tenantId
  ) {
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
  if (
    settings.requiredScopes.length > 0 &&
    !settings.requiredScopes.some((required) => granted.includes(required))
  ) {
    throw new InsufficientScope(
      `The token carries none of the required permissions (${settings.requiredScopes.join(", ")}). Grant that scope or app role on the authorization server and consent to it.`,
    );
  }

  const subject = stringClaim(claims, "sub") ?? "";
  const objectId = stringClaim(claims, "oid");
  const email = stringClaim(claims, "email");
  const username =
    stringClaim(claims, "preferred_username") ?? stringClaim(claims, "upn") ?? email;
  const tenant = tenantId ?? settings.tenantId;

  return Object.freeze({
    // Entra gives a tenant and an object id; an issuer that gives neither is
    // still identified by the pair that OIDC guarantees to be stable, and the
    // cost ledger of issue #45 keys off exactly this string.
    callerId:
      tenant === null ? `${issuer}:${subject}` : `${tenant}:${objectId ?? subject}`,
    subject,
    objectId,
    tenantId,
    username,
    email,
    name: stringClaim(claims, "name"),
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
