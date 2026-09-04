/**
 * The session cookie, the login-leg state cookie, and the CSRF token.
 *
 * All three are the same trick: a small JSON document, base64url-encoded, with
 * an HMAC-SHA256 over it appended. Nothing inside is secret — a caller id, an
 * email address, an expiry — so this is a **signature, not encryption**. A
 * tampered cookie fails the check and the visitor is asked to log in again,
 * rather than decrypting into something the server then believes.
 *
 * Stateless on purpose: the container app runs up to three replicas with no
 * shared session store, and an in-memory session map would log people out at
 * random (issue #60).
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "imagine_portal_session";
export const STATE_COOKIE = "imagine_portal_state";
export const CSRF_FIELD = "csrf_token";

export interface PortalSession {
  callerId: string;
  subject: string;
  email: string | null;
  name: string | null;
  /** The authorization server's session id, for the logout redirect. */
  sid: string | null;
  /** Seconds since the epoch. */
  exp: number;
}

export interface LoginState {
  state: string;
  verifier: string;
  exp: number;
}

/**
 * The key everything on this page is signed with. An explicit secret survives a
 * revision, so a deployment that sets one keeps people logged in across a
 * release; without one the key is random per process, which is safe and means a
 * re-login after every deployment and on every replica that has not seen you.
 */
export function sessionKey(secret: string | null): Buffer {
  return secret === null || secret === ""
    ? randomBytes(32)
    : createHmac("sha256", "imagine-portal-session").update(secret).digest();
}

function encode(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function sign(key: Buffer, body: string): string {
  return createHmac("sha256", key).update(body).digest("base64url");
}

export function seal(key: Buffer, payload: unknown): string {
  const body = encode(payload);
  return `${body}.${sign(key, body)}`;
}

/** `null` for anything that does not verify — malformed, truncated, tampered. */
export function unseal(key: Buffer, token: string | undefined): unknown {
  if (token === undefined) return null;

  const separator = token.lastIndexOf(".");
  if (separator <= 0) return null;

  const body = token.slice(0, separator);
  if (!equal(token.slice(separator + 1), sign(key, body))) return null;

  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

/** Constant time, and false for a length mismatch rather than throwing. */
export function equal(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" && value !== "" ? value : null;
}

export function readSession(
  key: Buffer,
  cookie: string | undefined,
  nowSeconds: number,
): PortalSession | null {
  const claims = record(unseal(key, cookie));
  if (claims === null) return null;

  const callerId = text(claims, "callerId");
  const subject = text(claims, "subject");
  const exp = claims["exp"];
  if (callerId === null || subject === null || typeof exp !== "number") return null;
  if (nowSeconds >= exp) return null;

  return {
    callerId,
    subject,
    email: text(claims, "email"),
    name: text(claims, "name"),
    sid: text(claims, "sid"),
    exp,
  };
}

export function readLoginState(
  key: Buffer,
  cookie: string | undefined,
  nowSeconds: number,
): LoginState | null {
  const claims = record(unseal(key, cookie));
  if (claims === null) return null;

  const state = text(claims, "state");
  const verifier = text(claims, "verifier");
  const exp = claims["exp"];
  if (state === null || verifier === null || typeof exp !== "number") return null;
  if (nowSeconds >= exp) return null;

  return { state, verifier, exp };
}

/**
 * Bound to the session, so a token minted for one visitor is useless in
 * another's form, and derived rather than stored, so there is still nothing to
 * keep on the server.
 */
export function csrfToken(key: Buffer, session: PortalSession): string {
  return createHmac("sha256", key)
    .update(`csrf:${session.callerId}:${session.exp}`)
    .digest("base64url");
}

export interface CookieOptions {
  maxAgeSeconds: number;
  secure: boolean;
  path: string;
}

export function cookie(name: string, value: string, options: CookieOptions): string {
  return [
    `${name}=${value}`,
    `Path=${options.path}`,
    `Max-Age=${options.maxAgeSeconds}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(options.secure ? ["Secure"] : []),
  ].join("; ");
}

export function clearedCookie(name: string, path: string, secure: boolean): string {
  return cookie(name, "", { maxAgeSeconds: 0, secure, path });
}

/** RFC 6265 is generous about spacing; anything unparseable is simply absent. */
export function parseCookies(header: string | undefined): Map<string, string> {
  const jar = new Map<string, string>();
  if (header === undefined) return jar;

  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    if (name === "" || jar.has(name)) continue;
    jar.set(name, part.slice(separator + 1).trim());
  }
  return jar;
}
