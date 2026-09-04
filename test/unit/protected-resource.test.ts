import { describe, expect, it } from "vitest";
import { DEFAULT_REQUIRED_SCOPE, type AuthSettings } from "../../src/transport/auth.js";
import {
  PROTECTED_RESOURCE_PATH,
  canonicalResourceUrl,
  metadataUrlFor,
  protectedResourceFor,
  protectedResourceFromEnv,
} from "../../src/transport/protected-resource.js";

const TENANT = "11111111-2222-3333-4444-555555555555";

function settings(overrides: Partial<AuthSettings> = {}): AuthSettings {
  return {
    tenantId: TENANT,
    issuer: `https://login.microsoftonline.com/${TENANT}/v2.0`,
    audiences: ["https://imagine.example/mcp", `api://${TENANT}`],
    requiredScopes: [DEFAULT_REQUIRED_SCOPE],
    metadataUrls: [
      `https://login.microsoftonline.com/${TENANT}/v2.0/.well-known/openid-configuration`,
    ],
    ...overrides,
  };
}

const options = { mcpPath: "/mcp" };

describe("canonicalResourceUrl", () => {
  it("lower-cases the scheme and host and keeps the path", () => {
    expect(canonicalResourceUrl("HTTPS://Imagine.Example/mcp")).toBe(
      "https://imagine.example/mcp",
    );
  });

  it("drops a trailing slash, a query and a fragment", () => {
    expect(canonicalResourceUrl("https://imagine.example/mcp/?a=1#frag")).toBe(
      "https://imagine.example/mcp",
    );
  });

  it("drops a default port and keeps a non-default one", () => {
    expect(canonicalResourceUrl("https://imagine.example:443/mcp")).toBe(
      "https://imagine.example/mcp",
    );
    expect(canonicalResourceUrl("http://127.0.0.1:3000/mcp")).toBe(
      "http://127.0.0.1:3000/mcp",
    );
  });

  it("refuses anything that is not an absolute http(s) URL", () => {
    expect(() => canonicalResourceUrl("imagine.example/mcp")).toThrow(/absolute URL/);
    expect(() => canonicalResourceUrl(`api://${TENANT}`)).toThrow(/http or https/);
  });
});

describe("metadataUrlFor", () => {
  it("inserts the well-known segment before the resource path", () => {
    expect(metadataUrlFor("https://imagine.example/mcp")).toBe(
      `https://imagine.example${PROTECTED_RESOURCE_PATH}/mcp`,
    );
  });

  it("is the bare well-known path when the resource has none", () => {
    expect(metadataUrlFor("https://imagine.example/")).toBe(
      `https://imagine.example${PROTECTED_RESOURCE_PATH}`,
    );
  });
});

describe("protectedResourceFor", () => {
  const resource = protectedResourceFor("https://imagine.example/mcp", settings());

  it("publishes the endpoint URL as the resource, exactly", () => {
    expect(resource.document.resource).toBe("https://imagine.example/mcp");
  });

  it("names exactly one authorization server, the tenant issuer", () => {
    expect(resource.document.authorization_servers).toEqual([
      `https://login.microsoftonline.com/${TENANT}/v2.0`,
    ]);
  });

  it("reports the scope the server actually requires, and header bearers", () => {
    expect(resource.document.scopes_supported).toEqual(["access_as_user"]);
    expect(resource.document.bearer_methods_supported).toEqual(["header"]);
  });

  it("serves the path-suffixed spelling first and the bare one as well", () => {
    expect(resource.paths).toEqual([
      `${PROTECTED_RESOURCE_PATH}/mcp`,
      PROTECTED_RESOURCE_PATH,
    ]);
    expect(resource.metadataUrl).toBe(
      `https://imagine.example${PROTECTED_RESOURCE_PATH}/mcp`,
    );
  });

  it("names the configured issuer, whoever that is, in issuer mode", () => {
    const workos = protectedResourceFor(
      "https://imagine.example/mcp",
      settings({
        tenantId: null,
        issuer: "https://imagine-test.authkit.app",
        requiredScopes: [],
        metadataUrls: [
          "https://imagine-test.authkit.app/.well-known/oauth-authorization-server",
        ],
      }),
    );

    expect(workos.document.authorization_servers).toEqual([
      "https://imagine-test.authkit.app",
    ]);
  });

  it("omits scopes_supported entirely when no scope is required", () => {
    const open = protectedResourceFor(
      "https://imagine.example/mcp",
      settings({ tenantId: null, requiredScopes: [] }),
    );

    expect(open.document.scopes_supported).toBeUndefined();
    expect(Object.keys(open.document)).not.toContain("scopes_supported");
  });

  it("carries every configured scope through", () => {
    const many = protectedResourceFor(
      "https://imagine.example/mcp",
      settings({ requiredScopes: ["access_as_user", "generate"] }),
    );
    expect(many.document.scopes_supported).toEqual(["access_as_user", "generate"]);
  });
});

describe("protectedResourceFromEnv", () => {
  it("publishes nothing when authentication is off", () => {
    expect(
      protectedResourceFromEnv(
        { IMAGINE_PUBLIC_URL: "https://imagine.example" },
        null,
        options,
      ),
    ).toBeNull();
  });

  it("takes IMAGINE_MCP_RESOURCE_URI whole", () => {
    const resource = protectedResourceFromEnv(
      { IMAGINE_MCP_RESOURCE_URI: "https://proxy.example/imagine/mcp/" },
      settings(),
      options,
    );

    expect(resource?.resource).toBe("https://proxy.example/imagine/mcp");
    expect(resource?.metadataUrl).toBe(
      `https://proxy.example${PROTECTED_RESOURCE_PATH}/imagine/mcp`,
    );
  });

  it("appends the MCP path to IMAGINE_PUBLIC_URL", () => {
    const resource = protectedResourceFromEnv(
      { IMAGINE_PUBLIC_URL: "https://imagine.example/" },
      settings(),
      options,
    );

    expect(resource?.resource).toBe("https://imagine.example/mcp");
  });

  it("prefers the explicit resource URI over the public base URL", () => {
    const resource = protectedResourceFromEnv(
      {
        IMAGINE_MCP_RESOURCE_URI: "https://explicit.example/mcp",
        IMAGINE_PUBLIC_URL: "https://base.example",
      },
      settings(),
      options,
    );

    expect(resource?.resource).toBe("https://explicit.example/mcp");
  });

  it("falls back to the first audience that is an http(s) URL", () => {
    const resource = protectedResourceFromEnv({}, settings(), options);

    expect(resource?.resource).toBe("https://imagine.example/mcp");
  });

  it("publishes nothing when no audience is a URL and no public URL is set", () => {
    expect(
      protectedResourceFromEnv(
        {},
        settings({ audiences: [`api://${TENANT}`] }),
        options,
      ),
    ).toBeNull();
  });
});
