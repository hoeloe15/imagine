/**
 * What a "Test key" actually proves, and what it is allowed to say about it:
 * the mapping from a provider's refusal to one plain sentence, the two
 * adapters' own checks, and the small store the outcome is remembered in.
 */

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ImagineError } from "../../src/core/errors.js";
import type { ProviderModel } from "../../src/core/types.js";
import {
  createVerificationStore,
  describeFailure,
  failureFrom,
  parseVerifications,
  verificationFileFor,
  verifyProvider,
  VERIFICATION_FILE_NAME,
} from "../../src/core/verification.js";
import { AzureProvider } from "../../src/providers/azure.js";
import { OpenRouterProvider } from "../../src/providers/openrouter.js";
import { StubProvider } from "../../src/providers/stub.js";
import type { ImageProvider, VerificationResult } from "../../src/providers/types.js";

const KEY = "sk-or-v1-never-say-this-back";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fetchReturning(...responses: Response[]): typeof globalThis.fetch {
  let index = 0;
  return (() => {
    const response = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return Promise.resolve(response);
  }) as unknown as typeof globalThis.fetch;
}

describe("turning a refusal into one sentence", () => {
  it("names the two rejections a person can act on", () => {
    expect(describeFailure("auth_failed", 401)).toBe("invalid key (401)");
    expect(describeFailure("auth_failed", 402)).toBe("no credits (402)");
  });

  it("falls back to the failure reason when there is no status", () => {
    expect(describeFailure("provider_unavailable")).toBe(
      "the provider could not be reached",
    );
    expect(describeFailure("timeout")).toBe("no answer in time");
  });

  it("keeps an unfamiliar status visible next to the reason", () => {
    expect(describeFailure("invalid_request", 400)).toContain("400");
  });

  it("says nothing of the provider's own words, which could echo the key", () => {
    const result = failureFrom(
      new ImagineError("auth_failed", `refused the key ${KEY}`, { status: 401 }),
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("auth_failed");
    expect(result.summary).toBe("invalid key (401)");
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it("treats anything that is not an ImagineError as proving nothing", () => {
    const result = failureFrom(new Error("socket hang up"));
    expect(result).toEqual({
      ok: false,
      reason: "unknown",
      summary: "the check could not be completed",
    });
  });
});

describe("verifying a provider that offers no check of its own", () => {
  it("asks for the model list, which is free and needs the same key", async () => {
    const result = await verifyProvider(new StubProvider());
    expect(result.ok).toBe(true);
    expect(result.summary).toBe("1 model visible");
  });

  it("maps a thrown failure rather than letting it escape", async () => {
    const refusing: ImageProvider = {
      id: "refusing",
      isConfigured: () => true,
      listModels: () =>
        Promise.reject(new ImagineError("auth_failed", "nope", { status: 401 })),
      generate: () => Promise.reject(new Error("not called")),
    };

    expect(await verifyProvider(refusing)).toEqual({
      ok: false,
      reason: "auth_failed",
      summary: "invalid key (401)",
    });
  });

  it("prefers an adapter's own verify when it has one", async () => {
    const own: VerificationResult = { ok: true, summary: "asked itself" };
    const provider: ImageProvider = {
      id: "own",
      isConfigured: () => true,
      listModels: () => Promise.resolve([] as ProviderModel[]),
      verify: () => Promise.resolve(own),
      generate: () => Promise.reject(new Error("not called")),
    };

    expect(await verifyProvider(provider)).toEqual(own);
  });
});

describe("OpenRouter's check", () => {
  it("counts the image models the key can see", async () => {
    const provider = new OpenRouterProvider({
      apiKey: KEY,
      fetch: fetchReturning(
        json(200, {
          data: [
            { id: "a/one", output_modalities: ["image"] },
            { id: "a/two", output_modalities: ["image"] },
            { id: "a/three", output_modalities: ["text"] },
          ],
        }),
      ),
    });

    expect(await provider.verify()).toEqual({
      ok: true,
      summary: "2 image models visible",
    });
  });

  it("says the key is invalid on a 401, and nothing else", async () => {
    const provider = new OpenRouterProvider({
      apiKey: KEY,
      fetch: fetchReturning(json(401, { error: { message: "No auth credentials" } })),
    });

    const result = await provider.verify();
    expect(result).toEqual({
      ok: false,
      reason: "auth_failed",
      summary: "invalid key (401)",
    });
  });

  it("says a 402 is credits, not a bad key", async () => {
    const provider = new OpenRouterProvider({
      apiKey: KEY,
      fetch: fetchReturning(json(402, { error: { message: "Insufficient credits" } })),
    });

    expect((await provider.verify()).summary).toBe("no credits (402)");
  });

  it("refuses to pretend when there is no key at all", async () => {
    const provider = new OpenRouterProvider({ fetch: fetchReturning(json(200, {})) });
    const result = await provider.verify();

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("auth_failed");
  });
});

describe("Azure's check", () => {
  const base = {
    endpoint: "https://example.openai.azure.com",
    deployments: { "gpt-image-2": "prod" },
  };

  it("reports the resource accepting an api key, and what it holds", async () => {
    const provider = new AzureProvider({
      ...base,
      auth: "api_key",
      apiKey: KEY,
      fetch: fetchReturning(json(200, { data: [{ id: "one" }, { id: "two" }] })),
    });

    const result = await provider.verify();
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("2 models");
    expect(result.summary).toContain("1 deployment configured");
  });

  it("sends the key as api-key and never in a message", async () => {
    const seen: RequestInit[] = [];
    const provider = new AzureProvider({
      ...base,
      auth: "api_key",
      apiKey: KEY,
      fetch: ((_url: string, init: RequestInit) => {
        seen.push(init);
        return Promise.resolve(json(200, { data: [] }));
      }) as unknown as typeof globalThis.fetch,
    });

    const result = await provider.verify();
    expect((seen[0]?.headers as Record<string, string>)["api-key"]).toBe(KEY);
    expect(seen[0]?.method).toBe("GET");
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it("calls a 401 an invalid key", async () => {
    const provider = new AzureProvider({
      ...base,
      auth: "api_key",
      apiKey: KEY,
      fetch: fetchReturning(json(401, { error: { message: "Access denied" } })),
    });

    expect(await provider.verify()).toEqual({
      ok: false,
      reason: "auth_failed",
      summary: "invalid key (401)",
    });
  });

  it("claims nothing from a status that neither accepts nor refuses the key", async () => {
    const provider = new AzureProvider({
      ...base,
      auth: "api_key",
      apiKey: KEY,
      fetch: fetchReturning(json(404, { error: { message: "Resource not found" } })),
    });

    const result = await provider.verify();
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("nothing could be proven");
  });

  it("says a disabled provider is disabled rather than asking the network", async () => {
    const provider = new AzureProvider({
      ...base,
      enabled: false,
      auth: "api_key",
      apiKey: KEY,
      fetch: (() =>
        Promise.reject(
          new Error("must not be called"),
        )) as unknown as typeof globalThis.fetch,
    });

    const result = await provider.verify();
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("invalid_request");
  });

  it("reports a failed token acquisition as an identity problem", async () => {
    const provider = new AzureProvider({
      ...base,
      auth: "entra",
      getAccessToken: () => Promise.reject(new Error("no identity endpoint")),
      fetch: fetchReturning(json(200, { data: [] })),
    });

    const result = await provider.verify();
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("auth_failed");
  });

  it("says plainly that a MAI-only resource proves the identity, not the deployment", async () => {
    const provider = new AzureProvider({
      endpoint: "https://example.openai.azure.com",
      deployments: { "mai-image-1": { deployment: "mai-1", dialect: "mai" } },
      auth: "entra",
      getAccessToken: () => Promise.resolve("a-token"),
      fetch: (() =>
        Promise.reject(
          new Error("must not be called"),
        )) as unknown as typeof globalThis.fetch,
    });

    const result = await provider.verify();
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("proves the identity, not the deployment");
  });

  it("does not call an identity's token a verified deployment when the listing is absent", async () => {
    const provider = new AzureProvider({
      ...base,
      auth: "entra",
      getAccessToken: () => Promise.resolve("a-token"),
      fetch: fetchReturning(json(404, { error: { message: "no such path" } })),
    });

    const result = await provider.verify();
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("proves the identity, not the deployment");
  });
});

describe("remembering the last verification", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "imagine-verify-"));
  });

  it("writes the record beside the cost log", () => {
    const costLog = join(directory, "costs.jsonl");
    expect(verificationFileFor(costLog)).toBe(join(directory, VERIFICATION_FILE_NAME));
    expect(verificationFileFor(null)).toBeNull();
  });

  it("reads back what it recorded, and a second store sees it too", async () => {
    const costLog = join(directory, "costs.jsonl");
    const store = createVerificationStore({ costLog });
    const entry = {
      at: "2026-09-04T10:00:00.000Z",
      ok: true,
      summary: "31 image models visible",
      reason: null,
    };

    await store.record("openrouter", entry);
    expect(await store.get("openrouter")).toEqual(entry);

    const other = createVerificationStore({ costLog });
    expect(await other.get("openrouter")).toEqual(entry);
    expect(await other.all()).toEqual({ openrouter: entry });
  });

  it("keeps every provider's own last outcome", async () => {
    const store = createVerificationStore({ costLog: join(directory, "costs.jsonl") });

    await store.record("openrouter", {
      at: "2026-09-04T10:00:00.000Z",
      ok: true,
      summary: "ok",
      reason: null,
    });
    await store.record("azure", {
      at: "2026-09-04T10:01:00.000Z",
      ok: false,
      summary: "invalid key (401)",
      reason: "auth_failed",
    });

    const all = await store.all();
    expect(Object.keys(all).sort()).toEqual(["azure", "openrouter"]);
    expect(all["azure"]?.reason).toBe("auth_failed");
  });

  it("forgets a provider outright, in memory and in the file", async () => {
    const costLog = join(directory, "costs.jsonl");
    const store = createVerificationStore({ costLog });
    await store.record("openrouter", {
      at: "2026-09-04T10:00:00.000Z",
      ok: true,
      summary: "ok",
      reason: null,
    });

    await store.forget("openrouter");

    expect(await store.get("openrouter")).toBeNull();
    expect(await store.all()).toEqual({});
    expect(await createVerificationStore({ costLog }).get("openrouter")).toBeNull();
  });

  it("still remembers within the process when there is no file to write", async () => {
    const store = createVerificationStore({ costLog: null });
    const entry = {
      at: "2026-09-04T10:00:00.000Z",
      ok: true,
      summary: "ok",
      reason: null,
    };

    await store.record("openrouter", entry);
    expect(await store.get("openrouter")).toEqual(entry);
  });

  it("does not fail a recording because the file could not be written", async () => {
    const lines: string[] = [];
    // A directory where the file should be: the write cannot succeed.
    const store = createVerificationStore({
      costLog: join(directory, VERIFICATION_FILE_NAME, "costs.jsonl"),
      log: (line) => lines.push(line),
    });

    await expect(
      store.record("openrouter", {
        at: "2026-09-04T10:00:00.000Z",
        ok: true,
        summary: "ok",
        reason: null,
      }),
    ).resolves.toBeUndefined();
  });

  it("ignores a file that has been corrupted rather than refusing to start", async () => {
    const costLog = join(directory, "costs.jsonl");
    await writeFile(join(directory, VERIFICATION_FILE_NAME), "{not json", "utf8");

    const store = createVerificationStore({ costLog });
    expect(await store.all()).toEqual({});
  });

  it("drops entries that are not shaped like a verification", () => {
    expect(
      parseVerifications('{"a": 1, "b": {"at": "x", "ok": true, "summary": "s"}}'),
    ).toEqual({ b: { at: "x", ok: true, summary: "s", reason: null } });
    expect(parseVerifications("[]")).toEqual({});
    expect(parseVerifications("nonsense")).toEqual({});
  });

  it("writes JSON a person can read", async () => {
    const costLog = join(directory, "costs.jsonl");
    const store = createVerificationStore({ costLog });
    await store.record("openrouter", {
      at: "2026-09-04T10:00:00.000Z",
      ok: false,
      summary: "invalid key (401)",
      reason: "auth_failed",
    });

    const raw = await readFile(join(directory, VERIFICATION_FILE_NAME), "utf8");
    expect(raw).toContain("invalid key (401)");
    expect(raw).not.toContain(KEY);
  });
});
