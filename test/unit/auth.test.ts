import { generateKeyPairSync, createSign, webcrypto } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_REQUIRED_SCOPE,
  authSettingsFromEnv,
  bearerChallenge,
  canonicalAudience,
  createAuthenticator,
  describeCaller,
  type AuthOutcome,
  type AuthSettings,
  type Authenticator,
} from "../../src/transport/auth.js";
import type { FetchLike } from "../../src/transport/jwt.js";

const TENANT = "11111111-2222-3333-4444-555555555555";
const ISSUER = `https://login.microsoftonline.com/${TENANT}/v2.0`;
const AUDIENCE = "https://imagine.example.com/mcp";
const METADATA_URL = `${ISSUER}/.well-known/openid-configuration`;
const JWKS_URI = `https://login.microsoftonline.com/${TENANT}/discovery/v2.0/keys`;
const NOW_MS = Date.UTC(2026, 7, 28, 12, 0, 0);
const NOW_SECONDS = Math.floor(NOW_MS / 1000);

const settings: AuthSettings = {
  tenantId: TENANT,
  issuer: ISSUER,
  audiences: [AUDIENCE],
  requiredScopes: [DEFAULT_REQUIRED_SCOPE],
  metadataUrls: [METADATA_URL],
};

// A non-Entra authorization server, shaped like a WorkOS AuthKit instance: the
// issuer is a bare https origin, discovery hangs off it, and the token has no
// tid and no oid (ADR 0023).
const AUTHKIT_ISSUER = "https://imagine-test.authkit.app";
const AUTHKIT_METADATA_URL = `${AUTHKIT_ISSUER}/.well-known/oauth-authorization-server`;
const AUTHKIT_OIDC_METADATA_URL = `${AUTHKIT_ISSUER}/.well-known/openid-configuration`;
const AUTHKIT_JWKS_URI = `${AUTHKIT_ISSUER}/oauth2/jwks`;

const issuerSettings: AuthSettings = {
  tenantId: null,
  issuer: AUTHKIT_ISSUER,
  audiences: [AUDIENCE],
  requiredScopes: [],
  metadataUrls: [AUTHKIT_METADATA_URL, AUTHKIT_OIDC_METADATA_URL],
};

interface TestKey {
  kid: string;
  jwk: Record<string, unknown>;
  privateKeyPem: string;
}

function makeKey(kid: string): TestKey {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const exported = publicKey.export({ format: "jwk" }) as Record<string, unknown>;

  return {
    kid,
    jwk: { ...exported, kid, use: "sig", alg: "RS256" },
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

const signingKey = makeKey("key-1");
const rotatedKey = makeKey("key-2");
const strangerKey = makeKey("key-1");

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function sign(
  key: TestKey,
  claims: Record<string, unknown>,
  header: Record<string, unknown> = {},
): string {
  const encodedHeader = base64url(
    JSON.stringify({ alg: "RS256", typ: "JWT", kid: key.kid, ...header }),
  );
  const encodedClaims = base64url(JSON.stringify(claims));
  const signingInput = `${encodedHeader}.${encodedClaims}`;

  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  return `${signingInput}.${signer.sign(key.privateKeyPem, "base64url")}`;
}

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: ISSUER,
    aud: AUDIENCE,
    tid: TENANT,
    sub: "sub-abc",
    oid: "oid-abc",
    preferred_username: "mark@example.com",
    scp: DEFAULT_REQUIRED_SCOPE,
    iat: NOW_SECONDS - 60,
    nbf: NOW_SECONDS - 60,
    exp: NOW_SECONDS + 3600,
    ...overrides,
  };
}

let published: TestKey[];
let requests: string[];
/** Which of the two well-known documents the fake issuer serves. */
let authkitDiscoveryUrl: string;

const fetchJwks: FetchLike = (url) => {
  requests.push(url);

  if (url === authkitDiscoveryUrl) {
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({ issuer: AUTHKIT_ISSUER, jwks_uri: AUTHKIT_JWKS_URI }),
    });
  }
  if (url === AUTHKIT_JWKS_URI) {
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ keys: published.map((key) => key.jwk) }),
    });
  }
  if (url === METADATA_URL) {
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ issuer: ISSUER, jwks_uri: JWKS_URI }),
    });
  }
  if (url === JWKS_URI) {
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ keys: published.map((key) => key.jwk) }),
    });
  }
  return Promise.resolve({
    ok: false,
    status: 404,
    json: () => Promise.reject(new Error("no body")),
  });
};

