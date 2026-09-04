import { createHash, createSign, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  authorizeUrl,
  createPkcePair,
  exchangeCode,
  identityFrom,
  LoginFailed,
  logoutUrl,
} from "../../src/portal/login.js";
import {
  portalSettingsFromEnv,
  type PortalSettings,
} from "../../src/portal/settings.js";
import {
  authSettingsFromEnv,
  createAuthenticator,
  type AuthSettings,
} from "../../src/transport/auth.js";
import type { FetchLike as JwtFetchLike } from "../../src/transport/jwt.js";

const auth: AuthSettings = authSettingsFromEnv({
  IMAGINE_AUTH_ISSUER: "https://example.authkit.app",
  IMAGINE_AUTH_AUDIENCE: "https://imagine.example.com/mcp",
}) as AuthSettings;

const settings: PortalSettings = (() => {
  const outcome = portalSettingsFromEnv(
    {
      IMAGINE_PORTAL_ENABLED: "true",
      IMAGINE_PORTAL_WORKOS_CLIENT_ID: "client_01",
    },
    auth,
  );
  if (!outcome.enabled) throw new Error("the fixture should be enabled");
  return outcome.settings;
})();

function respond(status: number, body: unknown): typeof globalThis.fetch {
  return (() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    )) as unknown as typeof globalThis.fetch;
}

describe("createPkcePair", () => {
  it("derives the challenge as the S256 hash of the verifier", () => {
    const pair = createPkcePair();
    expect(pair.challenge).toBe(
      createHash("sha256").update(pair.verifier).digest("base64url"),
    );
    expect(pair.verifier.length).toBeGreaterThanOrEqual(43);
    expect(pair.challenge).not.toContain("=");
  });
});

describe("authorizeUrl", () => {
  it("carries the client, the exact redirect URI, the state and the challenge", () => {
    const url = new URL(authorizeUrl(settings, "state-1", "challenge-1"));

    expect(`${url.origin}${url.pathname}`).toBe(
      "https://api.workos.com/user_management/authorize",
    );
    expect(url.searchParams.get("client_id")).toBe("client_01");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://imagine.example.com/portal/auth/callback",
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("provider")).toBe("authkit");
    expect(url.searchParams.get("state")).toBe("state-1");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-1");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });
});

describe("logoutUrl", () => {
  it("returns to the portal, with the session the authorization server named", () => {
    const url = new URL(logoutUrl(settings, "session_01"));
    expect(url.searchParams.get("session_id")).toBe("session_01");
    expect(url.searchParams.get("return_to")).toBe(
      "https://imagine.example.com/portal",
    );
  });

  it("falls back to the portal itself with no session id", () => {
    expect(logoutUrl(settings, null)).toBe("https://imagine.example.com/portal");
  });
});

describe("exchangeCode", () => {
  it("sends PKCE and no client secret when none was put in the vault", async () => {
    let sent: Record<string, unknown> = {};
    const fetchImpl = ((_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body)) as Record<string, unknown>;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: "token",
            user: { id: "user_01", email: "owner@example.com" },
          }),
          { status: 200 },
        ),
      );
    }) as unknown as typeof globalThis.fetch;

    await exchangeCode({
      settings,
      code: "code-1",
      verifier: "verifier-1",
      fetch: fetchImpl,
    });

    expect(sent).toEqual({
      grant_type: "authorization_code",
      client_id: "client_01",
      code: "code-1",
      code_verifier: "verifier-1",
    });
    expect(sent["client_secret"]).toBeUndefined();
  });

  it("includes the client secret only when one was resolved", async () => {
    let sent: Record<string, unknown> = {};
    const fetchImpl = ((_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body)) as Record<string, unknown>;
      return Promise.resolve(new Response(JSON.stringify({ user: { id: "u" } })));
    }) as unknown as typeof globalThis.fetch;

    await exchangeCode({
      settings,
      code: "code-1",
      verifier: "verifier-1",
      clientSecret: "sk_test",
      fetch: fetchImpl,
    });

    expect(sent["client_secret"]).toBe("sk_test");
  });

  it("reads the user out of a successful exchange", async () => {
    const result = await exchangeCode({
      settings,
      code: "c",
      verifier: "v",
      fetch: respond(200, {
        access_token: "token",
        user: {
          id: "user_01",
          email: "owner@example.com",
          first_name: "Mark",
          last_name: "V",
        },
      }),
    });

    expect(result).toEqual({
      accessToken: "token",
      userId: "user_01",
      email: "owner@example.com",
      name: "Mark V",
    });
  });

  it("names what the authorization server refused, without inventing a session", async () => {
    await expect(
      exchangeCode({
        settings,
        code: "c",
        verifier: "v",
        fetch: respond(400, {
          error: "invalid_grant",
          error_description: "The code has already been used.",
        }),
      }),
    ).rejects.toThrow(/invalid_grant: The code has already been used\./);
  });
});

describe("identityFrom", () => {
  const now = 1_700_000_000;

  it("uses the MCP endpoint's own authenticator when the token fits its rules", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    const jwk = publicKey.export({ format: "jwk" }) as { n: string; e: string };

    const claims = {
      iss: "https://example.authkit.app",
      aud: "https://imagine.example.com/mcp",
      sub: "user_01",
      sid: "session_01",
      email: "owner@example.com",
      exp: now + 3600,
    };
    const header = { alg: "RS256", kid: "k1", typ: "JWT" };
    const body = `${base64url(header)}.${base64url(claims)}`;
    const signature = createSign("RSA-SHA256")
      .update(body)
      .sign(privateKey)
      .toString("base64url");

    const fetchImpl: JwtFetchLike = (url) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve(
            url.includes("jwks")
              ? { keys: [{ kty: "RSA", kid: "k1", alg: "RS256", use: "sig", ...jwk }] }
              : { jwks_uri: "https://example.authkit.app/oauth2/jwks" },
          ),
      });

    const identity = await identityFrom(
      {
        accessToken: `${body}.${signature}`,
        userId: "user_01",
        email: "owner@example.com",
        name: null,
      },
      {
        auth,
        authenticate: createAuthenticator(auth, {
          fetch: fetchImpl,
          now: () => now * 1000,
        }),
        nowSeconds: now,
        sessionSeconds: 3600,
      },
    );

    expect(identity.verifiedBy).toBe("token");
    expect(identity.caller.subject).toBe("user_01");
    expect(identity.sid).toBe("session_01");
  });

  it("falls back to the exchange response when the token is not one /mcp accepts", async () => {
    const identity = await identityFrom(
      {
        accessToken: null,
        userId: "user_01",
        email: "Owner@example.com",
        name: "Mark V",
      },
      { auth, nowSeconds: now, sessionSeconds: 3600 },
    );

    expect(identity.verifiedBy).toBe("exchange");
    expect(identity.caller.callerId).toBe("https://example.authkit.app:user_01");
    expect(identity.caller.email).toBe("Owner@example.com");
    expect(identity.caller.expiresAt).toBe(now + 3600);
  });

  it("refuses a login the authorization server completed without naming a user", async () => {
    await expect(
      identityFrom(
        { accessToken: null, userId: null, email: null, name: null },
        { auth, nowSeconds: now, sessionSeconds: 3600 },
      ),
    ).rejects.toBeInstanceOf(LoginFailed);
  });
});

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}
