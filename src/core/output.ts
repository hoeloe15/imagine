/**
 * The only place in the codebase that turns image bytes into a stored image.
 *
 * Everything about where an image lands — naming, collision handling, the
 * manifest the phase 2 gallery reads — lives here, so it behaves identically no
 * matter which adapter produced the bytes and no matter which sink stores them.
 * See ADR 0003, ADR 0006 and ADR 0024.
 */

import { createHash } from "node:crypto";
import { appendFile, mkdir, open } from "node:fs/promises";
import path from "node:path";
import { ImagineError } from "./errors.js";
import type { NormalisedRequest, NormalisedResult } from "./types.js";

/** The `output` section of the config, as PLAN.md §7 defines it. */
export interface OutputConfig {
  dir: string;
  /** Template over `{slug}`, `{hash}` and `{ext}`. */
  filename?: string;
  /** Defaults to `manifest.jsonl` inside the resolved output directory. */
  manifest?: string;
}

/**
 * Where one image ended up. `url` is present only when the sink can hand out a
 * link a client may fetch without credentials of its own.
 */
export interface StoredImage {
  path: string;
  url?: string;
}

/**
 * A place bytes can be put under a name. The local filesystem is the default
 * one and lives in this file; Blob Storage is `core/blob-sink.ts`.
 *
 * A sink is handed a filename that is already slugged, hashed and validated,
 * and is expected to honour the never-overwrite rule the same way the local
 * writer does. See ADR 0024.
 */
export interface ObjectSink {
  put(filename: string, bytes: Uint8Array, mimeType: string): Promise<StoredImage>;
}

/** One line of the JSONL manifest. */
export interface ManifestRecord {
  path: string;
  url?: string;
  prompt: string;
  provider: string;
  model: string;
  cost_usd: number | null;
  width: number;
  height: number;
  mime_type: string;
  duration_ms: number;
  created_at: string;
}

export interface WrittenImage extends StoredImage {
  manifest_path: string;
}

export const DEFAULT_FILENAME_TEMPLATE = "{slug}-{hash}.{ext}";
export const DEFAULT_MANIFEST_NAME = "manifest.jsonl";

const SLUG_MAX_LENGTH = 60;
const HASH_LENGTH = 8;
/** Shared with every sink, so "never overwrite" means one thing everywhere. */
export const MAX_COLLISION_ATTEMPTS = 1000;
const TEMPLATE_KEYS = ["slug", "hash", "ext"] as const;

const EXTENSION_BY_SUBTYPE: Readonly<Record<string, string>> = {
  jpeg: "jpg",
};

const COMBINING_MARKS = /[\u0300-\u036f]/g;

/** The union of what POSIX and Windows refuse in a single path segment. */
// eslint-disable-next-line no-control-regex
const FORBIDDEN_FILENAME_CHARS = /[<>:"|?*\u0000-\u001f]|[/\\]/;

const NULL_BYTE = "\u0000";

export function slugFromPrompt(prompt: string): string {
  const slug = prompt
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (slug === "") return "image";
  if (slug.length <= SLUG_MAX_LENGTH) return slug;

  const overlong = slug.slice(0, SLUG_MAX_LENGTH + 1);
  const lastBoundary = overlong.lastIndexOf("-");
  const cut =
    lastBoundary > 0 ? overlong.slice(0, lastBoundary) : slug.slice(0, SLUG_MAX_LENGTH);
  return cut.replace(/-+$/, "");
}

export function contentHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, HASH_LENGTH);
}

export function extensionFromMimeType(mimeType: string): string {
  const [type, subtype] = (mimeType.split(";")[0] ?? "")
    .trim()
    .toLowerCase()
    .split("/");
  if (type !== "image") return "bin";
  const base = (subtype ?? "").split("+")[0] ?? "";
  const cleaned = (EXTENSION_BY_SUBTYPE[base] ?? base).replace(/[^a-z0-9]/g, "");
  return cleaned === "" ? "bin" : cleaned;
}

function renderFilename(
  template: string,
  values: Readonly<Record<string, string>>,
): string {
  const rendered = template.replace(/\{([^{}]*)\}/g, (_match, key: string) => {
    const value = values[key];
    if (value === undefined) {
      throw new ImagineError(
        "invalid_request",
        `Unknown placeholder {${key}} in output filename template "${template}". ` +
          `Known placeholders: ${TEMPLATE_KEYS.map((k) => `{${k}}`).join(", ")}.`,
      );
    }
    return value;
  });

  if (rendered === "" || rendered === "." || rendered === "..") {
    throw new ImagineError(
      "invalid_request",
      `Output filename template "${template}" produced "${rendered}", which is not a filename.`,
    );
  }

  if (FORBIDDEN_FILENAME_CHARS.test(rendered)) {
    throw new ImagineError(
      "invalid_request",
      `Output filename template "${template}" produced "${rendered}", which contains a path ` +
        `separator or a character a filename may not hold. The template names a file, not a path.`,
    );
  }

  return rendered;
}