function authenticator(overrides: Partial<AuthSettings> = {}): Authenticator {
  return createAuthenticator(
    { ...settings, ...overrides },
    { fetch: fetchJwks, now: () => NOW_MS, minRefreshIntervalMs: 0 },
  );
}

function refused(outcome: AuthOutcome): Extract<AuthOutcome, { ok: false }> {
  if (outcome.ok) throw new Error("Expected the token to be refused.");
  return outcome;
}

beforeEach(() => {
  published = [signingKey, rotatedKey];
  requests = [];
  authkitDiscoveryUrl = AUTHKIT_METADATA_URL;
});

function issuerModeAuthenticator(overrides: Partial<AuthSettings> = {}): Authenticator {
  return createAuthenticator(
    { ...issuerSettings, ...overrides },
    { fetch: fetchJwks, now: () => NOW_MS, minRefreshIntervalMs: 0 },
  );
}

/** What an AuthKit access token for an MCP resource looks like. */
function issuerClaims(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    iss: AUTHKIT_ISSUER,
    aud: AUDIENCE,
    sub: "user_01HBEQKA6K4QJAS93VPE39W1JT",
    sid: "session_01HQSXZGF8FHF7A9ZZFCW4387R",
    email: "mark@example.com",
    name: "Mark Verheul",
    iat: NOW_SECONDS - 60,
    exp: NOW_SECONDS + 3600,
    ...overrides,
  };
}

describe("authSettingsFromEnv", () => {
  it("is off when nothing is configured", () => {
    expect(authSettingsFromEnv({})).toBeNull();
    expect(authSettingsFromEnv({ IMAGINE_AUTH_TENANT_ID: "   " })).toBeNull();
  });

  it("derives the issuer and the metadata URL from the tenant", () => {
    expect(
      authSettingsFromEnv({
        IMAGINE_AUTH_TENANT_ID: TENANT,
        IMAGINE_AUTH_AUDIENCE: AUDIENCE,
      }),
    ).toEqual({
      tenantId: TENANT,
      issuer: ISSUER,
      audiences: [AUDIENCE],
      requiredScopes: [DEFAULT_REQUIRED_SCOPE],
      metadataUrls: [METADATA_URL],
    });
  });

  it("keeps the tenant's discovery document when the issuer is overridden", () => {
    expect(
      authSettingsFromEnv({
        IMAGINE_AUTH_TENANT_ID: TENANT,
        IMAGINE_AUTH_ISSUER: `https://sts.windows.net/${TENANT}/`,
        IMAGINE_AUTH_AUDIENCE: AUDIENCE,
      })?.metadataUrls,
    ).toEqual([METADATA_URL]);
  });

  it("takes an explicit issuer, several audiences and several permissions", () => {
    expect(
      authSettingsFromEnv({
        IMAGINE_AUTH_TENANT_ID: TENANT,
        IMAGINE_AUTH_ISSUER: `https://sts.windows.net/${TENANT}/`,
        IMAGINE_AUTH_AUDIENCE: `${AUDIENCE}/, api://Client-Id`,
        IMAGINE_AUTH_REQUIRED_SCOPE: "access_as_user, images.write",
      }),
    ).toMatchObject({
      issuer: `https://sts.windows.net/${TENANT}/`,
      audiences: [AUDIENCE, "api://client-id"],
      requiredScopes: ["access_as_user", "images.write"],
    });
  });

  it("refuses to run half configured rather than failing open", () => {
    expect(() => authSettingsFromEnv({ IMAGINE_AUTH_AUDIENCE: AUDIENCE })).toThrow(
      /IMAGINE_AUTH_TENANT_ID/,
    );
    expect(() => authSettingsFromEnv({ IMAGINE_AUTH_TENANT_ID: TENANT })).toThrow(
      /IMAGINE_AUTH_AUDIENCE/,
    );
    expect(() => authSettingsFromEnv({ IMAGINE_AUTH_ISSUER: AUTHKIT_ISSUER })).toThrow(
      /IMAGINE_AUTH_AUDIENCE/,
    );
    expect(() =>
      authSettingsFromEnv({ IMAGINE_AUTH_METADATA_URL: AUTHKIT_METADATA_URL }),
    ).toThrow(/IMAGINE_AUTH_ISSUER/);
  });
});

