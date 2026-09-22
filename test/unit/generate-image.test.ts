import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createBlobSink } from "../../src/core/blob-sink.js";
import { CostLedger } from "../../src/core/budget.js";
import { DEFAULT_CONFIG, type Config } from "../../src/core/config-schema.js";
import { parseModelKnowledge, type ModelKnowledge } from "../../src/core/knowledge.js";
import type { NormalisedResult } from "../../src/core/types.js";
import { ImagineError } from "../../src/core/errors.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createServer, type ServerDependencies } from "../../src/mcp/server.js";
import {
  INLINE_IMAGE_MAX_BASE64_LENGTH,
  succeeded,
  type GenerateImageSuccess,
  type GeneratedImage,
  type RenderableLink,
} from "../../src/mcp/tools/generate-image.js";
import { StubProvider } from "../../src/providers/stub.js";
import type { ImageProvider } from "../../src/providers/types.js";

const PRICE_PER_IMAGE = 0.04;

/** The base64 the stub decodes: allowed in the image item and nowhere else. */
const ONE_PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const knowledge: ModelKnowledge = parseModelKnowledge({
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
        per_image_usd: PRICE_PER_IMAGE,
        per_image_usd_4k: null,
        confidence: "indicative",
        checked: "2026-08-26",
      },
      availability: [{ provider: "stub", model_ref: "stub-image-1" }],
      max_size: "1024x1024",
      notes: "Only exists in tests.",
    },
  ],
});

class UnconfiguredProvider extends StubProvider {
  override isConfigured(): boolean {
    return false;
  }
}

class FailingProvider implements ImageProvider {
  readonly id = "stub";

  constructor(private readonly failure: ImagineError) {}

  isConfigured(): boolean {
    return true;
  }

  listModels(): Promise<never[]> {
    return Promise.resolve([]);
  }

  generate(): Promise<NormalisedResult> {
    return Promise.reject(this.failure);
  }
}

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "imagine-generate-image-"));
});

function config(overrides: Partial<Config> = {}): Config {
  const base = structuredClone(DEFAULT_CONFIG);
  return {
    ...base,
    ...overrides,
    output: { ...base.output, dir: directory, manifest: null, ...overrides.output },
    logging: {
      ...base.logging,
      cost_log: join(directory, "costs.jsonl"),
      ...overrides.logging,
    },
  };
}

function inlineImagesOff(): Config {
  const base = config();
  return { ...base, output: { ...base.output, inline_image: false } };
}

function dependencies(overrides: Partial<ServerDependencies> = {}): ServerDependencies {
  const resolved = overrides.config ?? config();
  return {
    config: resolved,
    knowledge,
    ledger: new CostLedger({
      budget: resolved.budget,
      costLog: resolved.logging.cost_log,
    }),
    providers: [new StubProvider()],
    ...overrides,
  };
}

