/**
 * The Azure OpenAI adapter: `gpt-image` inside a customer's own Azure resource.
 *
 * The one detail this whole file exists to get right: **the deployment name
 * lives in the URL path and never in the request body.** Putting it in the body
 * as `model` is the failure that broke LiteLLM repeatedly (research §2 and §5),
 * so `test/contract/azure-request.test.ts` asserts both halves of that.
 *
 * Deployment names are arbitrary and are not model ids, so the mapping comes
 * from `providers.azure.deployments` in config. See ADR 0014 for the choices
 * that were not obvious.
 */

import { ImagineError, type FailureReason } from "../core/errors.js";
import type {
  ImageSize,
  NormalisedRequest,
  NormalisedResult,
  ProviderModel,
} from "../core/types.js";
import { imageDimensions } from "./openrouter.js";
import type { ImageProvider, ResolvedModel } from "./types.js";

export const AZURE_ID = "azure";
export const AZURE_DEFAULT_API_VERSION = "2025-04-01-preview";
/** The scope an Entra token has to be issued for (research §2). */
export const AZURE_ENTRA_SCOPE = "https://ai.azure.com/.default";

const DEFAULT_GENERATE_TIMEOUT_MS = 120_000;

export type FetchLike = typeof globalThis.fetch;
export type AzureAuthMode = "api_key" | "entra";

/**
 * Supplies an Entra bearer token. Injected rather than acquired here: taking a
 * credential library as a dependency is a decision of its own (ADR 0014).
 */
export type AccessTokenProvider = () => Promise<string>;

export interface AzureProviderOptions {
  /** Mirrors `providers.azure.enabled`; a disabled adapter is unconfigured. */
  enabled?: boolean;
  /** Resource URL, e.g. `https://my-resource.openai.azure.com`. */
  endpoint?: string | null;
  apiVersion?: string;
  auth?: AzureAuthMode;
  /** Only read in `api_key` mode. */
  apiKey?: string | null;
  /** Curated model id → deployment name, from `providers.azure.deployments`. */
  deployments?: Readonly<Record<string, string>>;
  /** Only read in `entra` mode. */
  getAccessToken?: AccessTokenProvider;
  fetch?: FetchLike;
  generateTimeoutMs?: number;
  now?: () => number;
}

interface Deployment {
  /** The curated model id the deployment was found under. */
  model: string;
  /** The name that goes in the URL path. */
  name: string;
}

export class AzureProvider implements ImageProvider {
  readonly id = AZURE_ID;

  readonly #enabled: boolean;
  readonly #endpoint: string | null;
  readonly #apiVersion: string;
  readonly #auth: AzureAuthMode;
  readonly #apiKey: string | null;
  readonly #deployments: Readonly<Record<string, string>>;
  readonly #getAccessToken: AccessTokenProvider | undefined;
  readonly #fetch: FetchLike;
  readonly #generateTimeoutMs: number;
  readonly #now: () => number;

  constructor(options: AzureProviderOptions = {}) {
    this.#enabled = options.enabled ?? true;
    this.#endpoint =
      options.endpoint === undefined || options.endpoint === null
        ? null
        : stripTrailingSlash(options.endpoint);
    this.#apiVersion = options.apiVersion ?? AZURE_DEFAULT_API_VERSION;
    this.#auth = options.auth ?? "entra";
    this.#apiKey = options.apiKey ?? null;
    this.#deployments = { ...(options.deployments ?? {}) };
    this.#getAccessToken = options.getAccessToken;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#generateTimeoutMs = options.generateTimeoutMs ?? DEFAULT_GENERATE_TIMEOUT_MS;
    this.#now = options.now ?? Date.now;
  }

