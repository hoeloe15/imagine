import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG,
  configSchema,
  type Config,
} from "../../src/core/config-schema.js";
import { isImagineError } from "../../src/core/errors.js";
import {
  AZURE_KEY_VAULT_SCOPE,
  KEY_VAULT_API_VERSION,
  SECRET_MISS_TTL_MS,
  SECRET_TTL_MS,
  apiKeySourceFor,
  createKeyVaultSecretStore,
  createSecretResolver,
  derivedSecretName,
  secretNameFor,
  toApiKeySource,
  type FetchLike,
  type SecretStore,
} from "../../src/core/secrets.js";
import { AzureProvider } from "../../src/providers/azure.js";
import { OpenRouterProvider } from "../../src/providers/openrouter.js";

const VAULT_URL = "https://kv-imagine-test.vault.azure.net/";
const SECRET = "sk-or-do-not-leak-this-value";
const NOW = Date.parse("2026-09-04T12:00:00Z");

interface Call {
  url: string;
  authorization: string | undefined;
}

/** A fetch that answers from a queue, recording what it was asked. */
function fetchStub(answers: ReadonlyArray<Response | Error>): {
  impl: FetchLike;
  calls: Call[];
} {
  const remaining = [...answers];
  const calls: Call[] = [];

  const impl: FetchLike = (input, init) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: typeof input === "string" ? input : String(input),
      authorization: headers.get("authorization") ?? undefined,
    });

    const next = remaining.length > 1 ? remaining.shift() : remaining[0];
    if (next === undefined) throw new Error("the fetch stub ran out of answers");
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next.clone());
  };

  return { impl, calls };
}

