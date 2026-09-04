/**
 * The portal over a real HTTP server: the login leg, the session cookie, the
 * two CSRF layers, the allowlist, and the promise that no secret value ever
 * comes back out — asserted against whole response bodies and against
 * everything the process logged.
 */

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CostLedger } from "../../src/core/budget.js";
import { DEFAULT_CONFIG, type Config } from "../../src/core/config-schema.js";
import { parseModelKnowledge } from "../../src/core/knowledge.js";
import {
  createSecretResolver,
  type SecretResolver,
  type WritableSecretStore,
} from "../../src/core/secrets.js";
import { createServer, type ServerDependencies } from "../../src/mcp/server.js";
import { StubProvider } from "../../src/providers/stub.js";
import { createAuditLog } from "../../src/portal/audit.js";
import { createPortal } from "../../src/portal/portal.js";
import { CSRF_FIELD } from "../../src/portal/session.js";
import {
  portalSettingsFromEnv,
  type PortalSettings,
} from "../../src/portal/settings.js";
import {
  authSettingsFromEnv,
  createAuthoriser,
  parseAllowlist,
  type AuthSettings,
  type Authoriser,
} from "../../src/transport/auth.js";
import { startHttpServer, type RunningHttpServer } from "../../src/transport/http.js";

const THE_KEY = "sk-or-v1-not-a-real-key-9f3a2b";

const knowledge = parseModelKnowledge({
  schema_version: 1,
  updated: "2026-08-26",
  disclaimer: "Test fixture.",
  models: [
    {
      id: "stub-image-1",
      display_name: "Stub Image 1",
      family: "stub",
      leaderboard: null,
      strengths: {
        text_in_image: 3,
        photoreal: 3,
        illustration: 4,
        diagram: 4,
        fast_bulk: 5,
      },
      typical_latency_s: 1,
      price: {
        per_image_usd: 0.04,
        per_image_usd_4k: null,
        confidence: "indicative",
        checked: "2026-08-26",
      },
      availability: [{ provider: "stub", model_ref: "stub-image-1" }],
      max_size: "1024x1024",
      notes: "Only exists in tests.",
    },
    {
      id: "lantern-1",
      display_name: "Lantern 1",
      family: "stub",
      leaderboard: null,
      strengths: {
        text_in_image: 5,
        photoreal: 3,
        illustration: 3,
        diagram: 3,
        fast_bulk: 2,
      },
      typical_latency_s: 12,
      price: {
        per_image_usd: 0.19,
        per_image_usd_4k: null,
        confidence: "indicative",
        checked: "2026-08-26",
      },
      availability: [
        { provider: "azure", model_ref: "lantern-1" },
        { provider: "openrouter", model_ref: "stub/lantern-1" },
      ],
      max_size: "1536x1024",
      notes: "Only exists in tests.",
    },
    {
      id: "harbour-2",
      display_name: "Harbour 2",
      family: "stub",
      leaderboard: null,
      strengths: {
        text_in_image: 3,
        photoreal: 5,
        illustration: 4,
        diagram: 3,
        fast_bulk: 2,
      },
      typical_latency_s: 40,
      price: {
        per_image_usd: 0.048,
        per_image_usd_4k: null,
        confidence: "indicative",
        checked: "2026-08-26",
      },
      availability: [{ provider: "azure", model_ref: "harbour-2" }],
      max_size: "1024x1024",
      notes: "Only exists in tests.",
    },
    {
      id: "beacon-fast",
      display_name: "Beacon Fast",
      family: "stub",
      leaderboard: null,
      strengths: {
        text_in_image: 2,
        photoreal: 3,
        illustration: 4,
        diagram: 3,
        fast_bulk: 5,
      },
      typical_latency_s: 3,
      price: {
        per_image_usd: 0.02,
        per_image_usd_4k: null,
        confidence: "confirmed",
        checked: "2026-08-26",
      },
      availability: [{ provider: "openrouter", model_ref: "stub/beacon-fast" }],
      max_size: "1024x1024",
      notes: "Only exists in tests.",
    },
  ],
});