  isConfigured(): boolean {
    return (
      this.#enabled &&
      this.#endpoint !== null &&
      this.#endpoint.length > 0 &&
      this.#hasCredential() &&
      Object.keys(this.#deployments).length > 0
    );
  }

  /**
   * Azure exposes no listing of image deployments a caller could rely on
   * (research §2), so the configured mapping *is* the answer — no network call.
   */
  listModels(): Promise<ProviderModel[]> {
    return Promise.resolve(
      Object.entries(this.#deployments).map(([model, deployment]) => ({
        id: model,
        display_name: model,
        capabilities: {
          deployment,
          api_version: this.#apiVersion,
          source: "config",
          note: `Served by the Azure deployment "${deployment}", as configured in providers.${AZURE_ID}.deployments.`,
        },
      })),
    );
  }

  async generate(
    request: NormalisedRequest,
    resolved?: ResolvedModel,
  ): Promise<NormalisedResult> {
    const started = this.#now();
    const deployment = this.#resolveDeployment(resolved);

    const payload = await this.#send(
      deployment.name,
      JSON.stringify(buildGenerateBody(request)),
    );

    const bytes = decodeBase64(firstImage(payload));
    const dimensions = imageDimensions(bytes) ?? requestedDimensions(request.size);

    return {
      bytes,
      mime_type: sniffMimeType(bytes) ?? "image/png",
      provider: this.id,
      model: deployment.model,
      cost_usd: null,
      duration_ms: this.#now() - started,
      width: dimensions.width,
      height: dimensions.height,
    };
  }

  #hasCredential(): boolean {
    return this.#auth === "api_key"
      ? typeof this.#apiKey === "string" && this.#apiKey.length > 0
      : this.#getAccessToken !== undefined;
  }

  /**
   * Without a resolved model a single configured deployment is unambiguous and
   * serves as the default; none or several are not, and say so rather than
   * guessing which of the operator's deployments to spend money on.
   */
  #resolveDeployment(resolved: ResolvedModel | undefined): Deployment {
    const entries = Object.entries(this.#deployments);

    if (resolved !== undefined) {
      const name = this.#deployments[resolved.model_ref];
      if (name === undefined) {
        throw new ImagineError(
          "invalid_request",
          `No Azure deployment is configured for model "${resolved.model_ref}". Add providers.${AZURE_ID}.deployments["${resolved.model_ref}"] with the name of your deployment${describeKnown(entries)}.`,
        );
      }
      return { model: resolved.model_ref, name };
    }

    const only = entries[0];
    if (entries.length === 1 && only !== undefined) {
      return { model: only[0], name: only[1] };
    }

    throw new ImagineError(
      "invalid_request",
      entries.length === 0
        ? `No Azure deployments are configured. Add providers.${AZURE_ID}.deployments as a mapping of model id to deployment name, e.g. {"gpt-image-2": "my-gpt-image-2"}.`
        : `This call names no model and providers.${AZURE_ID}.deployments configures ${entries.length} of them (${entries.map(([model]) => model).join(", ")}), so there is no unambiguous default. Route through the router, or pass { model_ref } naming one of them.`,
    );
  }

  async #send(deployment: string, body: string): Promise<Record<string, unknown>> {
    if (!this.#enabled) {
      throw new ImagineError(
        "invalid_request",
        `Provider "${AZURE_ID}" is disabled. Set providers.${AZURE_ID}.enabled to true.`,
      );
    }

    const endpoint = this.#endpoint;
    if (endpoint === null || endpoint.length === 0) {
      throw new ImagineError(
        "invalid_request",
        `No Azure endpoint. Set providers.${AZURE_ID}.endpoint to your resource URL, e.g. https://my-resource.openai.azure.com.`,
      );
    }

    const headers = {
      ...(await this.#authHeader()),
      Accept: "application/json",
      "Content-Type": "application/json",
    };

    const url = `${endpoint}/openai/deployments/${encodeURIComponent(deployment)}/images/generations?api-version=${encodeURIComponent(this.#apiVersion)}`;

    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(this.#generateTimeoutMs),
      });
    } catch (cause) {
      throw transportError(cause);
    }

    const raw = await readBodyText(response);
    const parsed = parseJson(raw);

    if (!response.ok) throw httpError(response.status, parsed, raw, deployment);

    if (parsed === null) {
      throw new ImagineError(
        "unknown",
        `Azure OpenAI answered ${response.status} with a body that is not JSON: ${truncate(raw)}`,
      );
    }

    return parsed;
  }

  async #authHeader(): Promise<Record<string, string>> {
    if (this.#auth === "api_key") {
      const apiKey = this.#apiKey;
      if (apiKey === null || apiKey.length === 0) {
        throw new ImagineError(
          "auth_failed",
          `No Azure OpenAI key. Set AZURE_OPENAI_API_KEY (or whatever providers.${AZURE_ID}.api_key_env names), or switch providers.${AZURE_ID}.auth to "entra".`,
        );
      }
      return { "api-key": apiKey };
    }

    const getAccessToken = this.#getAccessToken;
    if (getAccessToken === undefined) {
      throw new ImagineError(
        "auth_failed",
        `providers.${AZURE_ID}.auth is "entra" but this adapter was constructed without a token provider, so there is no way to obtain a bearer token for ${AZURE_ENTRA_SCOPE}.`,
      );
    }

    const token = await getAccessToken().catch((cause: unknown) => {
      throw cause instanceof ImagineError
        ? cause
        : new ImagineError(
            "auth_failed",
            `Could not obtain an Entra token for ${AZURE_ENTRA_SCOPE}: ${describe(cause)}`,
            { cause },
          );
    });

    if (token.length === 0) {
      throw new ImagineError(
        "auth_failed",
        `The Entra token provider returned an empty token for ${AZURE_ENTRA_SCOPE}.`,
      );
    }

    return { Authorization: `Bearer ${token}` };
  }
}

/**
 * `model` is deliberately absent: the deployment is already in the URL, and
 * sending it here is the documented Azure failure mode. `response_format` is
 * absent because the gpt-image series does not support it and always answers
 * with base64 (research §2).
 */
function buildGenerateBody(request: NormalisedRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    prompt: promptWithStyle(request),
    n: 1,
  };
  const size = request.size;
  if (size !== undefined && size !== "auto") body["size"] = size;
  return body;
}

