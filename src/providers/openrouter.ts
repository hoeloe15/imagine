/**
 * The OpenRouter adapter: the zero-config default provider.
 *
 * OpenRouter's dedicated Image API answers with base64, so this file decodes;
 * it answers with `usage.cost`, so this file reports an authoritative cost
 * rather than an estimate. See `docs/research/providers-2026-08.md` §1 and
 * ADR 0009 for the choices that were not obvious.
 */

import { ImagineError, type FailureReason } from "../core/errors.js";
import type {
  ImageSize,
  NormalisedRequest,
  NormalisedResult,
  ProviderModel,
} from "../core/types.js";
import type { ImageProvider } from "./types.js";

export const OPENROUTER_ID = "openrouter";
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const OPENROUTER_DEFAULT_MODEL = "google/gemini-3.1-flash-image";

const IMAGES_PATH = "/images";
const IMAGE_MODELS_PATH = "/images/models";
const MODELS_FALLBACK_PATH = "/models?output_modalities=image";

/** Sent so generations are attributable on the OpenRouter dashboard. */
const ATTRIBUTION_URL = "https://github.com/hoeloe15/imagine";
const ATTRIBUTION_TITLE = "imagine";

const DEFAULT_GENERATE_TIMEOUT_MS = 120_000;
const DEFAULT_LIST_MODELS_TIMEOUT_MS = 15_000;

export type FetchLike = typeof globalThis.fetch;

export interface OpenRouterProviderOptions {
  /** `null` or absent means "not configured"; nothing is sent without it. */
  apiKey?: string | null;
  /** Used when the request carries no full model id of its own. */
  model?: string;
  baseUrl?: string;
  fetch?: FetchLike;
  generateTimeoutMs?: number;
  listModelsTimeoutMs?: number;
  now?: () => number;
}

export class OpenRouterProvider implements ImageProvider {
  readonly id = OPENROUTER_ID;

  readonly #apiKey: string | null;
  readonly #defaultModel: string;
  readonly #baseUrl: string;
  readonly #fetch: FetchLike;
  readonly #generateTimeoutMs: number;
  readonly #listModelsTimeoutMs: number;
  readonly #now: () => number;

  constructor(options: OpenRouterProviderOptions = {}) {
    this.#apiKey = options.apiKey ?? null;
    this.#defaultModel = options.model ?? OPENROUTER_DEFAULT_MODEL;
    this.#baseUrl = stripTrailingSlash(options.baseUrl ?? OPENROUTER_BASE_URL);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#generateTimeoutMs = options.generateTimeoutMs ?? DEFAULT_GENERATE_TIMEOUT_MS;
    this.#listModelsTimeoutMs =
      options.listModelsTimeoutMs ?? DEFAULT_LIST_MODELS_TIMEOUT_MS;
    this.#now = options.now ?? Date.now;
  }

  isConfigured(): boolean {
    return typeof this.#apiKey === "string" && this.#apiKey.length > 0;
  }

  async listModels(): Promise<ProviderModel[]> {
    try {
      return await this.#discoverModels(IMAGE_MODELS_PATH);
    } catch (cause) {
      if (isImagineError(cause) && cause.reason === "auth_failed") throw cause;
      return await this.#discoverModels(MODELS_FALLBACK_PATH);
    }
  }

  async generate(request: NormalisedRequest): Promise<NormalisedResult> {
    const started = this.#now();
    const model = this.#modelFor(request);
    const body = buildGenerateBody(model, request);

    const payload = await this.#send(IMAGES_PATH, {
      method: "POST",
      body: JSON.stringify(body),
      timeoutMs: this.#generateTimeoutMs,
    });

    const cost = readCost(payload);
    const image = firstImage(payload, cost);
    const bytes = decodeBase64(image.b64, cost);
    const mimeType = image.mediaType ?? sniffMimeType(bytes) ?? "image/png";
    const dimensions =
      image.dimensions ?? imageDimensions(bytes) ?? requestedDimensions(request.size);

    return {
      bytes,
      mime_type: mimeType,
      provider: this.id,
      model: readString(payload, "model") ?? model,
      cost_usd: cost,
      duration_ms: this.#now() - started,
      width: dimensions.width,
      height: dimensions.height,
    };
  }

  /**
   * A `provider_hint` naming a full model id (`vendor/model`) is honoured;
   * a hint naming this adapter itself is not a model and falls through.
   */
  #modelFor(request: NormalisedRequest): string {
    const hint = request.provider_hint;
    if (hint && hint.includes("/")) return hint;
    return this.#defaultModel;
  }

  async #discoverModels(path: string): Promise<ProviderModel[]> {
    const payload = await this.#send(path, {
      method: "GET",
      timeoutMs: this.#listModelsTimeoutMs,
    });
    return toProviderModels(payload);
  }

  async #send(
    path: string,
    options: { method: "GET" | "POST"; body?: string; timeoutMs: number },
  ): Promise<Record<string, unknown>> {
    const apiKey = this.#apiKey;
    if (apiKey === null || apiKey.length === 0) {
      throw new ImagineError(
        "auth_failed",
        `No OpenRouter API key. Set OPENROUTER_API_KEY (or whatever providers.${OPENROUTER_ID}.api_key_env names) before calling ${OPENROUTER_ID}.`,
      );
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      "HTTP-Referer": ATTRIBUTION_URL,
      "X-Title": ATTRIBUTION_TITLE,
    };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";

    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method: options.method,
        headers,
        ...(options.body === undefined ? {} : { body: options.body }),
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch (cause) {
      throw transportError(cause);
    }

    const raw = await readBodyText(response);
    const parsed = parseJson(raw);

    if (!response.ok) {
      throw httpError(response.status, parsed, raw);
    }

    if (parsed === null) {
      throw new ImagineError(
        "unknown",
        `OpenRouter answered ${response.status} with a body that is not JSON: ${truncate(raw)}`,
      );
    }

    /**
     * OpenRouter can report a failure inside a 200 body; its `error.code`
     * carries the status the call would otherwise have had.
     */
    const embedded = asRecord(parsed["error"]);
    if (embedded) {
      throw httpError(readNumber(embedded, "code") ?? response.status, parsed, raw);
    }

    return parsed;
  }
}

