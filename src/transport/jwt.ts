/**
 * RS/PS-signed JWT verification on WebCrypto, plus the JWKS cache behind it.
 * No JWT library is used; ADR 0017 records that decision and the specific
 * attacks this file has to close on its own — chiefly algorithm confusion,
 * which is why {@link ALGORITHMS} is a constant allowlist of asymmetric
 * algorithms and never reads a preference off the token.
 */

import { webcrypto } from "node:crypto";

export interface JwtHeader {
  alg: string;
  kid?: string;
  typ?: string;
  crit?: unknown;
}

export type JwtClaims = Readonly<Record<string, unknown>>;

/** The subset of a JWK this server will use to verify a signature. */
export interface SigningJwk {
  kty: string;
  kid?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
}

/** The token itself is unacceptable; the caller answers 401. */
export class TokenRejected extends Error {
  override readonly name = "TokenRejected";
}

/** We could not reach the keys, so the token is unproven rather than bad. */
export class KeysUnavailable extends Error {
  override readonly name = "KeysUnavailable";
}

interface AlgorithmSpec {
  readonly importParams: { name: string; hash: string };
  readonly verifyParams: { name: string; saltLength?: number };
}

const ALGORITHMS: Readonly<Record<string, AlgorithmSpec>> = {
  RS256: {
    importParams: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    verifyParams: { name: "RSASSA-PKCS1-v1_5" },
  },
  RS384: {
    importParams: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-384" },
    verifyParams: { name: "RSASSA-PKCS1-v1_5" },
  },
  RS512: {
    importParams: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-512" },
    verifyParams: { name: "RSASSA-PKCS1-v1_5" },
  },
  PS256: {
    importParams: { name: "RSA-PSS", hash: "SHA-256" },
    verifyParams: { name: "RSA-PSS", saltLength: 32 },
  },
  PS384: {
    importParams: { name: "RSA-PSS", hash: "SHA-384" },
    verifyParams: { name: "RSA-PSS", saltLength: 48 },
  },
  PS512: {
    importParams: { name: "RSA-PSS", hash: "SHA-512" },
    verifyParams: { name: "RSA-PSS", saltLength: 64 },
  },
};

export const SUPPORTED_ALGORITHMS = Object.freeze(Object.keys(ALGORITHMS));

export interface ParsedJwt {
  header: JwtHeader;
  claims: JwtClaims;
  signingInput: string;
  signature: Buffer;
}

/**
 * Splits and decodes a compact JWS without proving anything about it. Every
 * value it returns is still attacker-controlled until {@link verifyJwt} has run.
 */
export function parseJwt(token: string): ParsedJwt {
  const segments = token.split(".");
  if (segments.length !== 3) {
    throw new TokenRejected(
      "The bearer token is not a JWT: a compact JWS has three dot-separated segments.",
    );
  }

  const [rawHeader, rawPayload, rawSignature] = segments as [string, string, string];
  const header = decodeJson(rawHeader, "header") as unknown as JwtHeader;
  const claims = decodeJson(rawPayload, "payload") as JwtClaims;

  if (typeof header.alg !== "string") {
    throw new TokenRejected("The token header has no alg.");
  }
  if (header.crit !== undefined) {
    throw new TokenRejected(
      "The token header carries crit, and this server implements no critical extensions.",
    );
  }
  if (typeof header.typ === "string" && !isJwtType(header.typ)) {
    throw new TokenRejected(`The token header declares typ ${header.typ}, not a JWT.`);
  }

  return {
    header,
    claims,
    signingInput: `${rawHeader}.${rawPayload}`,
    signature: decodeSegment(rawSignature, "signature"),
  };
}

function isJwtType(typ: string): boolean {
  const normalised = typ.toLowerCase();
  return (
    normalised === "jwt" ||
    normalised === "at+jwt" ||
    normalised === "application/at+jwt"
  );
}

/**
 * Verifies the signature of an already-parsed token against a JWK.
 *
 * The algorithm is taken from the allowlist by name and the key is imported as
 * RSA, so a token asking for `none`, or for an HMAC over the public key, has
 * nowhere to land: it is refused before any key material is touched.
 */
export async function verifyJwt(parsed: ParsedJwt, jwk: SigningJwk): Promise<void> {
  const spec = ALGORITHMS[parsed.header.alg];
  if (!spec) {
    throw new TokenRejected(
      `The token is signed with ${parsed.header.alg}, and this server accepts only ${SUPPORTED_ALGORITHMS.join(", ")}.`,
    );
  }
  if (jwk.kty !== "RSA") {
    throw new TokenRejected(`The signing key is ${jwk.kty}, not RSA.`);
  }
  if (jwk.use !== undefined && jwk.use !== "sig") {
    throw new TokenRejected(
      "The signing key is published for encryption, not signing.",
    );
  }
  if (jwk.alg !== undefined && jwk.alg !== parsed.header.alg) {
    throw new TokenRejected(
      `The token is signed with ${parsed.header.alg}, but its key is published for ${jwk.alg}.`,
    );
  }

  const key = await webcrypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: parsed.header.alg, ext: true },
    spec.importParams,
    false,
    ["verify"],
  );

  const verified = await webcrypto.subtle.verify(
    spec.verifyParams,
    key,
    parsed.signature,
    Buffer.from(parsed.signingInput, "ascii"),
  );

  if (!verified) {
    throw new TokenRejected("The token signature does not match the tenant's key.");
  }
}

