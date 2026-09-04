import { describe, expect, it } from "vitest";
import { authSettingsFromEnv, type AuthSettings } from "../../src/transport/auth.js";
import {
  DEFAULT_AUTHORIZE_URL,
  DEFAULT_CLIENT_SECRET_NAME,
  DEFAULT_TOKEN_URL,
  portalSettingsFromEnv,
} from "../../src/portal/settings.js";

const auth: AuthSettings = authSettingsFromEnv({
  IMAGINE_AUTH_ISSUER: "https://example.authkit.app",
  IMAGINE_AUTH_AUDIENCE: "https://imagine.example.com/mcp",
}) as AuthSettings;

describe("portalSettingsFromEnv", () => {
  it("is off by default, with nothing to warn about", () => {
    expect(portalSettingsFromEnv({}, auth)).toEqual({ enabled: false, warning: null });
  });

  it("refuses to exist without authentication, and says why", () => {
    const outcome = portalSettingsFromEnv({ IMAGINE_PORTAL_ENABLED: "true" }, null);
    expect(outcome.enabled).toBe(false);
    expect(outcome.enabled === false && outcome.warning).toContain("404");
  });

  it("throws when it is switched on without a client id", () => {
    expect(() =>
      portalSettingsFromEnv({ IMAGINE_PORTAL_ENABLED: "true" }, auth),
    ).toThrow(/IMAGINE_PORTAL_WORKOS_CLIENT_ID/);
  });

  it("throws when it cannot work out its own public URL", () => {
    const bare = authSettingsFromEnv({
      IMAGINE_AUTH_ISSUER: "https://example.authkit.app",
      IMAGINE_AUTH_AUDIENCE: "api://something",
    }) as AuthSettings;

    expect(() =>
      portalSettingsFromEnv(
        {
          IMAGINE_PORTAL_ENABLED: "true",
          IMAGINE_PORTAL_WORKOS_CLIENT_ID: "client_01",
        },
        bare,
      ),
    ).toThrow(/public URL/);
  });

  it("derives the redirect URI from the audience when nothing else says", () => {
    const outcome = portalSettingsFromEnv(
      {
        IMAGINE_PORTAL_ENABLED: "true",
        IMAGINE_PORTAL_WORKOS_CLIENT_ID: "client_01",
      },
      auth,
    );

    expect(outcome.enabled).toBe(true);
    if (!outcome.enabled) return;

    expect(outcome.settings.baseUrl).toBe("https://imagine.example.com");
    expect(outcome.settings.resource).toBe("https://imagine.example.com/portal");
    expect(outcome.settings.redirectUri).toBe(
      "https://imagine.example.com/portal/auth/callback",
    );
    expect(outcome.settings.authorizeUrl).toBe(DEFAULT_AUTHORIZE_URL);
    expect(outcome.settings.tokenUrl).toBe(DEFAULT_TOKEN_URL);
    expect(outcome.settings.clientSecretName).toBe(DEFAULT_CLIENT_SECRET_NAME);
    expect(outcome.settings.sessionSecret).toBeNull();
  });

  it("prefers an explicit public URL over the audience", () => {
    const outcome = portalSettingsFromEnv(
      {
        IMAGINE_PORTAL_ENABLED: "1",
        IMAGINE_PORTAL_WORKOS_CLIENT_ID: "client_01",
        IMAGINE_PUBLIC_URL: "https://elsewhere.example/",
        IMAGINE_PORTAL_SESSION_SECRET: "  keep-me  ",
      },
      auth,
    );

    expect(outcome.enabled === true && outcome.settings.baseUrl).toBe(
      "https://elsewhere.example",
    );
    expect(outcome.enabled === true && outcome.settings.sessionSecret).toBe("keep-me");
  });

  it("lets an operator turn the logout redirect off entirely", () => {
    const outcome = portalSettingsFromEnv(
      {
        IMAGINE_PORTAL_ENABLED: "true",
        IMAGINE_PORTAL_WORKOS_CLIENT_ID: "client_01",
        IMAGINE_PORTAL_LOGOUT_URL: "",
      },
      auth,
    );
    expect(outcome.enabled === true && outcome.settings.logoutUrl).toBeNull();
  });
});