function buildGenerateBody(
  model: string,
  request: NormalisedRequest,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    prompt: promptWithStyle(request),
  };
  const size = request.size;
  if (size !== undefined && size !== "auto") body["size"] = size;
  return body;
}

/** OpenRouter's image body has no style parameter, so style rides the prompt. */
function promptWithStyle(request: NormalisedRequest): string {
  const style = request.style?.trim();
  return style ? `${request.prompt}\n\nStyle: ${style}` : request.prompt;
}

function toProviderModels(payload: Record<string, unknown>): ProviderModel[] {
  const data = payload["data"];
  if (!Array.isArray(data)) {
    throw new ImagineError(
      "unknown",
      "OpenRouter model discovery answered without a data array.",
    );
  }

  return data.flatMap((entry) => {
    const record = asRecord(entry);
    const id = record ? readString(record, "id") : undefined;
    if (!record || id === undefined) return [];

    const capabilities = { ...record };
    delete capabilities["id"];
    delete capabilities["name"];

    return [
      {
        id,
        display_name: readString(record, "name") ?? id,
        capabilities,
      },
    ];
  });
}

interface DecodedImage {
  b64: string;
  mediaType: string | undefined;
  dimensions: { width: number; height: number } | undefined;
}

function firstImage(
  payload: Record<string, unknown>,
  cost: number | null,
): DecodedImage {
  const data = payload["data"];
  const first = Array.isArray(data) ? asRecord(data[0]) : undefined;
  const b64 = first ? readString(first, "b64_json") : undefined;
  if (!first || b64 === undefined || b64.length === 0) {
    throw new ImagineError(
      "unknown",
      "OpenRouter answered without an image: no data[0].b64_json in the response.",
      { billed: billedFor(cost) },
    );
  }

  const width = readNumber(first, "width");
  const height = readNumber(first, "height");

  return {
    b64,
    mediaType: readString(first, "media_type") ?? readString(first, "mime_type"),
    dimensions:
      width !== undefined && height !== undefined ? { width, height } : undefined,
  };
}

function decodeBase64(b64: string, cost: number | null): Uint8Array {
  const bytes = new Uint8Array(Buffer.from(b64, "base64"));
  if (bytes.length === 0) {
    throw new ImagineError(
      "unknown",
      "OpenRouter returned a b64_json field that decodes to no bytes.",
      { billed: billedFor(cost) },
    );
  }
  return bytes;
}

function readCost(payload: Record<string, unknown>): number | null {
  const usage = asRecord(payload["usage"]);
  if (!usage) return null;
  return readNumber(usage, "cost") ?? null;
}

/** A failed call that still reported a positive cost is the only billed failure. */
function billedFor(cost: number | null): boolean {
  return cost !== null && cost > 0;
}

interface ErrorMapping {
  reason: FailureReason;
  retryable: boolean;
}

/**
 * HTTP status to failure reason. Nothing here is ever `billed`: OpenRouter does
 * not charge for a generation that failed (research §1).
 */
function mapStatus(status: number, message: string): ErrorMapping {
  if (status === 400) {
    return looksLikeContentFilter(message)
      ? { reason: "content_filtered", retryable: false }
      : { reason: "invalid_request", retryable: false };
  }
  if (status === 401) return { reason: "auth_failed", retryable: false };
  /** 402 is "top up your credits": a retry cannot help and no key change will. */
  if (status === 402) return { reason: "auth_failed", retryable: false };
  /** OpenRouter uses 403 for moderation-flagged input, not for authorisation. */
  if (status === 403) return { reason: "content_filtered", retryable: false };
  if (status === 404) return { reason: "provider_unavailable", retryable: false };
  if (status === 408) return { reason: "timeout", retryable: true };
  if (status === 422) return { reason: "invalid_request", retryable: false };
  if (status === 429) return { reason: "rate_limited", retryable: true };
  if (status === 504) return { reason: "timeout", retryable: true };
  if (status >= 500) return { reason: "provider_unavailable", retryable: true };
  return { reason: "unknown", retryable: false };
}