function splitFilename(filename: string): { stem: string; suffix: string } {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0) return { stem: filename, suffix: "" };
  return { stem: filename.slice(0, dot), suffix: filename.slice(dot) };
}

/** `name.png`, then `name-2.png`, `name-3.png`, … for `attempt` 1, 2, 3, …. */
export function candidateName(filename: string, attempt: number): string {
  if (attempt === 1) return filename;
  const { stem, suffix } = splitFilename(filename);
  return `${stem}-${attempt}${suffix}`;
}

function resolvePath(value: string, source: string): string {
  if (value.trim() === "") {
    throw new ImagineError("invalid_request", `${source} is empty; it must be a path.`);
  }
  if (value.includes(NULL_BYTE)) {
    throw new ImagineError(
      "invalid_request",
      `${source} contains a null byte and is not a usable path.`,
    );
  }
  return path.resolve(value);
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

async function ensureDirectory(dir: string, source: string): Promise<void> {
  try {
    await mkdir(dir, { recursive: true });
  } catch (cause) {
    throw new ImagineError(
      "invalid_request",
      `Could not create the directory named by ${source}: ${dir} (${describe(cause)})`,
      { cause },
    );
  }
}

function isAlreadyExists(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    (cause as NodeJS.ErrnoException).code === "EEXIST"
  );
}

async function writeWithoutOverwriting(
  dir: string,
  filename: string,
  bytes: Uint8Array,
): Promise<string> {
  for (let attempt = 1; attempt <= MAX_COLLISION_ATTEMPTS; attempt += 1) {
    const candidate = path.join(dir, candidateName(filename, attempt));
    try {
      const handle = await open(candidate, "wx");
      try {
        await handle.writeFile(bytes);
      } finally {
        await handle.close();
      }
      return candidate;
    } catch (cause) {
      if (isAlreadyExists(cause)) continue;
      throw new ImagineError(
        "invalid_request",
        `Could not write the image to ${candidate} (${describe(cause)})`,
        { cause },
      );
    }
  }

  throw new ImagineError(
    "unknown",
    `No free filename for ${filename} in ${dir} after ${MAX_COLLISION_ATTEMPTS} attempts.`,
  );
}

async function appendManifest(
  manifestPath: string,
  record: ManifestRecord,
): Promise<void> {
  await ensureDirectory(path.dirname(manifestPath), "the manifest path");
  try {
    await appendFile(manifestPath, `${JSON.stringify(record)}\n`, "utf8");
  } catch (cause) {
    throw new ImagineError(
      "unknown",
      `The image was written to ${record.path}, but appending to the manifest ` +
        `${manifestPath} failed (${describe(cause)})`,
      { cause },
    );
  }
}

/**
 * Stores `result.bytes` and appends one manifest line describing where they
 * went. Never overwrites. With no `sink` the bytes go to the local filesystem,
 * which is the whole of local mode and the pre-ADR-0024 behaviour.
 *
 * The manifest is written locally either way: it is a file, not an image, and
 * moving it is #45's job (ADR 0024).
 */
export async function writeImage(
  request: NormalisedRequest,
  result: NormalisedResult,
  config: OutputConfig,
  sink?: ObjectSink,
): Promise<WrittenImage> {
  const dirSource =
    request.output_dir === undefined ? "the configured output.dir" : "output_dir";
  const dir = resolvePath(request.output_dir ?? config.dir, dirSource);

  const filename = renderFilename(config.filename ?? DEFAULT_FILENAME_TEMPLATE, {
    slug: slugFromPrompt(request.prompt),
    hash: contentHash(result.bytes),
    ext: extensionFromMimeType(result.mime_type),
  });

  let written: StoredImage;
  if (sink === undefined) {
    await ensureDirectory(dir, dirSource);
    written = { path: await writeWithoutOverwriting(dir, filename, result.bytes) };
  } else {
    written = await sink.put(filename, result.bytes, result.mime_type);
  }

  const manifestPath =
    config.manifest === undefined
      ? path.join(dir, DEFAULT_MANIFEST_NAME)
      : resolvePath(config.manifest, "the configured output.manifest");

  await appendManifest(manifestPath, {
    path: written.path,
    ...(written.url === undefined ? {} : { url: written.url }),
    prompt: request.prompt,
    provider: result.provider,
    model: result.model,
    cost_usd: result.cost_usd,
    width: result.width,
    height: result.height,
    mime_type: result.mime_type,
    duration_ms: result.duration_ms,
    created_at: new Date().toISOString(),
  });

  return { ...written, manifest_path: manifestPath };
}
