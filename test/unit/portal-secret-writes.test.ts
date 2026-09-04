/**
 * The write half of the Key Vault store, which exists only because the portal
 * needs it. Read coverage lives in `secrets.test.ts`.
 */

import { describe, expect, it } from "vitest";
import { createKeyVaultSecretStore } from "../../src/core/secrets.js";

interface Call {
  url: string;
  method: string;
  body: string | null;
  authorization: string | undefined;
}

function recorder(answer: (call: Call) => Response): {
  calls: Call[];
  fetch: typeof globalThis.fetch;
} {
  const calls: Call[] = [];
  const fetchImpl = ((url: string, init: RequestInit) => {
    const call: Call = {
      url,
      method: init.method ?? "GET",
      body: init.body === undefined ? null : String(init.body),
      authorization: (init.headers as Record<string, string> | undefined)?.[
        "Authorization"
      ],
    };
    calls.push(call);
    return Promise.resolve(answer(call));
  }) as unknown as typeof globalThis.fetch;

  return { calls, fetch: fetchImpl };
}

function store(answer: (call: Call) => Response) {
  const { calls, fetch } = recorder(answer);
  return {
    calls,
    store: createKeyVaultSecretStore({
      vaultUrl: "https://kv-imagine.vault.azure.net/",
      getAccessToken: () => Promise.resolve("token-1"),
      fetch,
    }),
  };
}

describe("set", () => {
  it("PUTs the value at the data-plane URL with the identity's token", async () => {
    const { calls, store: vault } = store(
      () => new Response(JSON.stringify({ value: "x" }), { status: 200 }),
    );

    await vault.set("openrouter-api-key", "sk-or-v1-secret");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("PUT");
    expect(calls[0]?.url).toBe(
      "https://kv-imagine.vault.azure.net/secrets/openrouter-api-key?api-version=7.4",
    );
    expect(calls[0]?.authorization).toBe("Bearer token-1");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ value: "sk-or-v1-secret" });
  });

  it("makes the new value visible to the very next read on this replica", async () => {
    let stored = "old-value";
    const { store: vault } = store((call) => {
      if (call.method === "PUT") {
        stored = (JSON.parse(call.body ?? "{}") as { value: string }).value;
        return new Response(JSON.stringify({ value: stored }), { status: 200 });
      }
      return new Response(JSON.stringify({ value: stored }), { status: 200 });
    });

    expect(await vault.get("openrouter-api-key")).toBe("old-value");
    await vault.set("openrouter-api-key", "new-value");
    expect(await vault.get("openrouter-api-key")).toBe("new-value");
  });

  it("says what Key Vault refused without quoting the value back", async () => {
    const { store: vault } = store(
      () => new Response('{"error":{"message":"Forbidden"}}', { status: 403 }),
    );

    await expect(vault.set("openrouter-api-key", "sk-or-v1-secret")).rejects.toThrow(
      /Secrets Officer/,
    );
    await expect(
      vault.set("openrouter-api-key", "sk-or-v1-secret"),
    ).rejects.not.toThrow(/sk-or-v1-secret/);
  });
});

describe("remove", () => {
  it("DELETEs the secret and drops it from the cache", async () => {
    let present = true;
    const { calls, store: vault } = store((call) => {
      if (call.method === "DELETE") {
        present = false;
        return new Response("{}", { status: 200 });
      }
      return present
        ? new Response(JSON.stringify({ value: "still-here" }), { status: 200 })
        : new Response("{}", { status: 404 });
    });

    expect(await vault.get("openrouter-api-key")).toBe("still-here");
    await vault.remove("openrouter-api-key");
    expect(calls.some((call) => call.method === "DELETE")).toBe(true);
    expect(await vault.get("openrouter-api-key")).toBeNull();
  });

  it("treats deleting something that was not there as done", async () => {
    const { store: vault } = store(() => new Response("{}", { status: 404 }));
    await expect(vault.remove("never-existed")).resolves.toBeUndefined();
  });
});