const CONTENT_FILTER_PATTERN =
  /content polic|moderat|safety|safety system|nsfw|flagged|prohibited|violat/i;

function looksLikeContentFilter(message: string): boolean {
  return CONTENT_FILTER_PATTERN.test(message);
}

function httpError(status: number, parsed: unknown, raw: string): ImagineError {
  const message = errorMessage(parsed) || truncate(raw) || `HTTP ${status}`;
  const { reason, retryable } = mapStatus(status, message);
  return new ImagineError(
    reason,
    `OpenRouter request failed with status ${status}: ${message}`,
    { retryable },
  );
}

function errorMessage(parsed: unknown): string | undefined {
  const record = asRecord(parsed);
  if (!record) return undefined;

  const error = asRecord(record["error"]);
  if (error) {
    const message = readString(error, "message");
    const metadata = asRecord(error["metadata"]);
    const reasons = metadata ? metadata["reasons"] : undefined;
    const detail = Array.isArray(reasons) ? ` (${reasons.join(", ")})` : "";
    if (message !== undefined) return `${message}${detail}`;
  }

  return readString(record, "message");
}

function transportError(cause: unknown): ImagineError {
  const name = cause instanceof Error ? cause.name : "";
  if (name === "TimeoutError" || name === "AbortError") {
    return new ImagineError("timeout", "OpenRouter did not answer in time.", {
      cause,
      retryable: true,
    });
  }
  return new ImagineError(
    "provider_unavailable",
    `Could not reach OpenRouter: ${describe(cause)}`,
    { cause, retryable: true },
  );
}

async function readBodyText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function parseJson(raw: string): Record<string, unknown> | null {
  if (raw.length === 0) return null;
  try {
    return asRecord(JSON.parse(raw)) ?? null;
  } catch {
    return null;
  }
}

function requestedDimensions(size: ImageSize | undefined): {
  width: number;
  height: number;
} {
  const match = size === undefined ? null : /^(\d+)x(\d+)$/.exec(size);
  if (!match) return { width: 0, height: 0 };
  return { width: Number(match[1]), height: Number(match[2]) };
}

const MIME_BY_SIGNATURE: ReadonlyArray<{ mime: string; bytes: readonly number[] }> = [
  { mime: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47] },
  { mime: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  { mime: "image/gif", bytes: [0x47, 0x49, 0x46, 0x38] },
  { mime: "image/webp", bytes: [0x52, 0x49, 0x46, 0x46] },
];

function sniffMimeType(bytes: Uint8Array): string | undefined {
  return MIME_BY_SIGNATURE.find((candidate) =>
    candidate.bytes.every((byte, index) => bytes[index] === byte),
  )?.mime;
}

/**
 * The API reports no dimensions, and the router promises the size actually
 * produced — so the pixel size is read out of the image header itself.
 */
export function imageDimensions(
  bytes: Uint8Array,
): { width: number; height: number } | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  switch (sniffMimeType(bytes)) {
    case "image/png":
      return bytes.length >= 24
        ? { width: view.getUint32(16), height: view.getUint32(20) }
        : undefined;
    case "image/gif":
      return bytes.length >= 10
        ? { width: view.getUint16(6, true), height: view.getUint16(8, true) }
        : undefined;
    case "image/jpeg":
      return jpegDimensions(bytes, view);
    case "image/webp":
      return webpDimensions(bytes, view);
    default:
      return undefined;
  }
}

function jpegDimensions(
  bytes: Uint8Array,
  view: DataView,
): { width: number; height: number } | undefined {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1] ?? 0;
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (isStartOfFrame(marker)) {
      return { width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) };
    }
    const length = view.getUint16(offset + 2);
    if (length < 2) return undefined;
    offset += 2 + length;
  }
  return undefined;
}

function isStartOfFrame(marker: number): boolean {
  return (
    marker >= 0xc0 &&
    marker <= 0xcf &&
    marker !== 0xc4 &&
    marker !== 0xc8 &&
    marker !== 0xcc
  );
}

function webpDimensions(
  bytes: Uint8Array,
  view: DataView,
): { width: number; height: number } | undefined {
  const chunk = String.fromCharCode(...bytes.slice(12, 16));
  if (chunk === "VP8 " && bytes.length >= 30) {
    return {
      width: view.getUint16(26, true) & 0x3fff,
      height: view.getUint16(28, true) & 0x3fff,
    };
  }
  if (chunk === "VP8L" && bytes.length >= 25) {
    const bits = view.getUint32(21, true);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X" && bytes.length >= 30) {
    return {
      width: readUint24(bytes, 24) + 1,
      height: readUint24(bytes, 27) + 1,
    };
  }
  return undefined;
}

function readUint24(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) |
    ((bytes[offset + 1] ?? 0) << 8) |
    ((bytes[offset + 2] ?? 0) << 16)
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isImagineError(value: unknown): value is ImagineError {
  return value instanceof ImagineError;
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function truncate(raw: string, limit = 300): string {
  const trimmed = raw.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