async function connect(deps: ServerDependencies): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([
    createServer(deps).connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

interface ContentItem {
  type: string;
  text?: string;
  data?: string;
  uri?: string;
  name?: string;
  mimeType?: string;
  description?: string;
}

interface ToolResult {
  content: ContentItem[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

async function callGenerateImage(
  deps: ServerDependencies,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const client = await connect(deps);
  try {
    return (await client.callTool({
      name: "generate_image",
      arguments: args,
    })) as unknown as ToolResult;
  } finally {
    await client.close();
  }
}

function payload(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
}

describe("the generate_image tool", () => {
  it("is listed with the parameters PLAN.md §5.1 names", async () => {
    const client = await connect(dependencies());
    const { tools } = await client.listTools();
    await client.close();

    const tool = tools.find((entry) => entry.name === "generate_image");
    expect(tool).toBeDefined();
    expect(Object.keys(tool?.inputSchema.properties ?? {}).sort()).toEqual([
      "output_dir",
      "prompt",
      "provider_hint",
      "size",
      "style",
      "use_case",
    ]);
    expect(tool?.inputSchema.required).toEqual(["prompt"]);
  });

  it("writes the image to the requested directory and returns its path", async () => {
    const target = join(directory, "deck");
    const result = await callGenerateImage(dependencies(), {
      prompt: "A regional distribution network",
      use_case: "diagram",
      output_dir: target,
    });

    expect(result.isError).toBeFalsy();
    const body = payload(result);
    expect(body["provider"]).toBe("stub");
    expect(body["model"]).toBe("stub-image-1");
    expect(body["selection_reason"]).toContain("use_case=diagram");
    expect(body["cost_usd"]).toBe(0);
    expect(body["budget"]).toEqual({ session_spent_usd: 0, session_limit_usd: 5 });

    const written = await readFile(String(body["path"]));
    expect(written.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(String(body["path"]).startsWith(target)).toBe(true);
    expect(result.structuredContent?.["path"]).toBe(body["path"]);
  });

  it("records what the generation cost, using the curated estimate when the provider reports none", async () => {
    class PricelessProvider extends StubProvider {
      override async generate(
        ...args: Parameters<StubProvider["generate"]>
      ): Promise<NormalisedResult> {
        return { ...(await super.generate(...args)), cost_usd: null };
      }
    }

    const deps = dependencies({ providers: [new PricelessProvider()] });
    const body = payload(await callGenerateImage(deps, { prompt: "A blue square" }));

    expect(body["cost_usd"]).toBe(PRICE_PER_IMAGE);
    expect(deps.ledger.spentThisSession()).toBe(PRICE_PER_IMAGE);
    expect((body["budget"] as Record<string, unknown>)["session_spent_usd"]).toBe(
      PRICE_PER_IMAGE,
    );

    const log = await readFile(join(directory, "costs.jsonl"), "utf8");
    expect(JSON.parse(log.trim()) as Record<string, unknown>).toMatchObject({
      provider: "stub",
      model: "stub-image-1",
      cost_usd: PRICE_PER_IMAGE,
      cost_source: "estimate",
      billed: true,
    });
  });

  it("returns the picture itself as an image item, so the chat can show it", async () => {
    const result = await callGenerateImage(dependencies(), {
      prompt: "A one pixel image",
    });

    const image = result.content.find((item) => item.type === "image");
    expect(image?.mimeType).toBe("image/png");
    expect(image?.data).toBe(ONE_PIXEL_PNG_BASE64);
    const decoded = Buffer.from(String(image?.data), "base64");
    expect(decoded.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(decoded).toEqual(await readFile(String(payload(result)["path"])));
  });

  it("keeps base64 out of the envelope and every text item", async () => {
    const result = await callGenerateImage(dependencies(), {
      prompt: "A one pixel image",
    });

    const texts = JSON.stringify(
      result.content.filter((item) => item.type !== "image"),
    );
    expect(texts).not.toContain(ONE_PIXEL_PNG_BASE64);
    expect(texts).not.toContain("iVBORw0KGgo");
    expect(texts).not.toMatch(/[A-Za-z0-9+/]{64,}={0,2}/);
    expect(JSON.stringify(result.structuredContent)).not.toContain("iVBORw0KGgo");
  });

  it("puts no base64 anywhere when inline images are switched off", async () => {
    const serialised = JSON.stringify(
      await callGenerateImage(dependencies({ config: inlineImagesOff() }), {
        prompt: "A one pixel image",
      }),
    );

    expect(serialised).not.toContain(ONE_PIXEL_PNG_BASE64);
    expect(serialised).not.toContain("iVBORw0KGgo");
    expect(serialised).not.toMatch(/[A-Za-z0-9+/]{64,}={0,2}/);
  });

  it("refuses over budget with a failure envelope rather than a protocol error", async () => {
    const overspent = config({
      budget: { max_usd_per_session: 0.01, max_usd_per_day: null, on_exceed: "refuse" },
    });
    const result = await callGenerateImage(dependencies({ config: overspent }), {
      prompt: "An expensive image",
    });

    expect(result.isError).toBe(true);
    const body = payload(result);
    expect(body["error"]).toBe("budget_exceeded");
    expect(body["retryable"]).toBe(false);
    expect(body["cost_usd"]).toBe(0);
    expect(body["provider"]).toBe("stub");
    expect(body["model"]).toBe("stub-image-1");
    expect(String(body["message"])).toContain("session budget");
    expect(String(body["suggestion"])).toContain("budget.max_usd_per_session");

    await expect(readdir(directory)).resolves.toEqual(["costs.jsonl"]);
  });

  it("flags an exceeded budget but still generates when on_exceed is warn", async () => {
    const warned = config({
      budget: { max_usd_per_session: 0.01, max_usd_per_day: null, on_exceed: "warn" },
    });
    const body = payload(
      await callGenerateImage(dependencies({ config: warned }), {
        prompt: "A warning",
      }),
    );

    expect(String(body["budget_warning"])).toContain("session budget");
    expect(body["path"]).toBeDefined();
  });

  it("degrades to a failure envelope when no provider is configured", async () => {
    const result = await callGenerateImage(
      dependencies({ providers: [new UnconfiguredProvider()] }),
      { prompt: "An image nobody can make" },
    );

    expect(result.isError).toBe(true);
    const body = payload(result);
    expect(body["error"]).toBe("invalid_request");
    expect(body["provider"]).toBeNull();
    expect(body["model"]).toBeNull();
    expect(String(body["message"])).toContain("No image provider is available");
    expect(String(body["message"])).toContain("unconfigured");
    expect(body["retryable"]).toBe(false);
  });

  it("reports a provider failure with its reason, suggestion and billing", async () => {
    const failure = new ImagineError("content_filtered", "Rejected under policy.", {
      retryable: false,
      billed: false,
    });
    const deps = dependencies({ providers: [new FailingProvider(failure)] });
    const body = payload(
      await callGenerateImage(deps, { prompt: "Something filtered" }),
    );

    expect(body["error"]).toBe("content_filtered");
    expect(body["cost_usd"]).toBe(0);
    expect(String(body["suggestion"])).toContain("provider_hint");
    expect(deps.ledger.spentThisSession()).toBe(0);

    const log = await readFile(join(directory, "costs.jsonl"), "utf8");
    expect(JSON.parse(log.trim()) as Record<string, unknown>).toMatchObject({
      failure_reason: "content_filtered",
      billed: false,
      cost_usd: 0,
    });
  });

  it("rejects an empty prompt before anything is routed", async () => {
    const result = await callGenerateImage(dependencies(), { prompt: "" });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Input validation error");
    await expect(readdir(directory)).resolves.toEqual([]);
  });
});

describe("the blob sink, end to end", () => {
  const ACCOUNT_URL = "https://mystorage.blob.core.windows.net";

  /**
   * The signed link can never outlive the delegation key, so these two are
   * relative to now: a fixed date would quietly turn this suite into a time
   * bomb that fails on the day the key expires.
   */
  function isoOffsetFromNow(hours: number): string {
    return new Date(Date.now() + hours * 60 * 60 * 1000)
      .toISOString()
      .replace(/\.\d+Z$/, "Z");
  }

  const keyXml = [
    "<UserDelegationKey>",
    "<SignedOid>11111111-1111-1111-1111-111111111111</SignedOid>",
    "<SignedTid>22222222-2222-2222-2222-222222222222</SignedTid>",
    `<SignedStart>${isoOffsetFromNow(-1)}</SignedStart>`,
    `<SignedExpiry>${isoOffsetFromNow(24)}</SignedExpiry>`,
    "<SignedService>b</SignedService>",
    "<SignedVersion>2020-12-06</SignedVersion>",
    "<Value>aW1hZ2luZS10ZXN0LWRlbGVnYXRpb24ta2V5</Value>",
    "</UserDelegationKey>",
  ].join("");

  function blobDependencies(resolved: Config = config()): ServerDependencies {
    const fetchImpl = (input: string | URL) =>
      Promise.resolve(
        String(input).includes("comp=userdelegationkey")
          ? new Response(keyXml, { status: 200 })
          : new Response(null, { status: 201 }),
      );

    return dependencies({
      config: resolved,
      sink: createBlobSink({
        accountUrl: ACCOUNT_URL,
        container: "images",
        urlTtlHours: 1,
        getAccessToken: () => Promise.resolve("token-value"),
        fetch: fetchImpl as unknown as typeof globalThis.fetch,
      }),
    });
  }

  it("returns the blob URL as path and a renderable link as url", async () => {
    const result = await callGenerateImage(blobDependencies(), {
      prompt: "A lighthouse at dusk",
    });

    const body = payload(result);
    expect(result.isError).toBeFalsy();
    expect(body["path"]).toMatch(
      /^https:\/\/mystorage\.blob\.core\.windows\.net\/images\/a-lighthouse-at-dusk-[0-9a-f]{8}\.png$/,
    );
    expect(String(body["url"])).toContain("sig=");
    expect(String(body["url"])).toContain("&sr=b");
    expect(result.structuredContent?.["url"]).toBe(body["url"]);
  });

  it("says when the link expires, in ISO 8601 and in the future", async () => {
    const result = await callGenerateImage(blobDependencies(), {
      prompt: "A lighthouse at dusk",
    });

    const body = payload(result);
    const expiry = String(body["url_expires_at"]);
    expect(expiry).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(Date.parse(expiry)).toBeGreaterThan(Date.now());
    // One hour of TTL, so within the hour and not much short of it.
    expect(Date.parse(expiry) - Date.now()).toBeLessThanOrEqual(60 * 60 * 1000);
    expect(Date.parse(expiry) - Date.now()).toBeGreaterThan(55 * 60 * 1000);
    // The envelope's expiry is the moment the SAS itself was signed for.
    expect(String(body["url"])).toContain(`se=${encodeURIComponent(expiry)}`);
    expect(result.structuredContent?.["url_expires_at"]).toBe(expiry);
  });

  it("sends the picture inline and the link beside it, in that order", async () => {
    const result = await callGenerateImage(blobDependencies(), {
      prompt: "A lighthouse at dusk",
    });

    expect(result.content.map((item) => item.type)).toEqual([
      "text",
      "image",
      "text",
      "resource_link",
    ]);
    expect(payload(result)["url"]).toBeDefined();
  });

  it("tells the model the picture is already shown, and offers the link", async () => {
    const result = await callGenerateImage(blobDependencies(), {
      prompt: "A lighthouse at dusk",
    });

    const body = payload(result);
    const hint = result.content[2]?.text ?? "";
    expect(hint).toContain("do not also write it as a markdown image");
    expect(hint).toContain(
      `${String(body["url"])} (link valid until ${String(body["url_expires_at"])})`,
    );
    expect(hint).not.toContain("![");
  });

  it("tells the model to render the link as a markdown image when inline images are off", async () => {
    const result = await callGenerateImage(blobDependencies(inlineImagesOff()), {
      prompt: "A lighthouse at dusk",
    });
    expect(result.content.map((item) => item.type)).toEqual([
      "text",
      "text",
      "resource_link",
    ]);

    const body = payload(result);
    const hint = result.content.find(
      (item) => item.type === "text" && item.text?.startsWith("Show the image"),
    );
    expect(hint?.text).toContain(
      `![A lighthouse at dusk](${String(body["url"])}) (link valid until ${String(body["url_expires_at"])})`,
    );
    expect(hint?.text).toContain("Do not fetch, download or re-encode the bytes");
  });

  it("repeats the link as a resource_link content item", async () => {
    const result = await callGenerateImage(blobDependencies(), {
      prompt: "A lighthouse at dusk",
    });

    const body = payload(result);
    const link = result.content.find((item) => item.type === "resource_link");
    expect(link?.uri).toBe(body["url"]);
    expect(link?.name).toMatch(/^a-lighthouse-at-dusk-[0-9a-f]{8}\.png$/);
    expect(link?.mimeType).toBe("image/png");
    expect(link?.description).toBe("A lighthouse at dusk");
  });

  it("sends the bytes only as the image item", async () => {
    const result = await callGenerateImage(blobDependencies(), {
      prompt: "A lighthouse at dusk",
    });

    const carriers = result.content.filter((item) =>
      JSON.stringify(item).includes(ONE_PIXEL_PNG_BASE64),
    );
    expect(carriers.map((item) => item.type)).toEqual(["image"]);
  });

  it("records the link in the manifest next to the blob path", async () => {
    await callGenerateImage(blobDependencies(), { prompt: "A lighthouse at dusk" });

    const manifest = await readFile(join(directory, "manifest.jsonl"), "utf8");
    const record = JSON.parse(manifest.trim()) as Record<string, unknown>;
    expect(String(record["path"])).toContain(`${ACCOUNT_URL}/images/`);
    expect(String(record["url"])).toContain("sig=");
  });

  it("leaves local mode with no url at all", async () => {
    const result = await callGenerateImage(dependencies(), {
      prompt: "A lighthouse at dusk",
    });

    expect(payload(result)["url"]).toBeUndefined();
    expect(payload(result)["url_expires_at"]).toBeUndefined();
    expect(result.content.map((item) => item.type)).toEqual(["text", "image", "text"]);
    expect(result.content[2]?.text).toContain(String(payload(result)["path"]));
  });

  it("leaves local mode with only the envelope when inline images are off", async () => {
    const result = await callGenerateImage(
      dependencies({ config: inlineImagesOff() }),
      {
        prompt: "A lighthouse at dusk",
      },
    );

    expect(result.content.map((item) => item.type)).toEqual(["text"]);
  });
});

describe("succeeded", () => {
  const envelope: GenerateImageSuccess = {
    path: "https://mystorage.blob.core.windows.net/images/a-lighthouse-0123abcd.png",
    url: "https://mystorage.blob.core.windows.net/images/a-lighthouse-0123abcd.png?sig=x",
    url_expires_at: "2026-09-22T13:00:00Z",
    provider: "stub",
    model: "stub-image-1",
    cost_usd: 0.04,
    duration_ms: 10,
    width: 1024,
    height: 1024,
    selection_reason: "test",
    budget: { session_spent_usd: 0.04, session_limit_usd: 5 },
  };

  const link: RenderableLink = {
    url: envelope.url as string,
    url_expires_at: envelope.url_expires_at as string,
    alt: "A lighthouse",
    filename: "a-lighthouse-0123abcd.png",
    mimeType: "image/jpeg",
  };

  /** The largest byte count whose base64 still fits under the cap. */
  const LARGEST_INLINE_BYTES = (INLINE_IMAGE_MAX_BASE64_LENGTH / 4) * 3;

  function image(byteCount: number, mimeType = "image/jpeg"): GeneratedImage {
    const bytes = new Uint8Array(byteCount);
    bytes.set([0xff, 0xd8, 0xff]);
    return { bytes, mimeType };
  }

  function types(result: CallToolResult): string[] {
    return result.content.map((item) => item.type);
  }

  it("keeps the unchanged envelope as the first content item", () => {
    const result = succeeded(envelope, { image: image(10), inlineImage: true, link });

    const first = result.content[0];
    expect(first?.type).toBe("text");
    expect(JSON.parse(first?.type === "text" ? first.text : "")).toEqual(envelope);
    expect(result.structuredContent).toEqual(envelope);
  });

  it("adds the picture as an image item with its mime type and decodable base64", () => {
    const picture = image(10);
    const result = succeeded(envelope, { image: picture, inlineImage: true, link });

    const item = result.content[1];
    expect(item?.type).toBe("image");
    if (item?.type !== "image") return;
    expect(item.mimeType).toBe("image/jpeg");
    expect(new Uint8Array(Buffer.from(item.data, "base64"))).toEqual(picture.bytes);
  });

  it("keeps the resource_link next to the image", () => {
    const result = succeeded(envelope, { image: image(10), inlineImage: true, link });

    expect(types(result)).toEqual(["text", "image", "text", "resource_link"]);
    expect(result.content[3]).toMatchObject({ type: "resource_link", uri: link.url });
  });

  it("still sends an image right at the cap", () => {
    const result = succeeded(envelope, {
      image: image(LARGEST_INLINE_BYTES),
      inlineImage: true,
      link,
    });

    expect(types(result)).toContain("image");
  });

  it("drops the image above the cap, keeps the link and says why", () => {
    const result = succeeded(envelope, {
      image: image(LARGEST_INLINE_BYTES + 1),
      inlineImage: true,
      link,
    });

    expect(types(result)).toEqual(["text", "text", "resource_link"]);
    const hint = result.content[1];
    const text = hint?.type === "text" ? hint.text : "";
    expect(text).toContain("larger than what chat clients accept inline");
    expect(text).toContain("open the link");
    expect(text).toContain(`![${link.alt}](${link.url})`);
  });

  it("points at the file above the cap when there is no link", () => {
    const result = succeeded(envelope, {
      image: image(LARGEST_INLINE_BYTES + 1),
      inlineImage: true,
    });

    expect(types(result)).toEqual(["text", "text"]);
    const hint = result.content[1];
    expect(hint?.type === "text" ? hint.text : "").toContain(envelope.path);
  });

  it("sends no image when the switch is off, and falls back to the markdown hint", () => {
    const result = succeeded(envelope, { image: image(10), inlineImage: false, link });

    expect(types(result)).toEqual(["text", "text", "resource_link"]);
    const hint = result.content[1];
    expect(hint?.type === "text" ? hint.text : "").toMatch(
      /^Show the image to the user/,
    );
  });
});