describe("authSettingsFromEnv in issuer mode", () => {
  it("needs no tenant, and derives both well-known documents from the issuer", () => {
    expect(
      authSettingsFromEnv({
        IMAGINE_AUTH_ISSUER: AUTHKIT_ISSUER,
        IMAGINE_AUTH_AUDIENCE: AUDIENCE,
      }),
    ).toEqual({
      tenantId: null,
      issuer: AUTHKIT_ISSUER,
      audiences: [AUDIENCE],
      requiredScopes: [],
      metadataUrls: [AUTHKIT_METADATA_URL, AUTHKIT_OIDC_METADATA_URL],
    });
  });

  it("does not default the required scope, because the issuer may publish none", () => {
    expect(
      authSettingsFromEnv({
        IMAGINE_AUTH_ISSUER: AUTHKIT_ISSUER,
        IMAGINE_AUTH_AUDIENCE: AUDIENCE,
      })?.requiredScopes,
    ).toEqual([]);

    expect(
      authSettingsFromEnv({
        IMAGINE_AUTH_ISSUER: AUTHKIT_ISSUER,
        IMAGINE_AUTH_AUDIENCE: AUDIENCE,
        IMAGINE_AUTH_REQUIRED_SCOPE: "images.write",
      })?.requiredScopes,
    ).toEqual(["images.write"]);
  });

  it("lets IMAGINE_AUTH_METADATA_URL replace the derivation outright", () => {
    expect(
      authSettingsFromEnv({
        IMAGINE_AUTH_ISSUER: AUTHKIT_ISSUER,
        IMAGINE_AUTH_AUDIENCE: AUDIENCE,
        IMAGINE_AUTH_METADATA_URL: "https://elsewhere.example/config",
      })?.metadataUrls,
    ).toEqual(["https://elsewhere.example/config"]);
  });

  it("drops a trailing slash on the issuer before appending the well-known path", () => {
    expect(
      authSettingsFromEnv({
        IMAGINE_AUTH_ISSUER: `${AUTHKIT_ISSUER}/`,
        IMAGINE_AUTH_AUDIENCE: AUDIENCE,
      })?.metadataUrls,
    ).toEqual([AUTHKIT_METADATA_URL, AUTHKIT_OIDC_METADATA_URL]);
  });

  it("refuses an issuer that is not an absolute http(s) URL", () => {
    expect(() =>
      authSettingsFromEnv({
        IMAGINE_AUTH_ISSUER: "imagine-test.authkit.app",
        IMAGINE_AUTH_AUDIENCE: AUDIENCE,
      }),
    ).toThrow(/absolute https URL/);
  });
});