const auth: AuthSettings = authSettingsFromEnv({
  IMAGINE_AUTH_ISSUER: "https://example.authkit.app",
  IMAGINE_AUTH_AUDIENCE: "https://imagine.example.com/mcp",
}) as AuthSettings;

const settings: PortalSettings = (() => {
  const outcome = portalSettingsFromEnv(
    {
      IMAGINE_PORTAL_ENABLED: "true",
      IMAGINE_PORTAL_WORKOS_CLIENT_ID: "client_01",
      IMAGINE_PORTAL_SESSION_SECRET: "a-stable-secret-for-the-tests",
    },
    auth,
  );
  if (!outcome.enabled) throw new Error("the fixture should be enabled");
  return outcome.settings;
})();

/** A vault that remembers, so a write can be read back and a read never leaks. */
function fakeVault(): WritableSecretStore & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    get: (name) => Promise.resolve(entries.get(name) ?? null),
    invalidate: () => undefined,
    set: (name, value) => {
      entries.set(name, value);
      return Promise.resolve();
    },
    remove: (name) => {
      entries.delete(name);
      return Promise.resolve();
    },
  };
}

interface Harness {
  server: RunningHttpServer;
  base: string;
  vault: ReturnType<typeof fakeVault>;
  logs: string[];
  secrets: SecretResolver;
  auditFile: string;
}

let directory: string;
let running: RunningHttpServer | undefined;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "imagine-portal-"));
});

afterEach(async () => {
  await running?.close();
  running = undefined;
});

interface HarnessOptions {
  withPortal?: boolean;
  authorise?: Authoriser;
  /** What the token endpoint answers. */
  exchange?: () => Response;
}

async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const config: Config = {
    ...structuredClone(DEFAULT_CONFIG),
    output: { ...DEFAULT_CONFIG.output, dir: directory, manifest: null },
    logging: { ...DEFAULT_CONFIG.logging, cost_log: join(directory, "costs.jsonl") },
  };

  // An Azure resource with two deployments, which is the case the dashboard's
  // model list exists for: the catalogue is bigger than what this resource serves.
  const azure = config.providers["azure"];
  if (azure !== undefined) {
    azure.enabled = true;
    azure.endpoint = "https://example.openai.azure.com";
    azure.deployments = {
      "lantern-1": "lantern-prod",
      "harbour-2": { deployment: "harbour-2-6", dialect: "mai" },
    };
  }

  const vault = fakeVault();
  const secrets = createSecretResolver({ config, env: {}, vault });
  const logs: string[] = [];

  const dependencies: ServerDependencies = {
    config,
    env: {},
    secrets,
    knowledge,
    ledger: new CostLedger({ budget: config.budget }),
    providers: [new StubProvider()],
  };

  const exchange =
    options.exchange ??
    (() =>
      new Response(
        JSON.stringify({
          user: { id: "user_01", email: "owner@example.com", first_name: "Owner" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ));

  const portal = createPortal({
    settings,
    config,
    secrets,
    knowledge,
    auth,
    vault,
    ...(options.authorise ? { authorise: options.authorise } : {}),
    audit: createAuditLog({
      costLog: config.logging.cost_log,
      log: (line) => logs.push(line),
    }),
    fetch: (() => Promise.resolve(exchange())) as unknown as typeof globalThis.fetch,
  });

  running = await startHttpServer({
    host: "127.0.0.1",
    port: 0,
    createServer: () => createServer(dependencies),
    ...(options.withPortal === false ? {} : { portal }),
  });

  return {
    server: running,
    base: `http://127.0.0.1:${running.port}`,
    vault,
    logs,
    secrets,
    auditFile: join(directory, "audit.jsonl"),
  };
}

function cookieValue(response: Response, name: string): string | undefined {
  for (const header of response.headers.getSetCookie()) {
    if (header.startsWith(`${name}=`)) {
      const value = header.slice(name.length + 1, indexOfEnd(header));
      return value === "" ? undefined : value;
    }
  }
  return undefined;
}

function cookieHeader(response: Response, name: string): string | undefined {
  return response.headers
    .getSetCookie()
    .find((header) => header.startsWith(`${name}=`));
}

function indexOfEnd(header: string): number {
  const semicolon = header.indexOf(";");
  return semicolon === -1 ? header.length : semicolon;
}

/** A completed login, returning the session cookie and its CSRF token. */
async function signIn(
  h: Harness,
  extra: Record<string, string> = {},
): Promise<{ cookie: string; csrf: string }> {
  const login = await fetch(`${h.base}/portal/auth/login`, {
    redirect: "manual",
    headers: extra,
  });
  const state = new URL(login.headers.get("location") ?? "").searchParams.get("state");
  const stateCookie = cookieValue(login, "imagine_portal_state");

  const callback = await fetch(
    `${h.base}/portal/auth/callback?code=code-1&state=${encodeURIComponent(state ?? "")}`,
    {
      redirect: "manual",
      headers: { cookie: `imagine_portal_state=${stateCookie ?? ""}`, ...extra },
    },
  );

  const session = cookieValue(callback, "imagine_portal_session");
  if (session === undefined) {
    throw new Error(`no session cookie: ${callback.status} ${await callback.text()}`);
  }

  const cookie = `imagine_portal_session=${session}`;
  const page = await fetch(`${h.base}/portal`, { headers: { cookie } });
  const html = await page.text();
  const csrf = /name="csrf_token" value="([^"]+)"/.exec(html)?.[1];
  if (csrf === undefined) throw new Error("no CSRF token on the dashboard");

  return { cookie, csrf };
}

