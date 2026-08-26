import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ImagineError } from "../../src/core/errors.js";
import {
  contentHash,
  extensionFromMimeType,
  slugFromPrompt,
  writeImage,
  type ManifestRecord,
  type OutputConfig,
} from "../../src/core/output.js";
import type { NormalisedRequest, NormalisedResult } from "../../src/core/types.js";

const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
]);

function request(overrides: Partial<NormalisedRequest> = {}): NormalisedRequest {
  return { prompt: "A regional distribution network", ...overrides };
}

function result(overrides: Partial<NormalisedResult> = {}): NormalisedResult {
  return {
    bytes: PNG_BYTES,
    mime_type: "image/png",
    provider: "openrouter",
    model: "google/gemini-3.1-flash-image",
    cost_usd: 0.039,
    duration_ms: 4180,
    width: 1536,
    height: 1024,
    ...overrides,
  };
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "imagine-output-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function config(overrides: Partial<OutputConfig> = {}): OutputConfig {
  return { dir, ...overrides };
}

async function manifestLines(manifestPath: string): Promise<ManifestRecord[]> {
  const raw = await readFile(manifestPath, "utf8");
  return raw
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as ManifestRecord);
}

describe("slugFromPrompt", () => {
  it("lowercases and joins words with hyphens", () => {
    expect(slugFromPrompt("A Clean, Flat-Vector Diagram!")).toBe(
      "a-clean-flat-vector-diagram",
    );
  });

  it("folds accents and drops other scripts", () => {
    expect(slugFromPrompt("Café über alles")).toBe("cafe-uber-alles");
  });

  it("falls back to a fixed name when nothing survives", () => {
    expect(slugFromPrompt("🎨🎨🎨")).toBe("image");
    expect(slugFromPrompt("   ")).toBe("image");
  });

  it("truncates a long prompt on a word boundary", () => {
    const slug = slugFromPrompt(
      "one central warehouse with four spokes to smaller depots in a muted blue and slate palette",
    );

    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug.endsWith("-")).toBe(false);
    expect(slug).toBe("one-central-warehouse-with-four-spokes-to-smaller-depots-in");
  });

  it("truncates hard when a single word is longer than the limit", () => {
    expect(slugFromPrompt("x".repeat(200))).toHaveLength(60);
  });
});

describe("extensionFromMimeType", () => {
  it.each([
    ["image/png", "png"],
    ["image/jpeg", "jpg"],
    ["image/webp", "webp"],
    ["image/svg+xml", "svg"],
    ["image/png; charset=binary", "png"],
    ["IMAGE/PNG", "png"],
    ["application/octet-stream", "bin"],
    ["nonsense", "bin"],
  ])("maps %s to %s", (mime, expected) => {
    expect(extensionFromMimeType(mime)).toBe(expected);
  });
});

describe("writeImage", () => {
  it("writes the bytes under the default {slug}-{hash}.{ext} name", async () => {
    const written = await writeImage(request(), result(), config());

    expect(path.dirname(written.path)).toBe(dir);
    expect(path.basename(written.path)).toBe(
      `a-regional-distribution-network-${contentHash(PNG_BYTES)}.png`,
    );
    expect(new Uint8Array(await readFile(written.path))).toStrictEqual(PNG_BYTES);
  });

  it("honours a filename template from config", async () => {
    const written = await writeImage(
      request(),
      result({ mime_type: "image/jpeg" }),
      config({ filename: "img_{hash}_{slug}.{ext}" }),
    );

    expect(path.basename(written.path)).toBe(
      `img_${contentHash(PNG_BYTES)}_a-regional-distribution-network.jpg`,
    );
  });

  it("creates the output directory, including missing parents", async () => {
    const nested = path.join(dir, "deep", "deeper", "images");

    const written = await writeImage(request(), result(), config({ dir: nested }));

    expect(path.dirname(written.path)).toBe(nested);
  });

  it("respects output_dir from the request over the configured dir", async () => {
    const requested = path.join(dir, "from-request");

    const written = await writeImage(
      request({ output_dir: requested }),
      result(),
      config({ dir: path.join(dir, "from-config") }),
    );

    expect(path.dirname(written.path)).toBe(requested);
  });

  it("resolves a relative directory against the working directory", async () => {
    const relative = path.relative(process.cwd(), path.join(dir, "relative"));

    const written = await writeImage(request(), result(), config({ dir: relative }));

    expect(path.isAbsolute(written.path)).toBe(true);
    expect(path.dirname(written.path)).toBe(path.join(dir, "relative"));
  });

  it("never overwrites: a colliding name gets a numeric suffix", async () => {
    const first = await writeImage(request(), result(), config());
    await writeFile(first.path, "sentinel", "utf8");

    const second = await writeImage(request(), result(), config());
    const third = await writeImage(request(), result(), config());

    const { name, ext } = path.parse(first.path);
    expect(path.basename(second.path)).toBe(`${name}-2${ext}`);
    expect(path.basename(third.path)).toBe(`${name}-3${ext}`);
    expect(await readFile(first.path, "utf8")).toBe("sentinel");
  });

  it("suffixes correctly when the template has no extension", async () => {
    const first = await writeImage(request(), result(), config({ filename: "{slug}" }));
    const second = await writeImage(
      request(),
      result(),
      config({ filename: "{slug}" }),
    );

    expect(path.basename(first.path)).toBe("a-regional-distribution-network");
    expect(path.basename(second.path)).toBe("a-regional-distribution-network-2");
  });
});

