/**
 * The managed identity token provider, with an injected fetch. Nothing here
 * touches the network, and no test asserts on a token appearing in a message.
 */

import { describe, expect, it } from "vitest";
import { ImagineError } from "../../src/core/errors.js";
import { AZURE_ENTRA_SCOPE } from "../../src/providers/azure.js";
import {
  createManagedIdentityTokenProvider,
  hasManagedIdentity,
  managedIdentityEnvironment,
} from "../../src/providers/managed-identity.js";

const IDENTITY_ENV = {
  IDENTITY_ENDPOINT: "http://localhost:42356/msi/token",
  IDENTITY_HEADER: "identity-header-secret",
} as const;

interface Call {
  url: string;
  headers: Record<string, string>;
}

function recordingFetch(responses: readonly (() => Response)[]): {
  fetch: typeof globalThis.fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  let index = 0;
  const fetch = ((input: unknown, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (next === undefined) throw new Error("no response was queued");
    return Promise.resolve(next());
  }) as typeof globalThis.fetch;

  return { fetch, calls };
}

function tokenResponse(token: string, expiresOn: string | number): () => Response {
  return () =>
    new Response(
      JSON.stringify({
        access_token: token,
        expires_on: expiresOn,
        resource: "https://ai.azure.com",
        token_type: "Bearer",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
}

async function failureOf(run: () => Promise<unknown>): Promise<ImagineError> {
  const caught = await run().then(
    () => undefined,
    (cause: unknown) => cause,
  );
  expect(caught).toBeInstanceOf(ImagineError);
  return caught as ImagineError;
}

describe("detecting a managed identity environment", () => {
  it("needs both the endpoint and the header", () => {
    expect(hasManagedIdentity(IDENTITY_ENV)).toBe(true);
    expect(hasManagedIdentity({})).toBe(false);
    expect(
      hasManagedIdentity({ IDENTITY_ENDPOINT: IDENTITY_ENV.IDENTITY_ENDPOINT }),
    ).toBe(false);
    expect(hasManagedIdentity({ IDENTITY_HEADER: "h" })).toBe(false);
    expect(hasManagedIdentity({ ...IDENTITY_ENV, IDENTITY_HEADER: "  " })).toBe(false);
  });

  it("carries the client id when one is named", () => {
    expect(
      managedIdentityEnvironment({ ...IDENTITY_ENV, AZURE_CLIENT_ID: "client-1" }),
    ).toEqual({
      endpoint: IDENTITY_ENV.IDENTITY_ENDPOINT,
      header: IDENTITY_ENV.IDENTITY_HEADER,
      clientId: "client-1",
    });
  });
});

describe("acquiring a token", () => {
  it("asks the identity endpoint for the scope as a v1 resource", async () => {
    const { fetch, calls } = recordingFetch([tokenResponse("token-1", 2_000)]);
    const getToken = createManagedIdentityTokenProvider({
      env: { ...IDENTITY_ENV, AZURE_CLIENT_ID: "client-1" },
      fetch,
      now: () => 0,
    });

    expect(await getToken()).toBe("token-1");

    const call = calls[0];
    const url = new URL(call?.url ?? "");
    expect(url.origin + url.pathname).toBe(IDENTITY_ENV.IDENTITY_ENDPOINT);
    expect(url.searchParams.get("resource")).toBe("https://ai.azure.com");
    expect(url.searchParams.get("api-version")).toBe("2019-08-01");
    expect(url.searchParams.get("client_id")).toBe("client-1");
    expect(call?.headers["X-IDENTITY-HEADER"]).toBe(IDENTITY_ENV.IDENTITY_HEADER);
  });

  it("omits client_id when no identity is named", async () => {
    const { fetch, calls } = recordingFetch([tokenResponse("token-1", 2_000)]);
    await createManagedIdentityTokenProvider({
      env: IDENTITY_ENV,
      fetch,
      now: () => 0,
    })();

    expect(new URL(calls[0]?.url ?? "").searchParams.has("client_id")).toBe(false);
  });

  it("defaults to the Azure AI scope", async () => {
    const { fetch } = recordingFetch([tokenResponse("token-1", 2_000)]);
    const getToken = createManagedIdentityTokenProvider({
      env: IDENTITY_ENV,
      fetch,
      now: () => 0,
    });

    expect(AZURE_ENTRA_SCOPE).toBe("https://ai.azure.com/.default");
    expect(await getToken()).toBe("token-1");
  });
});

describe("caching and refresh", () => {
  it("serves a cached token without asking again", async () => {
    const { fetch, calls } = recordingFetch([tokenResponse("token-1", 3_600)]);
    let clock = 0;
    const getToken = createManagedIdentityTokenProvider({
      env: IDENTITY_ENV,
      fetch,
      now: () => clock,
    });

    expect(await getToken()).toBe("token-1");
    clock = 60_000;
    expect(await getToken()).toBe("token-1");
    expect(calls).toHaveLength(1);
  });

  it("refreshes once the token is inside the expiry slack", async () => {
    const { fetch, calls } = recordingFetch([
      tokenResponse("token-1", 3_600),
      tokenResponse("token-2", 7_200),
    ]);
    let clock = 0;
    const getToken = createManagedIdentityTokenProvider({
      env: IDENTITY_ENV,
      fetch,
      now: () => clock,
      expirySlackMs: 300_000,
    });

    expect(await getToken()).toBe("token-1");

    // Still four minutes of slack left.
    clock = 3_600_000 - 301_000;
    expect(await getToken()).toBe("token-1");

    // Inside the slack window, and therefore due for renewal.
    clock = 3_600_000 - 299_000;
    expect(await getToken()).toBe("token-2");
    expect(calls).toHaveLength(2);
  });

  it("reads expires_on as epoch seconds in a string, which is what is sent", async () => {
    const { fetch, calls } = recordingFetch([tokenResponse("token-1", "3600")]);
    let clock = 0;
    const getToken = createManagedIdentityTokenProvider({
      env: IDENTITY_ENV,
      fetch,
      now: () => clock,
      expirySlackMs: 60_000,
    });

    expect(await getToken()).toBe("token-1");
    clock = 3_500_000;
    expect(await getToken()).toBe("token-1");
    clock = 3_599_000;
    expect(await getToken()).toBe("token-1");
    expect(calls).toHaveLength(2);
  });

  it("reads expires_on as a date, which older hosts send", async () => {
    const { fetch, calls } = recordingFetch([
      tokenResponse("token-1", new Date(3_600_000).toISOString()),
    ]);
    let clock = 0;
    const getToken = createManagedIdentityTokenProvider({
      env: IDENTITY_ENV,
      fetch,
      now: () => clock,
      expirySlackMs: 60_000,
    });

    expect(await getToken()).toBe("token-1");
    clock = 3_599_000;
    expect(await getToken()).toBe("token-1");
    expect(calls).toHaveLength(2);
  });

  it("shares one request between concurrent callers", async () => {
    const { fetch, calls } = recordingFetch([tokenResponse("token-1", 3_600)]);
    const getToken = createManagedIdentityTokenProvider({
      env: IDENTITY_ENV,
      fetch,
      now: () => 0,
    });

    expect(await Promise.all([getToken(), getToken(), getToken()])).toEqual([
      "token-1",
      "token-1",
      "token-1",
    ]);
    expect(calls).toHaveLength(1);
  });

  it("does not cache a failure, so the next call tries again", async () => {
    const { fetch, calls } = recordingFetch([
      () => new Response("boom", { status: 500 }),
      tokenResponse("token-1", 3_600),
    ]);
    const getToken = createManagedIdentityTokenProvider({
      env: IDENTITY_ENV,
      fetch,
      now: () => 0,
    });

    await failureOf(getToken);
    expect(await getToken()).toBe("token-1");
    expect(calls).toHaveLength(2);
  });
});

describe("failures", () => {
  it("says plainly that there is no managed identity here", async () => {
    const getToken = createManagedIdentityTokenProvider({
      env: {},
      fetch: recordingFetch([tokenResponse("token-1", 3_600)]).fetch,
    });

    const failure = await failureOf(getToken);

    expect(failure.reason).toBe("auth_failed");
    expect(failure.message).toContain("IDENTITY_ENDPOINT");
    expect(failure.message).toContain("IDENTITY_HEADER");
    expect(failure.message).toContain('"api_key"');
  });

  it("reports the status when the endpoint refuses", async () => {
    const { fetch } = recordingFetch([
      () => new Response('{"error":"no identity"}', { status: 400 }),
    ]);
    const failure = await failureOf(
      createManagedIdentityTokenProvider({ env: IDENTITY_ENV, fetch }),
    );

    expect(failure.reason).toBe("auth_failed");
    expect(failure.message).toContain("400");
    expect(failure.message).toContain("no identity");
  });

  it("reports a body that carries no token", async () => {
    const { fetch } = recordingFetch([() => new Response("{}", { status: 200 })]);
    const failure = await failureOf(
      createManagedIdentityTokenProvider({ env: IDENTITY_ENV, fetch }),
    );

    expect(failure.reason).toBe("auth_failed");
    expect(failure.message).toContain("access_token");
  });

  it("reports an unreachable endpoint as retryable", async () => {
    const fetch = (() =>
      Promise.reject(new Error("ECONNREFUSED"))) as typeof globalThis.fetch;
    const failure = await failureOf(
      createManagedIdentityTokenProvider({ env: IDENTITY_ENV, fetch }),
    );

    expect(failure.reason).toBe("auth_failed");
    expect(failure.retryable).toBe(true);
    expect(failure.message).toContain("ECONNREFUSED");
  });
});
