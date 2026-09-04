/**
 * The authorization-code leg: the URL a browser is sent to, and the exchange
 * that turns the code it comes back with into an identity.
 *
 * **PKCE first, a client secret only if the exchange demands one.** The
 * authorization server this was written against has no per-application client
 * secret: the `client_secret` parameter of its token endpoint *is the
 * environment's API key*, a credential that can administer users and
 * organisations. Holding that in a container in order to log one person in is a
 * much bigger thing to hold than a provider key, so the portal sends a
 * `code_verifier` and no secret, and only falls back to a vault-held secret
 * when one has been put there deliberately. Verified against vendor
 * documentation on 2026-09-04: `client_secret` is *optional* on
 * `grant_type=authorization_code`, and `code_verifier` is required in its
 * absence.
 *
 * **How the returned identity is trusted.** The response carries a JWT access
 * token. When that token is one the MCP endpoint's own {@link Authenticator}
 * accepts — same issuer, same JWKS, same audience rules — it is validated that
 * way and there is exactly one set of rules about who this server trusts. When
 * it is not (a session token minted for the authorization server's own API
 * rather than for this resource), the identity is taken from the `user` object
 * in the same response. That is sound for a different reason and the reason is
 * worth stating: the response did not come through the browser. It is the body
 * of a server-to-server HTTPS POST to the token endpoint, authenticated by a
 * `code_verifier` only this process generated, for a `code` bound to it. A
 * browser cannot forge it and cannot see it. What is lost is the signature
 * check, so this path trusts TLS and the code exchange rather than a public
 * key — and the membership allowlist is applied to the result either way.
 */

import { createHash, randomBytes } from "node:crypto";
import { parseJwt } from "../transport/jwt.js";
import type { AuthSettings, Authenticator, CallerIdentity } from "../transport/auth.js";
import type { PortalSettings } from "./settings.js";

export type FetchLike = typeof globalThis.fetch;

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export function createPkcePair(): PkcePair {
  const verifier = randomBytes(32).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  };
}

export function createState(): string {
  return randomBytes(16).toString("base64url");
}

export function authorizeUrl(
  settings: PortalSettings,
  state: string,
  challenge: string,
): string {
  const url = new URL(settings.authorizeUrl);
  url.searchParams.set("client_id", settings.clientId);
  url.searchParams.set("redirect_uri", settings.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("provider", "authkit");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export function logoutUrl(settings: PortalSettings, sid: string | null): string {
  if (settings.logoutUrl === null || sid === null) return settings.resource;

  const url = new URL(settings.logoutUrl);
  url.searchParams.set("session_id", sid);
  url.searchParams.set("return_to", settings.resource);
  return url.toString();
}

/** What the token endpoint gives back, reduced to what the portal reads. */
export interface ExchangeResult {
  accessToken: string | null;
  userId: string | null;
  email: string | null;
  name: string | null;
}

export class LoginFailed extends Error {
  override readonly name = "LoginFailed";
}

export interface ExchangeOptions {
  settings: PortalSettings;
  code: string;
  verifier: string;
  /** Read from the vault only when one has been put there. */
  clientSecret?: string | null;
  fetch?: FetchLike;
  timeoutMs?: number;
}

export async function exchangeCode(options: ExchangeOptions): Promise<ExchangeResult> {
  const { settings } = options;
  const body: Record<string, string> = {
    grant_type: "authorization_code",
    client_id: settings.clientId,
    code: options.code,
    code_verifier: options.verifier,
  };
  if (options.clientSecret) body["client_secret"] = options.clientSecret;

  const fetchImpl = options.fetch ?? globalThis.fetch;

  let response: Response;
  try {
    response = await fetchImpl(settings.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
  } catch (cause) {
    throw new LoginFailed(
      `The authorization server at ${settings.tokenUrl} could not be reached: ${describe(cause)}`,
    );
  }

  const raw = await response.text().catch(() => "");
  if (!response.ok) {
    throw new LoginFailed(
      `The authorization server refused the code exchange with status ${response.status}: ${errorOf(raw)}`,
    );
  }

  const payload = parseObject(raw);
  if (payload === null) {
    throw new LoginFailed(
      "The authorization server's answer to the code exchange was not a JSON object.",
    );
  }

  const user = parseObject(JSON.stringify(payload["user"] ?? null));

  return {
    accessToken: string(payload, "access_token"),
    userId: user === null ? null : string(user, "id"),
    email: user === null ? null : string(user, "email"),
    name: user === null ? null : fullName(user),
  };
}

export interface IdentityOptions {
  auth: AuthSettings;
  authenticate?: Authenticator;
  nowSeconds: number;
  sessionSeconds: number;
}

export interface PortalIdentity {
  caller: CallerIdentity;
  /** The authorization server's session id, when the token carries one. */
  sid: string | null;
  /** How the identity was established, for the audit line and the tests. */
  verifiedBy: "token" | "exchange";
}

/**
 * The identity behind a completed exchange: validated by the MCP endpoint's own
 * authenticator when the token fits its rules, and otherwise assembled from the
 * exchange response, whose trust argument is at the top of this file.
 */
export async function identityFrom(
  result: ExchangeResult,
  options: IdentityOptions,
): Promise<PortalIdentity> {
  if (result.accessToken !== null && options.authenticate !== undefined) {
    const outcome = await options.authenticate(`Bearer ${result.accessToken}`);
    if (outcome.ok) {
      return {
        caller: outcome.caller,
        sid: sessionIdOf(result.accessToken),
        verifiedBy: "token",
      };
    }
  }

  const subject = result.userId ?? subjectOf(result.accessToken);
  if (subject === null) {
    throw new LoginFailed(
      "The authorization server completed the login without naming the user, so there is no identity to put in a session.",
    );
  }

  return {
    caller: Object.freeze({
      callerId: `${options.auth.issuer}:${subject}`,
      subject,
      objectId: null,
      tenantId: null,
      username: result.email,
      email: result.email,
      name: result.name,
      clientId: null,
      scopes: Object.freeze([]),
      roles: Object.freeze([]),
      issuer: options.auth.issuer,
      audience: options.auth.audiences[0] ?? options.auth.issuer,
      expiresAt: options.nowSeconds + options.sessionSeconds,
      claims: Object.freeze({}),
    }),
    sid: sessionIdOf(result.accessToken),
    verifiedBy: "exchange",
  };
}

/**
 * Read out of the token without verifying it, and used for nothing but the
 * logout redirect: an attacker who could plant a `sid` here would be able to
 * end their own session somewhere else.
 */
function sessionIdOf(token: string | null): string | null {
  return claim(token, "sid");
}

function subjectOf(token: string | null): string | null {
  return claim(token, "sub");
}

function claim(token: string | null, name: string): string | null {
  if (token === null) return null;
  try {
    const value = parseJwt(token).claims[name];
    return typeof value === "string" && value !== "" ? value : null;
  } catch {
    return null;
  }
}

function fullName(user: Record<string, unknown>): string | null {
  const parts = [string(user, "first_name"), string(user, "last_name")].filter(
    (part): part is string => part !== null,
  );
  return parts.length === 0 ? null : parts.join(" ");
}

function parseObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function string(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" && value !== "" ? value : null;
}

/** An error body is quoted back short, because it names what to fix. */
function errorOf(raw: string): string {
  const parsed = parseObject(raw);
  const message =
    parsed === null
      ? raw.trim()
      : [string(parsed, "error"), string(parsed, "error_description")]
          .filter((part): part is string => part !== null)
          .join(": ") || raw.trim();
  return message.length > 300 ? `${message.slice(0, 300)}…` : message;
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