describe("a token from a non-Entra issuer", () => {
  it("is accepted, and identifies its caller by issuer and subject", async () => {
    const outcome = await issuerModeAuthenticator()(
      `Bearer ${sign(signingKey, issuerClaims())}`,
    );

    if (!outcome.ok) throw new Error(outcome.message);
    expect(outcome.caller).toMatchObject({
      callerId: `${AUTHKIT_ISSUER}:user_01HBEQKA6K4QJAS93VPE39W1JT`,
      subject: "user_01HBEQKA6K4QJAS93VPE39W1JT",
      objectId: null,
      tenantId: null,
      email: "mark@example.com",
      name: "Mark Verheul",
      username: "mark@example.com",
      scopes: [],
      roles: [],
      audience: AUDIENCE,
      issuer: AUTHKIT_ISSUER,
    });
  });

  it("falls back to the OpenID document when the RFC 8414 one is absent", async () => {
    authkitDiscoveryUrl = AUTHKIT_OIDC_METADATA_URL;

    const outcome = await issuerModeAuthenticator()(
      `Bearer ${sign(signingKey, issuerClaims())}`,
    );

    expect(outcome.ok).toBe(true);
    expect(requests.slice(0, 3)).toEqual([
      AUTHKIT_METADATA_URL,
      AUTHKIT_OIDC_METADATA_URL,
      AUTHKIT_JWKS_URI,
    ]);
  });

  it("skips the tenant check only because no tenant is configured", async () => {
    const foreign = sign(
      signingKey,
      issuerClaims({ tid: "99999999-9999-9999-9999-999999999999" }),
    );

    expect((await issuerModeAuthenticator()(`Bearer ${foreign}`)).ok).toBe(true);

    const guarded = refused(
      await issuerModeAuthenticator({ tenantId: TENANT })(`Bearer ${foreign}`),
    );
    expect(guarded.status).toBe(401);
    expect(guarded.message).toMatch(/tenant/);
  });

  it("still refuses another issuer, another audience and an expired token", async () => {
    const cases = [
      issuerClaims({ iss: "https://evil.example" }),
      issuerClaims({ aud: "https://other.example/mcp" }),
      issuerClaims({ exp: NOW_SECONDS - 3600 }),
    ];

    for (const payload of cases) {
      const outcome = refused(
        await issuerModeAuthenticator()(`Bearer ${sign(signingKey, payload)}`),
      );
      expect(outcome.status).toBe(401);
    }
  });

  it("enforces a required scope in issuer mode too, once one is configured", async () => {
    const authenticate = issuerModeAuthenticator({ requiredScopes: ["images.write"] });

    const outcome = refused(
      await authenticate(`Bearer ${sign(signingKey, issuerClaims())}`),
    );
    expect(outcome.status).toBe(403);

    const granted = await authenticate(
      `Bearer ${sign(signingKey, issuerClaims({ scope: "openid images.write" }))}`,
    );
    expect(granted.ok).toBe(true);
  });

  it("keeps the tenant-shaped caller id when a tenant is configured after all", async () => {
    const outcome = await issuerModeAuthenticator({ tenantId: TENANT })(
      `Bearer ${sign(signingKey, issuerClaims())}`,
    );

    if (!outcome.ok) throw new Error(outcome.message);
    expect(outcome.caller.callerId).toBe(`${TENANT}:user_01HBEQKA6K4QJAS93VPE39W1JT`);
  });
});

describe("canonicalAudience", () => {
  it("compares resources, not bytes", () => {
    expect(canonicalAudience("https://Imagine.Example.com/mcp/")).toBe(AUDIENCE);
    expect(canonicalAudience("  api://GUID  ")).toBe("api://guid");
  });

  it("keeps the path, which Entra needs for the MCP URL as a resource", () => {
    expect(canonicalAudience("https://imagine.example.com")).not.toBe(AUDIENCE);
    expect(canonicalAudience("https://imagine.example.com/MCP")).not.toBe(AUDIENCE);
  });
});

describe("a valid token", () => {
  it("passes and exposes the caller identity", async () => {
    const outcome = await authenticator()(`Bearer ${sign(signingKey, claims())}`);

    if (!outcome.ok) throw new Error(outcome.message);
    expect(outcome.caller).toMatchObject({
      callerId: `${TENANT}:oid-abc`,
      subject: "sub-abc",
      objectId: "oid-abc",
      tenantId: TENANT,
      username: "mark@example.com",
      scopes: [DEFAULT_REQUIRED_SCOPE],
      roles: [],
      audience: AUDIENCE,
      issuer: ISSUER,
      expiresAt: NOW_SECONDS + 3600,
    });
    expect(outcome.caller.claims["iat"]).toBe(NOW_SECONDS - 60);
    expect(describeCaller(outcome.caller)).toBe(`${TENANT}:oid-abc`);
  });

  it("accepts an app role instead of a delegated scope, and names its client", async () => {
    const token = sign(
      signingKey,
      claims({
        scp: undefined,
        roles: ["access_as_user"],
        azp: "agent-client-id",
        oid: "agent-oid",
        preferred_username: undefined,
      }),
    );

    const outcome = await authenticator()(`Bearer ${token}`);

    if (!outcome.ok) throw new Error(outcome.message);
    expect(outcome.caller).toMatchObject({
      callerId: `${TENANT}:agent-oid`,
      clientId: "agent-client-id",
      username: null,
      roles: ["access_as_user"],
    });
  });

  it("accepts an aud array and an audience that differs only in shape", async () => {
    const token = sign(
      signingKey,
      claims({
        aud: ["https://other.example/mcp", "https://IMAGINE.example.com/mcp/"],
      }),
    );

    expect((await authenticator()(`Bearer ${token}`)).ok).toBe(true);
  });

  it("tolerates a small clock skew in both directions", async () => {
    const stale = sign(signingKey, claims({ exp: NOW_SECONDS - 30 }));
    const early = sign(signingKey, claims({ nbf: NOW_SECONDS + 30 }));

    expect((await authenticator()(`Bearer ${stale}`)).ok).toBe(true);
    expect((await authenticator()(`Bearer ${early}`)).ok).toBe(true);
  });

  it("is read with a lower case bearer scheme too", async () => {
    expect((await authenticator()(`bearer ${sign(signingKey, claims())}`)).ok).toBe(
      true,
    );
  });
});