describe("writeImage path sanitisation", () => {
  it("keeps a traversal-shaped prompt inside the output directory", async () => {
    const written = await writeImage(
      request({ prompt: "../../etc/passwd" }),
      result(),
      config(),
    );

    expect(path.dirname(written.path)).toBe(dir);
    expect(path.basename(written.path)).toBe(
      `etc-passwd-${contentHash(PNG_BYTES)}.png`,
    );
  });

  it.each([
    ["posix separator", "{slug}/{hash}.{ext}"],
    ["windows separator", "{slug}\\{hash}.{ext}"],
    ["posix traversal", "../{slug}.{ext}"],
    ["windows traversal", "..\\{slug}.{ext}"],
    ["absolute posix path", "/etc/{slug}.{ext}"],
    ["windows drive path", "C:{slug}.{ext}"],
  ])("rejects a filename template with a %s", async (_label, filename) => {
    const failure = await writeImage(request(), result(), config({ filename })).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(ImagineError);
    expect((failure as ImagineError).reason).toBe("invalid_request");
  });

  it("rejects an unknown placeholder with a message naming the known ones", async () => {
    const failure = await writeImage(
      request(),
      result(),
      config({ filename: "{slug}-{provider}.{ext}" }),
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ImagineError);
    expect((failure as ImagineError).reason).toBe("invalid_request");
    expect((failure as ImagineError).message).toContain("{provider}");
    expect((failure as ImagineError).message).toContain("{slug}");
  });

  it("rejects an empty output_dir", async () => {
    const failure = await writeImage(
      request({ output_dir: "  " }),
      result(),
      config(),
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ImagineError);
    expect((failure as ImagineError).reason).toBe("invalid_request");
    expect((failure as ImagineError).message).toContain("output_dir");
  });

  it("rejects an output_dir containing a null byte", async () => {
    const failure = await writeImage(
      request({ output_dir: `${dir}\u0000/evil` }),
      result(),
      config(),
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ImagineError);
    expect((failure as ImagineError).reason).toBe("invalid_request");
  });

  it("reports a clear error when the output directory is an existing file", async () => {
    const asFile = path.join(dir, "not-a-directory");
    await writeFile(asFile, "", "utf8");

    const failure = await writeImage(
      request(),
      result(),
      config({ dir: asFile }),
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ImagineError);
    expect((failure as ImagineError).reason).toBe("invalid_request");
    expect((failure as ImagineError).message).toContain(asFile);
    expect((failure as ImagineError).cause).toBeInstanceOf(Error);
  });
});

describe("writeImage manifest", () => {
  it("appends one JSONL record per image beside the images by default", async () => {
    const first = await writeImage(request(), result(), config());
    const second = await writeImage(
      request({ prompt: "A second picture" }),
      result({ provider: "azure", model: "gpt-image-2", cost_usd: null }),
      config(),
    );

    expect(first.manifest_path).toBe(path.join(dir, "manifest.jsonl"));
    expect(second.manifest_path).toBe(first.manifest_path);

    const records = await manifestLines(first.manifest_path);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      path: first.path,
      prompt: "A regional distribution network",
      provider: "openrouter",
      model: "google/gemini-3.1-flash-image",
      cost_usd: 0.039,
      width: 1536,
      height: 1024,
      mime_type: "image/png",
      duration_ms: 4180,
    });
    expect(Date.parse(records[0]?.created_at ?? "")).not.toBeNaN();
    expect(records[1]).toMatchObject({ path: second.path, cost_usd: null });
  });

  it("writes to a configured manifest path, creating its directory", async () => {
    const manifest = path.join(dir, "meta", "gallery.jsonl");

    const written = await writeImage(request(), result(), config({ manifest }));

    expect(written.manifest_path).toBe(manifest);
    expect(await manifestLines(manifest)).toHaveLength(1);
  });

  it("keeps a configured manifest even when output_dir overrides the directory", async () => {
    const manifest = path.join(dir, "gallery.jsonl");
    const elsewhere = path.join(dir, "one-off");
    await mkdir(elsewhere, { recursive: true });

    const written = await writeImage(
      request({ output_dir: elsewhere }),
      result(),
      config({ manifest }),
    );

    expect(written.manifest_path).toBe(manifest);
    expect((await manifestLines(manifest))[0]?.path).toBe(written.path);
  });

  it("records the suffixed path when the name collided", async () => {
    const first = await writeImage(request(), result(), config());
    const second = await writeImage(request(), result(), config());

    const records = await manifestLines(second.manifest_path);
    expect(records.map((record) => record.path)).toStrictEqual([
      first.path,
      second.path,
    ]);
  });
});