function decodeJson(segment: string, what: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeSegment(segment, what).toString("utf8"));
  } catch {
    throw new TokenRejected(`The token ${what} is not JSON.`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TokenRejected(`The token ${what} is not a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function decodeSegment(segment: string, what: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) {
    throw new TokenRejected(`The token ${what} is not base64url.`);
  }
  return Buffer.from(segment, "base64url");
}

export type FetchLike = (
  input: string,
  init?: { signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface SigningKeysOptions {
  /**
   * Discovery documents to try, in order, until one advertises a `jwks_uri`.
   * There is more than one because issuers differ on which well-known path they
   * publish: Entra has OpenID Connect discovery, WorkOS AuthKit documents only
   * the RFC 8414 authorization-server document.
   */
  metadataUrls: readonly string[];
  fetch?: FetchLike;
  now?: () => number;
  cacheTtlMs?: number;
  /**
   * The floor between two key fetches. Without it, tokens naming keys that do
   * not exist would be a free way to make this server hammer the tenant.
   */
  minRefreshIntervalMs?: number;
  requestTimeoutMs?: number;
}

export const DEFAULT_JWKS_CACHE_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_JWKS_MIN_REFRESH_INTERVAL_MS = 60 * 1000;
export const DEFAULT_METADATA_TIMEOUT_MS = 5000;

/**
 * The tenant's signing keys, cached and refreshed on rotation. A key id we have
 * never seen is the rotation signal — it triggers one refresh, no more often
 * than {@link SigningKeysOptions.minRefreshIntervalMs}.
 */
export class SigningKeys {
  readonly #options: Required<Omit<SigningKeysOptions, "fetch">> & { fetch: FetchLike };
  #keys: Map<string, SigningJwk> = new Map();
  #fetchedAt = -Infinity;
  #inFlight: Promise<void> | null = null;
  #jwksUri: string | null = null;

  constructor(options: SigningKeysOptions) {
    if (options.metadataUrls.length === 0) {
      throw new Error("SigningKeys needs at least one discovery document URL.");
    }
    this.#options = {
      metadataUrls: options.metadataUrls,
      fetch: options.fetch ?? ((input, init) => globalThis.fetch(input, init)),
      now: options.now ?? Date.now,
      cacheTtlMs: options.cacheTtlMs ?? DEFAULT_JWKS_CACHE_TTL_MS,
      minRefreshIntervalMs:
        options.minRefreshIntervalMs ?? DEFAULT_JWKS_MIN_REFRESH_INTERVAL_MS,
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_METADATA_TIMEOUT_MS,
    };
  }

  async find(kid: string): Promise<SigningJwk> {
    const age = this.#options.now() - this.#fetchedAt;
    if (age >= this.#options.cacheTtlMs) await this.#refresh();

    const known = this.#keys.get(kid);
    if (known) return known;

    if (this.#options.now() - this.#fetchedAt >= this.#options.minRefreshIntervalMs) {
      await this.#refresh();
      const rotated = this.#keys.get(kid);
      if (rotated) return rotated;
    }

    throw new TokenRejected(
      `The token names signing key ${kid}, which the authorization server does not publish.`,
    );
  }

  async #refresh(): Promise<void> {
    this.#inFlight ??= this.#load().finally(() => {
      this.#inFlight = null;
    });
    await this.#inFlight;
  }

  async #load(): Promise<void> {
    this.#jwksUri ??= await this.#discoverJwksUri();

    const document = await this.#get(this.#jwksUri);
    const keys = (document as { keys?: unknown }).keys;
    if (!Array.isArray(keys)) {
      throw new KeysUnavailable(`${this.#jwksUri} has no keys array.`);
    }

    const usable = new Map<string, SigningJwk>();
    for (const entry of keys) {
      const jwk = entry as SigningJwk;
      if (jwk?.kty === "RSA" && typeof jwk.kid === "string") usable.set(jwk.kid, jwk);
    }

    this.#keys = usable;
    this.#fetchedAt = this.#options.now();
  }

  /**
   * The first configured document that answers and names a `jwks_uri` wins; the
   * others exist because issuers publish different well-known paths, so a
   * failure on one of them is a miss and not an outage. Only when every one has
   * failed is the reason reported, and it is the last one's.
   */
  async #discoverJwksUri(): Promise<string> {
    let lastFailure: unknown;

    for (const url of this.#options.metadataUrls) {
      try {
        return jwksUriFrom(await this.#get(url), url);
      } catch (failure) {
        lastFailure = failure;
      }
    }

    throw lastFailure instanceof Error
      ? lastFailure
      : new KeysUnavailable(
          `None of ${this.#options.metadataUrls.join(", ")} advertises a jwks_uri.`,
        );
  }

  async #get(url: string): Promise<unknown> {
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await this.#options.fetch(url, {
        signal: AbortSignal.timeout(this.#options.requestTimeoutMs),
      });
    } catch (cause) {
      throw new KeysUnavailable(
        `Could not reach ${url}: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    }

    if (!response.ok) {
      throw new KeysUnavailable(`${url} answered ${response.status}.`);
    }

    try {
      return await response.json();
    } catch (cause) {
      throw new KeysUnavailable(`${url} did not answer with JSON.`, { cause });
    }
  }
}

function jwksUriFrom(metadata: unknown, url: string): string {
  const uri = (metadata as { jwks_uri?: unknown }).jwks_uri;
  if (typeof uri !== "string" || uri === "") {
    throw new KeysUnavailable(`${url} does not advertise a jwks_uri.`);
  }
  return uri;
}