describe("a token that must be refused", () => {
  const cases: [string, () => string][] = [
    ["expired", () => sign(signingKey, claims({ exp: NOW_SECONDS - 3600 }))],
    ["not valid yet", () => sign(signingKey, claims({ nbf: NOW_SECONDS + 3600 }))],
    ["never expiring", () => sign(signingKey, claims({ exp: undefined }))],
    [
      "for another audience",
      () => sign(signingKey, claims({ aud: "api://someone-else" })),
    ],
    [
      "for the same host but another path",
      () => sign(signingKey, claims({ aud: "https://imagine.example.com/other" })),
    ],
    [
      "from another issuer",
      () => sign(signingKey, claims({ iss: "https://evil.example/v2.0" })),
    ],
    [
      "from another tenant",
      () => sign(signingKey, claims({ tid: "99999999-9999-9999-9999-999999999999" })),
    ],
    ["signed by a stranger", () => sign(strangerKey, claims())],
    ["naming an unpublished key", () => sign(makeKey("key-unknown"), claims())],
    ["with no kid at all", () => sign(signingKey, claims(), { kid: undefined })],
    ["tampered with after signing", () => tampered()],
    ["not a JWT at all", () => "this-is-not-a-token"],
    ["with a JSON payload that is not an object", () => notAnObject()],
  ];

  for (const [name, build] of cases) {
    it(`is 401 when it is ${name}`, async () => {
      const outcome = refused(await authenticator()(`Bearer ${build()}`));

      expect(outcome.status).toBe(401);
      expect(outcome.error).toBe("invalid_token");
      expect(bearerChallenge(outcome)).toMatch(/^Bearer error="invalid_token"/);
    });
  }

  it("is 401 for alg none, however the token is dressed up", async () => {
    const header = base64url(JSON.stringify({ alg: "none", typ: "JWT", kid: "key-1" }));
    const payload = base64url(JSON.stringify(claims()));

    const unsigned = refused(await authenticator()(`Bearer ${header}.${payload}.`));
    expect(unsigned.status).toBe(401);

    const withSignature = refused(
      await authenticator()(`Bearer ${header}.${payload}.AAAA`),
    );
    expect(withSignature.status).toBe(401);
    expect(withSignature.message).toMatch(/none/);
  });

  it("is 401 for an HMAC forged with the public key as the secret", async () => {
    const header = base64url(
      JSON.stringify({ alg: "HS256", typ: "JWT", kid: "key-1" }),
    );
    const payload = base64url(JSON.stringify(claims()));
    const secret = Buffer.from(JSON.stringify(signingKey.jwk));
    const key = await webcrypto.subtle.importKey(
      "raw",
      secret,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = await webcrypto.subtle.sign(
      "HMAC",
      key,
      Buffer.from(`${header}.${payload}`, "ascii"),
    );

    const outcome = refused(
      await authenticator()(
        `Bearer ${header}.${payload}.${Buffer.from(mac).toString("base64url")}`,
      ),
    );

    expect(outcome.status).toBe(401);
    expect(outcome.message).toMatch(/RS256/);
  });

  it("is 401 with no error code when the header is missing entirely", async () => {
    const outcome = refused(await authenticator()(undefined));

    expect(outcome.status).toBe(401);
    expect(outcome.error).toBeNull();
    expect(outcome.message).toMatch(/Authorization: Bearer/);
    expect(bearerChallenge(outcome)).toBe("Bearer");
  });

  it("is 401 when the header is not a bearer credential", async () => {
    const outcome = refused(await authenticator()("Basic aGk6dGhlcmU="));

    expect(outcome.status).toBe(401);
    expect(outcome.error).toBe("invalid_request");
  });

  it("is 403 with insufficient_scope when the permission is missing", async () => {
    const token = sign(
      signingKey,
      claims({ scp: "openid profile", roles: ["reader"] }),
    );

    const outcome = refused(await authenticator()(`Bearer ${token}`));

    expect(outcome.status).toBe(403);
    expect(outcome.error).toBe("insufficient_scope");
    expect(bearerChallenge(outcome)).toMatch(/^Bearer error="insufficient_scope"/);
  });

  it("never leaks the token back in the challenge", async () => {
    const token = sign(signingKey, claims({ exp: NOW_SECONDS - 3600 }));

    const outcome = refused(await authenticator()(`Bearer ${token}`));

    expect(bearerChallenge(outcome)).not.toContain(token);
  });
});

describe("the signing keys", () => {
  it("are fetched once and then cached across requests", async () => {
    const authenticate = authenticator();

    await authenticate(`Bearer ${sign(signingKey, claims())}`);
    await authenticate(`Bearer ${sign(rotatedKey, claims())}`);

    expect(requests).toEqual([METADATA_URL, JWKS_URI]);
  });

  it("are refetched when the tenant rotates to a key we have never seen", async () => {
    published = [signingKey];
    const authenticate = authenticator();
    await authenticate(`Bearer ${sign(signingKey, claims())}`);

    published = [signingKey, rotatedKey];
    const outcome = await authenticate(`Bearer ${sign(rotatedKey, claims())}`);

    expect(outcome.ok).toBe(true);
    expect(requests.filter((url) => url === JWKS_URI)).toHaveLength(2);
  });

  it("do not let an unknown kid become a way to hammer the tenant", async () => {
    const authenticate = createAuthenticator(settings, {
      fetch: fetchJwks,
      now: () => NOW_MS,
    });

    await authenticate(`Bearer ${sign(makeKey("nope"), claims())}`);
    await authenticate(`Bearer ${sign(makeKey("nope"), claims())}`);

    expect(requests.filter((url) => url === JWKS_URI)).toHaveLength(1);
  });

  it("answer 503, not 401, when the tenant cannot be reached", async () => {
    const authenticate = createAuthenticator(settings, {
      fetch: () => Promise.reject(new Error("getaddrinfo ENOTFOUND")),
      now: () => NOW_MS,
    });

    const outcome = refused(await authenticate(`Bearer ${sign(signingKey, claims())}`));

    expect(outcome.status).toBe(503);
    expect(outcome.message).toMatch(/signing keys are unreachable/);
  });
});

describe("bearerChallenge", () => {
  it("carries the discovery pointer and the scope, and nothing else, on a missing token", async () => {
    const outcome = refused(await authenticator()(undefined));

    expect(
      bearerChallenge(outcome, {
        resource_metadata:
          "https://imagine.example.com/.well-known/oauth-protected-resource/mcp",
        scope: "access_as_user",
      }),
    ).toBe(
      'Bearer resource_metadata="https://imagine.example.com/.well-known/oauth-protected-resource/mcp", scope="access_as_user"',
    );
  });

  it("keeps the pointer after the error on a token that was refused", async () => {
    const outcome = refused(await authenticator()("Bearer not-a-jwt"));

    expect(
      bearerChallenge(outcome, {
        resource_metadata:
          "https://imagine.example.com/.well-known/oauth-protected-resource/mcp",
      }),
    ).toMatch(
      /^Bearer error="invalid_token", error_description=".+", resource_metadata="https:\/\/imagine\.example\.com\/\.well-known\/oauth-protected-resource\/mcp"$/,
    );
  });

  it("escapes a quote the token tried to smuggle into the header", async () => {
    const token = sign(signingKey, claims({ iss: 'https://evil.example/",foo="bar' }));

    const challenge = bearerChallenge(
      refused(await authenticator()(`Bearer ${token}`)),
    );

    expect(challenge).toContain('\\",foo=\\"bar');
  });
});

function tampered(): string {
  const token = sign(signingKey, claims());
  const [header, , signature] = token.split(".") as [string, string, string];
  return `${header}.${base64url(JSON.stringify(claims({ scp: "admin" })))}.${signature}`;
}

function notAnObject(): string {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "key-1" }));
  return `${header}.${base64url("[1,2,3]")}.AAAA`;
}