function secretResponse(value: string): Response {
  return new Response(JSON.stringify({ value, id: `${VAULT_URL}secrets/x/1` }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function notFound(): Response {
  return new Response(JSON.stringify({ error: { code: "SecretNotFound" } }), {
    status: 404,
  });
}

function store(
  answers: ReadonlyArray<Response | Error>,
  clock: { now: number } = { now: NOW },
): { store: SecretStore; calls: Call[] } {
  const fetch = fetchStub(answers);
  return {
    store: createKeyVaultSecretStore({
      vaultUrl: VAULT_URL,
      getAccessToken: () => Promise.resolve("token-abc"),
      fetch: fetch.impl,
      now: () => clock.now,
    }),
    calls: fetch.calls,
  };
}

describe("the Key Vault secret store", () => {
  it("reads one secret with one GET and a bearer token", async () => {
    const { store: vault, calls } = store([secretResponse(SECRET)]);

    expect(await vault.get("openrouter-api-key")).toBe(SECRET);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      `https://kv-imagine-test.vault.azure.net/secrets/openrouter-api-key?api-version=${KEY_VAULT_API_VERSION}`,
    );
    expect(calls[0]?.authorization).toBe("Bearer token-abc");
  });

  it("treats a secret that does not exist as null, not as an error", async () => {
    const { store: vault } = store([notFound()]);

    expect(await vault.get("openrouter-api-key")).toBeNull();
  });

  it("does not ask again inside the cache window", async () => {
    const clock = { now: NOW };
    const { store: vault, calls } = store([secretResponse(SECRET)], clock);

    await vault.get("openrouter-api-key");
    clock.now = NOW + SECRET_TTL_MS - 1;
    await vault.get("openrouter-api-key");

    expect(calls).toHaveLength(1);
  });

  it("asks again once the cached value has expired", async () => {
    const clock = { now: NOW };
    const { store: vault, calls } = store(
      [secretResponse("first"), secretResponse("second")],
      clock,
    );

    expect(await vault.get("openrouter-api-key")).toBe("first");
    clock.now = NOW + SECRET_TTL_MS + 1;
    expect(await vault.get("openrouter-api-key")).toBe("second");
    expect(calls).toHaveLength(2);
  });

  it("believes a miss for a shorter time than a hit", async () => {
    const clock = { now: NOW };
    const { store: vault, calls } = store([notFound(), secretResponse(SECRET)], clock);

    expect(await vault.get("openrouter-api-key")).toBeNull();
    clock.now = NOW + SECRET_MISS_TTL_MS + 1;
    expect(await vault.get("openrouter-api-key")).toBe(SECRET);
    expect(calls).toHaveLength(2);
  });

  it("forgets on demand, so the replica that wrote sees its own write", async () => {
    const clock = { now: NOW };
    const { store: vault, calls } = store(
      [secretResponse("old"), secretResponse("new")],
      clock,
    );

    expect(await vault.get("openrouter-api-key")).toBe("old");
    vault.invalidate("openrouter-api-key");
    expect(await vault.get("openrouter-api-key")).toBe("new");
    expect(calls).toHaveLength(2);
  });

  it("shares one in-flight request between concurrent callers", async () => {
    const { store: vault, calls } = store([secretResponse(SECRET)]);

    const both = await Promise.all([
      vault.get("openrouter-api-key"),
      vault.get("openrouter-api-key"),
    ]);

    expect(both).toEqual([SECRET, SECRET]);
    expect(calls).toHaveLength(1);
  });

  it("keeps serving the last known value through a transient failure", async () => {
    const clock = { now: NOW };
    const { store: vault } = store(
      [secretResponse(SECRET), new Error("ECONNRESET")],
      clock,
    );

    expect(await vault.get("openrouter-api-key")).toBe(SECRET);
    clock.now = NOW + SECRET_TTL_MS + 1;
    expect(await vault.get("openrouter-api-key")).toBe(SECRET);
  });

  it("raises a 403 as an authorisation failure naming the role that is missing", async () => {
    const { store: vault } = store([new Response("Forbidden", { status: 403 })]);

    await expect(vault.get("openrouter-api-key")).rejects.toSatisfy(
      (cause: unknown) =>
        isImagineError(cause) &&
        cause.reason === "auth_failed" &&
        cause.message.includes("Key Vault Secrets User"),
    );
  });

  it("never puts a token in a message", async () => {
    const empty = createKeyVaultSecretStore({
      vaultUrl: VAULT_URL,
      getAccessToken: () => Promise.resolve("   "),
      fetch: fetchStub([secretResponse(SECRET)]).impl,
    });

    await expect(empty.get("openrouter-api-key")).rejects.toSatisfy(
      (cause: unknown) =>
        isImagineError(cause) && cause.message.includes(AZURE_KEY_VAULT_SCOPE),
    );
  });
});

describe("the vault secret name", () => {
  it("is derived from the environment variable by convention", () => {
    expect(derivedSecretName("OPENROUTER_API_KEY")).toBe("openrouter-api-key");
    expect(derivedSecretName("AZURE_OPENAI_API_KEY")).toBe("azure-openai-api-key");
  });

  it("is the name resources.bicep already writes", () => {
    const provider = config().providers["openrouter"];
    expect(provider && secretNameFor(provider)).toBe("openrouter-api-key");
  });

  it("is whatever api_key_secret says, when it says something", () => {
    const provider = config({
      openrouter: {
        enabled: true,
        api_key_env: "OPENROUTER_API_KEY",
        api_key_secret: "my-own-name",
      },
    }).providers["openrouter"];

    expect(provider && secretNameFor(provider)).toBe("my-own-name");
  });

  it("refuses anything Key Vault itself would refuse as a name", () => {
    // Key Vault's own rule: letters, digits and hyphens, at most 127 of them.
    // That rejects most things a person could paste here by accident, and it is
    // the honest limit of this check — see ADR 0026.
    for (const pasted of ["sk_test_abcdef", "gsk.live/abc", "x".repeat(128)]) {
      const parsed = configSchema.safeParse({
        ...DEFAULT_CONFIG,
        providers: {
          openrouter: {
            enabled: true,
            api_key_env: "OPENROUTER_API_KEY",
            api_key_secret: pasted,
          },
        },
      });

      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues[0]?.path).toEqual([
        "providers",
        "openrouter",
        "api_key_secret",
      ]);
    }
  });
});

function config(providers?: Record<string, unknown>): Config {
  return configSchema.parse({
    ...DEFAULT_CONFIG,
    providers: providers ?? {
      openrouter: { enabled: true, api_key_env: "OPENROUTER_API_KEY" },
    },
  });
}

/** A store that answers from a map, so a resolver test needs no HTTP at all. */
function fakeStore(secrets: Record<string, string>): SecretStore & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    get(name: string) {
      reads.push(name);
      return Promise.resolve(secrets[name] ?? null);
    },
    invalidate() {},
  };
}