/** The images API has no style parameter, so style rides the prompt. */
function promptWithStyle(request: NormalisedRequest): string {
  const style = request.style?.trim();
  return style ? `${request.prompt}\n\nStyle: ${style}` : request.prompt;
}

function firstImage(payload: Record<string, unknown>): string {
  const data = payload["data"];
  const first = Array.isArray(data) ? asRecord(data[0]) : undefined;
  const b64 = first ? readString(first, "b64_json") : undefined;
  if (b64 === undefined) {
    throw new ImagineError(
      "unknown",
      "Azure OpenAI answered without an image: no data[0].b64_json in the response.",
    );
  }
  return b64;
}

function decodeBase64(b64: string): Uint8Array {
  const bytes = new Uint8Array(Buffer.from(b64, "base64"));
  if (bytes.length === 0) {
    throw new ImagineError(
      "unknown",
      "Azure OpenAI returned a b64_json field that decodes to no bytes.",
    );
  }
  return bytes;
}

interface ErrorMapping {
  reason: FailureReason;
  retryable: boolean;
}

/**
 * Status to failure reason, with `retryable` set to whether retrying the *same*
 * request could plausibly succeed. Azure differs from OpenRouter in two places:
 * 403 is authorisation (network rules, RBAC) rather than moderation, and 404 is
 * overwhelmingly a deployment name that does not exist on this resource.
 */
function mapStatus(status: number, filtered: boolean): ErrorMapping {
  if (filtered) return { reason: "content_filtered", retryable: false };
  if (status === 400) return { reason: "invalid_request", retryable: false };
  if (status === 401) return { reason: "auth_failed", retryable: false };
  if (status === 403) return { reason: "auth_failed", retryable: false };
  if (status === 404) return { reason: "provider_unavailable", retryable: false };
  if (status === 408) return { reason: "timeout", retryable: true };
  if (status === 422) return { reason: "invalid_request", retryable: false };
  if (status === 429) return { reason: "rate_limited", retryable: true };
  if (status === 504) return { reason: "timeout", retryable: true };
  if (status >= 500) return { reason: "provider_unavailable", retryable: true };
  return { reason: "unknown", retryable: false };
}

/** Azure's own vocabulary for a moderation refusal, prompt or output side. */
const CONTENT_FILTER_CODES: ReadonlySet<string> = new Set([
  "content_policy_violation",
  "content_filter",
  "contentfilter",
  "responsibleaipolicyviolation",
  "responsibleaipolicy",
  "responsibleprompt",
  "responsiblepromptfilter",
  "moderation_blocked",
]);

const CONTENT_FILTER_PATTERN =
  /content polic|content filter|content management polic|moderat|safety system|jailbreak|responsible ai/i;

function looksLikeContentFilter(codes: readonly string[], message: string): boolean {
  return (
    codes.some((code) => CONTENT_FILTER_CODES.has(code.toLowerCase())) ||
    CONTENT_FILTER_PATTERN.test(message)
  );
}

function httpError(
  status: number,
  parsed: unknown,
  raw: string,
  deployment: string,
): ImagineError {
  const error = asRecord(asRecord(parsed)?.["error"]);
  const inner = error ? asRecord(error["innererror"]) : undefined;
  const codes = [
    error ? readString(error, "code") : undefined,
    inner ? readString(inner, "code") : undefined,
    inner ? readString(inner, "content_filter_result_code") : undefined,
  ].filter((code): code is string => code !== undefined);

  const message =
    (error ? readString(error, "message") : undefined) ??
    (truncate(raw) || `HTTP ${status}`);
  const { reason, retryable } = mapStatus(
    status,
    looksLikeContentFilter(codes, message),
  );

  const hint =
    status === 404
      ? ` The usual cause is that deployment "${deployment}" does not exist on this resource — check providers.${AZURE_ID}.deployments and the deployment names in Azure AI Foundry.`
      : "";

  return new ImagineError(
    reason,
    `Azure OpenAI request failed with status ${status}: ${message}${hint}`,
    { retryable },
  );
}

function transportError(cause: unknown): ImagineError {
  const name = cause instanceof Error ? cause.name : "";
  if (name === "TimeoutError" || name === "AbortError") {
    return new ImagineError("timeout", "Azure OpenAI did not answer in time.", {
      cause,
      retryable: true,
    });
  }
  return new ImagineError(
    "provider_unavailable",
    `Could not reach Azure OpenAI: ${describe(cause)}`,
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
  { mime: "image/webp", bytes: [0x52, 0x49, 0x46, 0x46] },
];

function sniffMimeType(bytes: Uint8Array): string | undefined {
  return MIME_BY_SIGNATURE.find((candidate) =>
    candidate.bytes.every((byte, index) => bytes[index] === byte),
  )?.mime;
}

function describeKnown(entries: readonly (readonly [string, string])[]): string {
  if (entries.length === 0) return "";
  return ` (configured today: ${entries.map(([model]) => model).join(", ")})`;
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