function form(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

describe("the portal, when authentication is off", () => {
  it("does not exist: its paths are a plain 404", async () => {
    const h = await harness({ withPortal: false });

    for (const path of ["/portal", "/portal/auth/login", "/portal/keys/openrouter"]) {
      const response = await fetch(`${h.base}${path}`);
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain("Sign in");
    }
  });
});

describe("the portal's front door", () => {
  it("offers one sign-in button and nothing else without a session", async () => {
    const h = await harness();
    const response = await fetch(`${h.base}/portal`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("/portal/auth/login");
    expect(body).not.toContain("csrf_token");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("serves its stylesheet from its own origin, so the CSP can forbid inline", async () => {
    const h = await harness();
    const response = await fetch(`${h.base}/portal/style.css`);
    expect(response.headers.get("content-type")).toContain("text/css");
  });
});

describe("the login leg", () => {
  it("redirects with PKCE and a state bound to a short-lived cookie", async () => {
    const h = await harness();
    const response = await fetch(`${h.base}/portal/auth/login`, { redirect: "manual" });
    const location = new URL(response.headers.get("location") ?? "");

    expect(response.status).toBe(302);
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("client_id")).toBe("client_01");
    expect(location.searchParams.get("state")).not.toBeNull();

    const cookie = cookieHeader(response, "imagine_portal_state");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/portal");
    expect(cookie).toContain("Max-Age=600");
  });

  it("refuses a callback whose state does not match the cookie", async () => {
    const h = await harness();
    const login = await fetch(`${h.base}/portal/auth/login`, { redirect: "manual" });
    const stateCookie = cookieValue(login, "imagine_portal_state");

    const response = await fetch(`${h.base}/portal/auth/callback?code=c&state=forged`, {
      redirect: "manual",
      headers: { cookie: `imagine_portal_state=${stateCookie ?? ""}` },
    });

    expect(response.status).toBe(400);
    expect(cookieValue(response, "imagine_portal_session")).toBeUndefined();
  });

  it("refuses a callback with no state cookie at all", async () => {
    const h = await harness();
    const response = await fetch(`${h.base}/portal/auth/callback?code=c&state=s`, {
      redirect: "manual",
    });
    expect(response.status).toBe(400);
  });

  it("sets a session cookie that is HttpOnly, Lax and scoped to /portal", async () => {
    const h = await harness();
    const login = await fetch(`${h.base}/portal/auth/login`, { redirect: "manual" });
    const state = new URL(login.headers.get("location") ?? "").searchParams.get(
      "state",
    );

    const callback = await fetch(
      `${h.base}/portal/auth/callback?code=c&state=${encodeURIComponent(state ?? "")}`,
      {
        redirect: "manual",
        headers: {
          cookie: `imagine_portal_state=${cookieValue(login, "imagine_portal_state") ?? ""}`,
        },
      },
    );

    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/portal");

    const cookie = cookieHeader(callback, "imagine_portal_session");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/portal");
    // Loopback, so the cookie is issued without Secure and stays testable.
    expect(cookie).not.toContain("Secure");
  });

  it("marks the cookie Secure behind an HTTPS ingress", async () => {
    const h = await harness();
    const { cookie } = await signIn(h, { "x-forwarded-proto": "https" });
    expect(cookie).not.toBe("");

    const login = await fetch(`${h.base}/portal/auth/login`, {
      redirect: "manual",
      headers: { "x-forwarded-proto": "https" },
    });
    expect(cookieHeader(login, "imagine_portal_state")).toContain("Secure");
  });

  it("refuses an account the allowlist does not name, and says so", async () => {
    const h = await harness({
      authorise: createAuthoriser(parseAllowlist("email:someone-else@example.com"), {
        log: () => undefined,
      }),
    });

    const login = await fetch(`${h.base}/portal/auth/login`, { redirect: "manual" });
    const state = new URL(login.headers.get("location") ?? "").searchParams.get(
      "state",
    );
    const response = await fetch(
      `${h.base}/portal/auth/callback?code=c&state=${encodeURIComponent(state ?? "")}`,
      {
        redirect: "manual",
        headers: {
          cookie: `imagine_portal_state=${cookieValue(login, "imagine_portal_state") ?? ""}`,
        },
      },
    );

    expect(response.status).toBe(403);
    expect(await response.text()).toContain("not allowed");
    expect(cookieValue(response, "imagine_portal_session")).toBeUndefined();
  });

  it("reports a refused exchange without pretending someone logged in", async () => {
    const h = await harness({
      exchange: () =>
        new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
    });

    const login = await fetch(`${h.base}/portal/auth/login`, { redirect: "manual" });
    const state = new URL(login.headers.get("location") ?? "").searchParams.get(
      "state",
    );
    const response = await fetch(
      `${h.base}/portal/auth/callback?code=c&state=${encodeURIComponent(state ?? "")}`,
      {
        redirect: "manual",
        headers: {
          cookie: `imagine_portal_state=${cookieValue(login, "imagine_portal_state") ?? ""}`,
        },
      },
    );

    expect(response.status).toBe(502);
    expect(cookieValue(response, "imagine_portal_session")).toBeUndefined();
  });
});

describe("the dashboard", () => {
  it("names the person signed in and every provider the config knows", async () => {
    const h = await harness();
    const { cookie } = await signIn(h);

    const body = await (
      await fetch(`${h.base}/portal`, { headers: { cookie } })
    ).text();

    expect(body).toContain("owner@example.com");
    expect(body).toContain("openrouter");
    expect(body).toContain("azure");
    expect(body).toContain("no key yet");
  });

  it("lists, per provider, the curated models it can actually serve", async () => {
    const h = await harness();
    const { cookie } = await signIn(h);

    const body = await (
      await fetch(`${h.base}/portal`, { headers: { cookie } })
    ).text();

    // Reachable through OpenRouter, so it appears; only OpenRouter lists it.
    expect(body).toContain("Beacon Fast");
    // Both providers list Lantern 1, so it appears under each of them.
    expect(body.match(/class="model-name">Lantern 1</g)?.length).toBe(2);
    // Not curated for any configured provider, so it appears nowhere.
    expect(body).not.toContain("Stub Image 1");
  });

  it("names the Azure deployment each model maps to, from the configuration", async () => {
    const h = await harness();
    const { cookie } = await signIn(h);

    const body = await (
      await fetch(`${h.base}/portal`, { headers: { cookie } })
    ).text();

    expect(body).toContain("lantern-prod");
    expect(body).toContain("harbour-2-6");
  });

  it("marks a model behind a missing key rather than pretending it is reachable", async () => {
    const h = await harness();
    const { cookie } = await signIn(h);

    const body = await (
      await fetch(`${h.base}/portal`, { headers: { cookie } })
    ).text();

    expect(body).toContain("after you add a key");
  });

  it("says what each use case is waiting for while nothing is reachable", async () => {
    const h = await harness();
    const { cookie } = await signIn(h);

    const body = await (
      await fetch(`${h.base}/portal`, { headers: { cookie } })
    ).text();

    expect(body).toContain("Which model for what?");
    expect(body).toContain("nothing reachable yet");
    expect(body).toContain("Best overall: Lantern 1");
  });

  it("answers each use case with a reachable model once a key is saved", async () => {
    const h = await harness();
    const { cookie, csrf } = await signIn(h);

    await fetch(`${h.base}/portal/keys/openrouter`, {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie,
        origin: h.base,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form({ [CSRF_FIELD]: csrf, action: "save", value: THE_KEY }),
    });

    const body = await (
      await fetch(`${h.base}/portal`, { headers: { cookie } })
    ).text();

    expect(body).not.toContain("nothing reachable yet");
    // Lantern 1 is the strongest at text in image and OpenRouter now reaches it.
    expect(body).toContain("via openrouter");
    // Harbour 2 is the best photoreal model but only Azure has it.
    expect(body).toContain("Best overall: Harbour 2");
  });

  it("prices every model and marks the indicative ones, with the knowledge date", async () => {
    const h = await harness();
    const { cookie } = await signIn(h);

    const body = await (
      await fetch(`${h.base}/portal`, { headers: { cookie } })
    ).text();

    expect(body).toContain("$0.190");
    expect(body).toContain("$0.020");
    expect(body).toContain('class="approx"');
    expect(body).toContain("Knowledge updated 2026-08-26");
  });
});

describe("saving a provider key", () => {
  it("writes it to the vault, invalidates the cache and leaves an audit line", async () => {
    const h = await harness();
    const { cookie, csrf } = await signIn(h);

    const response = await fetch(`${h.base}/portal/keys/openrouter`, {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie,
        origin: h.base,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form({ [CSRF_FIELD]: csrf, action: "save", value: THE_KEY }),
    });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/portal?saved=openrouter");
    expect(h.vault.entries.get("openrouter-api-key")).toBe(THE_KEY);

    const audit = JSON.parse((await readFile(h.auditFile, "utf8")).trim()) as Record<
      string,
      unknown
    >;
    expect(audit["caller_id"]).toBe("https://example.authkit.app:user_01");
    expect(audit["action"]).toBe("secret.set");
    expect(audit["secret_name"]).toBe("openrouter-api-key");
    expect(audit["outcome"]).toBe("ok");
    expect(JSON.stringify(audit)).not.toContain(THE_KEY);

    const resolved = await h.secrets.resolve("openrouter");
    expect(resolved?.source).toBe("vault");
  });

  it("never says the value back, anywhere, and never logs it", async () => {
    const h = await harness();
    const { cookie, csrf } = await signIn(h);

    await fetch(`${h.base}/portal/keys/openrouter`, {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie,
        origin: h.base,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form({ [CSRF_FIELD]: csrf, action: "save", value: THE_KEY }),
    });

    for (const path of ["/portal", "/portal?saved=openrouter", "/portal/style.css"]) {
      const body = await (
        await fetch(`${h.base}${path}`, { headers: { cookie } })
      ).text();
      expect(body).not.toContain(THE_KEY);
      expect(body).not.toContain(THE_KEY.slice(-4));
    }

    expect(h.logs.join("\n")).not.toContain(THE_KEY);
    expect(await readFile(h.auditFile, "utf8")).not.toContain(THE_KEY);
  });

  it("shows that the key now comes from the vault, and clears it back again", async () => {
    const h = await harness();
    const { cookie, csrf } = await signIn(h);
    const headers = {
      cookie,
      origin: h.base,
      "content-type": "application/x-www-form-urlencoded",
    };

    await fetch(`${h.base}/portal/keys/openrouter`, {
      method: "POST",
      redirect: "manual",
      headers,
      body: form({ [CSRF_FIELD]: csrf, action: "save", value: THE_KEY }),
    });

    const saved = await (
      await fetch(`${h.base}/portal?saved=openrouter`, { headers: { cookie } })
    ).text();
    expect(saved).toContain("comes from Key Vault");
    expect(saved).toContain("within a minute");

    const cleared = await fetch(`${h.base}/portal/keys/openrouter`, {
      method: "POST",
      redirect: "manual",
      headers,
      body: form({ [CSRF_FIELD]: csrf, action: "clear" }),
    });

    expect(cleared.headers.get("location")).toBe("/portal?cleared=openrouter");
    expect(h.vault.entries.has("openrouter-api-key")).toBe(false);
  });

  it("refuses a POST with no CSRF token", async () => {
    const h = await harness();
    const { cookie } = await signIn(h);

    const response = await fetch(`${h.base}/portal/keys/openrouter`, {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie,
        origin: h.base,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form({ action: "save", value: THE_KEY }),
    });

    expect(response.status).toBe(403);
    expect(h.vault.entries.size).toBe(0);
  });

  it("refuses a POST whose CSRF token belongs to someone else", async () => {
    const h = await harness();
    const { cookie } = await signIn(h);

    const response = await fetch(`${h.base}/portal/keys/openrouter`, {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie,
        origin: h.base,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form({ [CSRF_FIELD]: "not-the-token", action: "save", value: THE_KEY }),
    });

    expect(response.status).toBe(403);
    expect(h.vault.entries.size).toBe(0);
  });

  it("refuses a POST from a foreign origin even with a valid token", async () => {
    const h = await harness();
    const { cookie, csrf } = await signIn(h);

    const response = await fetch(`${h.base}/portal/keys/openrouter`, {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie,
        origin: "https://attacker.example",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form({ [CSRF_FIELD]: csrf, action: "save", value: THE_KEY }),
    });

    expect(response.status).toBe(403);
    expect(h.vault.entries.size).toBe(0);
  });

  it("refuses a POST a cross-site navigation announced itself as", async () => {
    const h = await harness();
    const { cookie, csrf } = await signIn(h);

    const response = await fetch(`${h.base}/portal/keys/openrouter`, {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie,
        origin: h.base,
        "sec-fetch-site": "cross-site",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form({ [CSRF_FIELD]: csrf, action: "save", value: THE_KEY }),
    });

    expect(response.status).toBe(403);
    expect(h.vault.entries.size).toBe(0);
  });

  it('accepts the literal Origin "null" Chromium sends on a same-origin post', async () => {
    const h = await harness();
    const { cookie, csrf } = await signIn(h);

    const response = await fetch(`${h.base}/portal/keys/openrouter`, {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie,
        origin: "null",
        "sec-fetch-site": "same-origin",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form({ [CSRF_FIELD]: csrf, action: "save", value: THE_KEY }),
    });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/portal?saved=openrouter");
    expect(h.vault.entries.get("openrouter-api-key")).toBe(THE_KEY);
  });

  it('refuses the same "null" Origin when the browser calls it cross-site', async () => {
    const h = await harness();
    const { cookie, csrf } = await signIn(h);

    const response = await fetch(`${h.base}/portal/keys/openrouter`, {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie,
        origin: "null",
        "sec-fetch-site": "cross-site",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form({ [CSRF_FIELD]: csrf, action: "save", value: THE_KEY }),
    });

    expect(response.status).toBe(403);
    expect(h.vault.entries.size).toBe(0);
  });

  it("refuses a POST with no session at all", async () => {
    const h = await harness();
    const response = await fetch(`${h.base}/portal/keys/openrouter`, {
      method: "POST",
      redirect: "manual",
      headers: {
        origin: h.base,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form({ [CSRF_FIELD]: "anything", action: "save", value: THE_KEY }),
    });

    expect(response.status).toBe(403);
    expect(h.vault.entries.size).toBe(0);
  });

  it("refuses a tampered session cookie", async () => {
    const h = await harness();
    const { cookie, csrf } = await signIn(h);
    const forged = `${cookie.slice(0, -3)}aaa`;

    const response = await fetch(`${h.base}/portal/keys/openrouter`, {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie: forged,
        origin: h.base,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form({ [CSRF_FIELD]: csrf, action: "save", value: THE_KEY }),
    });

    expect(response.status).toBe(403);
    expect(h.vault.entries.size).toBe(0);
  });

  it("says a value that cannot be a key is not one, without storing it", async () => {
    const h = await harness();
    const { cookie, csrf } = await signIn(h);

    const response = await fetch(`${h.base}/portal/keys/openrouter`, {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie,
        origin: h.base,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form({ [CSRF_FIELD]: csrf, action: "save", value: "sk one two" }),
    });

    expect(response.headers.get("location")).toBe("/portal?invalid=openrouter");
    expect(h.vault.entries.size).toBe(0);
  });

  it("does not write a provider that is not in the configuration", async () => {
    const h = await harness();
    const { cookie, csrf } = await signIn(h);

    const response = await fetch(`${h.base}/portal/keys/made-up`, {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie,
        origin: h.base,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form({ [CSRF_FIELD]: csrf, action: "save", value: THE_KEY }),
    });

    expect(response.headers.get("location")).toBe("/portal?failed=made-up");
    expect(h.vault.entries.size).toBe(0);
  });

  it("answers a GET on the write route with 405, because GET changes nothing", async () => {
    const h = await harness();
    const response = await fetch(`${h.base}/portal/keys/openrouter`, {
      redirect: "manual",
    });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });
});

describe("signing out", () => {
  it("clears the cookie and sends the browser to the issuer's logout", async () => {
    const h = await harness();
    const { cookie, csrf } = await signIn(h);

    const response = await fetch(`${h.base}/portal/auth/logout`, {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie,
        origin: h.base,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form({ [CSRF_FIELD]: csrf }),
    });

    expect(response.status).toBe(303);
    expect(cookieHeader(response, "imagine_portal_session")).toContain("Max-Age=0");
  });
});

describe("the separation from /mcp", () => {
  it("leaves /mcp deaf to cookies", async () => {
    const h = await harness();
    const { cookie } = await signIn(h);

    const call = (headers: Record<string, string>): Promise<Response> =>
      fetch(`${h.base}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...headers,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });

    // The one with the cookie and the one without answer identically: /mcp does
    // not read cookies, so a browser session buys nothing there.
    const withCookie = await call({ cookie });
    const without = await call({});

    expect(withCookie.status).toBe(200);
    expect(without.status).toBe(200);
    expect(await withCookie.text()).toBe(await without.text());
  });

  it("leaves /healthz and the 404 message intact", async () => {
    const h = await harness();
    expect((await fetch(`${h.base}/healthz`)).status).toBe(200);

    const missing = await fetch(`${h.base}/nowhere`);
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain("/portal");
  });
});