describe("the secret resolver", () => {
  it("reads the environment and nothing else when there is no vault", async () => {
    const resolver = createSecretResolver({
      config: config(),
      env: { OPENROUTER_API_KEY: SECRET },
    });

    expect(resolver.hasVault).toBe(false);
    expect(await resolver.resolve("openrouter")).toEqual({
      value: SECRET,
      source: "env",
    });
    expect(resolver.hasSource("openrouter")).toBe(true);
  });

  it("has no source at all when the environment is empty and there is no vault", async () => {
    const resolver = createSecretResolver({ config: config(), env: {} });

    expect(await resolver.resolve("openrouter")).toBeNull();
    expect(resolver.hasSource("openrouter")).toBe(false);
    expect((await resolver.lookup("openrouter")).missing).toEqual([
      "OPENROUTER_API_KEY",
    ]);
  });

  it("prefers the vault, because that is what a person can change without a deploy", async () => {
    const vault = fakeStore({ "openrouter-api-key": "from-vault" });
    const resolver = createSecretResolver({
      config: config(),
      env: { OPENROUTER_API_KEY: "from-env" },
      vault,
    });

    expect(await resolver.resolve("openrouter")).toEqual({
      value: "from-vault",
      source: "vault",
    });
    expect(vault.reads).toEqual(["openrouter-api-key"]);
  });

  it("falls back to the environment when the vault has no such secret", async () => {
    const resolver = createSecretResolver({
      config: config(),
      env: { OPENROUTER_API_KEY: "from-env" },
      vault: fakeStore({}),
    });

    expect(await resolver.resolve("openrouter")).toEqual({
      value: "from-env",
      source: "env",
    });
  });

  it("falls back to the environment and says so when the vault cannot be read", async () => {
    const broken: SecretStore = {
      get: () => Promise.reject(new Error("the vault is having a moment")),
      invalidate() {},
    };
    const resolver = createSecretResolver({
      config: config(),
      env: { OPENROUTER_API_KEY: "from-env" },
      vault: broken,
    });

    expect(await resolver.resolve("openrouter")).toEqual({
      value: "from-env",
      source: "env",
    });

    const withoutEnv = createSecretResolver({
      config: config(),
      env: {},
      vault: broken,
    });
    const lookup = await withoutEnv.lookup("openrouter");

    expect(lookup.resolution).toBeNull();
    expect(lookup.note).toContain("the vault is having a moment");
    expect(lookup.missing).toEqual([
      "OPENROUTER_API_KEY",
      "vault secret openrouter-api-key",
    ]);
  });

  it("counts a configured vault as a source even before a key is in it", () => {
    const resolver = createSecretResolver({
      config: config(),
      env: {},
      vault: fakeStore({}),
    });

    expect(resolver.hasVault).toBe(true);
    expect(resolver.hasSource("openrouter")).toBe(true);
  });

  it("asks for nothing on behalf of a disabled or keyless provider", async () => {
    const vault = fakeStore({ "openrouter-api-key": SECRET });
    const resolver = createSecretResolver({
      config: config({
        openrouter: { enabled: false, api_key_env: "OPENROUTER_API_KEY" },
        azure: {
          enabled: true,
          auth: "entra",
          endpoint: "https://example.openai.azure.com",
        },
      }),
      env: { OPENROUTER_API_KEY: SECRET },
      vault,
    });

    expect(await resolver.resolve("openrouter")).toBeNull();
    expect(await resolver.resolve("azure")).toBeNull();
    expect(resolver.hasSource("openrouter")).toBe(false);
    expect(resolver.hasSource("azure")).toBe(false);
    expect(vault.reads).toEqual([]);
  });
});

describe("an adapter's key source", () => {
  it("still takes a plain string, exactly as it always did", async () => {
    expect(new OpenRouterProvider({ apiKey: SECRET }).isConfigured()).toBe(true);
    expect(new OpenRouterProvider({ apiKey: "" }).isConfigured()).toBe(false);
    expect(new OpenRouterProvider({ apiKey: null }).isConfigured()).toBe(false);
    expect(await toApiKeySource(SECRET).get()).toBe(SECRET);
  });

  it("reads the key at request time rather than at construction", async () => {
    let current: string | null = null;
    const source = { has: () => true, get: () => Promise.resolve(current) };
    const calls: string[] = [];
    const fetch: FetchLike = (_input, init) => {
      calls.push(new Headers(init?.headers).get("authorization") ?? "");
      return Promise.resolve(
        new Response(JSON.stringify({ data: [{ id: "m", name: "m" }] }), {
          status: 200,
        }),
      );
    };
    const provider = new OpenRouterProvider({ apiKey: source, fetch });

    await expect(provider.listModels()).rejects.toSatisfy(
      (cause: unknown) => isImagineError(cause) && cause.reason === "auth_failed",
    );

    current = "sk-or-set-after-startup";
    await provider.listModels();

    expect(calls).toEqual(["Bearer sk-or-set-after-startup"]);
  });

  it("lets the Azure adapter pick up a rotated key without a restart", async () => {
    let current = "first-key";
    const sent: string[] = [];
    const fetch: FetchLike = (_input, init) => {
      sent.push(new Headers(init?.headers).get("api-key") ?? "");
      return Promise.resolve(
        new Response(JSON.stringify({ data: [{ b64_json: "aGk=" }] }), { status: 200 }),
      );
    };
    const provider = new AzureProvider({
      enabled: true,
      endpoint: "https://example.openai.azure.com",
      auth: "api_key",
      apiKey: { has: () => true, get: () => Promise.resolve(current) },
      deployments: { "gpt-image-2": "my-deployment" },
      fetch,
    });

    expect(provider.isConfigured()).toBe(true);
    await provider.generate({ prompt: "a lighthouse" });
    current = "second-key";
    await provider.generate({ prompt: "a lighthouse" });

    expect(sent).toEqual(["first-key", "second-key"]);
  });

  it("is wired to a provider through the resolver", async () => {
    const resolver = createSecretResolver({
      config: config(),
      env: { OPENROUTER_API_KEY: SECRET },
    });
    const source = apiKeySourceFor(resolver, "openrouter");

    expect(source.has()).toBe(true);
    expect(await source.get()).toBe(SECRET);
    expect(apiKeySourceFor(resolver, "google").has()).toBe(false);
  });
});
