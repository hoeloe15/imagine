/**
 * The Azure adapter: image models inside a customer's own Azure resource.
 *
 * One resource, two wire dialects, and they disagree about the single most
 * error-prone detail in the whole file:
 *
 * - `openai` — `gpt-image` on Azure OpenAI. **The deployment name lives in the
 *   URL path and never in the request body.** Putting it in the body as `model`
 *   is the failure that broke LiteLLM repeatedly (research §2 and §5).
 * - `mai` — Microsoft's own MAI-Image models on Foundry. **The deployment name
 *   lives in the body as `model` and never in the URL path**, there is no
 *   `api-version`, and the size is a `width`/`height` pair inside a fixed pixel
 *   budget (`mai-image-2026-09.md` §1).
 *
 * The rule is per-API, not per-vendor, which is exactly why it is easy to lose.
 * `test/contract/azure-request.test.ts` pins both halves of both dialects as
 * mirror images of each other. See ADR 0014 and ADR 0027.
 *
 * Deployment names are arbitrary and are not model ids, so the mapping comes
 * from `providers.azure.deployments` in config.
 */

import { ImagineError, type FailureReason } from "../core/errors.js";
import {
  toApiKeySource,
  type ApiKeyOption,
  type ApiKeySource,
} from "../core/secrets.js";
import type {
  ImageSize,
  NormalisedRequest,
  NormalisedResult,
  ProviderModel,
} from "../core/types.js";
import { countOf, failureFrom } from "../core/verification.js";
import { imageDimensions } from "./openrouter.js";
import type { ImageProvider, ResolvedModel, VerificationResult } from "./types.js";

export const AZURE_ID = "azure";
export const AZURE_DEFAULT_API_VERSION = "2025-04-01-preview";
/** The scope an Entra token for Azure OpenAI has to be issued for (research §2). */
export const AZURE_ENTRA_SCOPE = "https://ai.azure.com/.default";
/**
 * The scope the MAI endpoint wants instead. Microsoft's own docs name it twice
 * — in the bearer-token example and in the 401 troubleshooting row — and a live
 * call on 2026-09-04 confirmed it (`mai-image-2026-09.md` §1.5).
 */
export const AZURE_MAI_ENTRA_SCOPE = "https://cognitiveservices.azure.com/.default";

/** The MAI host suffix. The `openai.azure.com` host answers 404 for this path. */
export const AZURE_MAI_HOST_SUFFIX = "services.ai.azure.com";
/** No `api-version`: the `v1` in the path is the version (`mai-image-2026-09.md` §1.1). */
export const AZURE_MAI_PATH = "/mai/v1/images/generations";

/** MAI takes free width/height integers inside a fixed budget, not a size string. */
export const MAI_MIN_SIDE = 768;
export const MAI_MAX_AREA = 1_048_576;

/**
 * The data-plane model listing on the Azure OpenAI host. It is free, it changes
 * nothing, and it is refused with the same 401/403 a generation would get — so
 * it is the closest thing this resource offers to "try the credential".
 */
export const AZURE_MODELS_PATH = "/openai/models";

const DEFAULT_GENERATE_TIMEOUT_MS = 120_000;
const DEFAULT_VERIFY_TIMEOUT_MS = 15_000;

export type FetchLike = typeof globalThis.fetch;
export type AzureAuthMode = "api_key" | "entra";

/**
 * Which wire shape a deployment speaks. `openai` is the Azure OpenAI images API;
 * `mai` is Microsoft's MAI-Image API on the Foundry host. See ADR 0027.
 */
export type AzureWireDialect = "openai" | "mai";

/**
 * How one entry in `providers.azure.deployments` may be written. A bare string
 * is the original form and still means "the openai dialect", so nothing that
 * worked before this seam existed has to change (ADR 0014, amended).
 */
export type AzureDeploymentConfig =
  | string
  | {
      deployment: string;
      dialect?: AzureWireDialect;
      /** Overrides the host derived from `endpoint` for this deployment only. */
      endpoint?: string;
    };

/**
 * Supplies an Entra bearer token for the scope it is asked for. Injected rather
 * than acquired here (ADR 0014); `managed-identity.ts` is the implementation the
 * composition root wires when the platform provides an identity (ADR 0022). The
 * scope is a parameter and not a constant because the two dialects want
 * different audiences (ADR 0027).
 */
export type AccessTokenProvider = (scope: string) => Promise<string>;

export interface AzureProviderOptions {
  /** Mirrors `providers.azure.enabled`; a disabled adapter is unconfigured. */
  enabled?: boolean;
  /** Resource URL, e.g. `https://my-resource.openai.azure.com`. */
  endpoint?: string | null;
  apiVersion?: string;
  auth?: AzureAuthMode;
  /**
   * Only read in `api_key` mode. A plain string still works; a source is read
   * at request time, so a rotated key is picked up without a restart (ADR 0026).
   */
  apiKey?: ApiKeyOption;
  /** Curated model id → deployment, from `providers.azure.deployments`. */
  deployments?: Readonly<Record<string, AzureDeploymentConfig>>;
  /** Only read in `entra` mode. */
  getAccessToken?: AccessTokenProvider;
  fetch?: FetchLike;
  generateTimeoutMs?: number;
  verifyTimeoutMs?: number;
  now?: () => number;
}

interface Deployment {
  /** The curated model id the deployment was found under. */
  model: string;
  /** The deployment name — in the URL path for `openai`, in the body for `mai`. */
  name: string;
  dialect: AzureWireDialect;
  /** Set only when the entry overrode the host. */
  endpoint: string | undefined;
}

/**
 * A bare string is the `openai` dialect, which is what every config written
 * before ADR 0027 says.
 */
function normaliseDeployment(model: string, value: AzureDeploymentConfig): Deployment {
  if (typeof value === "string") {
    return { model, name: value, dialect: "openai", endpoint: undefined };
  }
  return {
    model,
    name: value.deployment,
    dialect: value.dialect ?? "openai",
    endpoint:
      value.endpoint === undefined ? undefined : stripTrailingSlash(value.endpoint),
  };
}

export class AzureProvider implements ImageProvider {
  readonly id = AZURE_ID;

  readonly #enabled: boolean;
  readonly #endpoint: string | null;
  readonly #apiVersion: string;
  readonly #auth: AzureAuthMode;
  readonly #apiKey: ApiKeySource;
  readonly #deployments: Readonly<Record<string, Deployment>>;
  readonly #getAccessToken: AccessTokenProvider | undefined;
  readonly #fetch: FetchLike;
  readonly #generateTimeoutMs: number;
  readonly #verifyTimeoutMs: number;
  readonly #now: () => number;

  constructor(options: AzureProviderOptions = {}) {
    this.#enabled = options.enabled ?? true;
    this.#endpoint =
      options.endpoint === undefined || options.endpoint === null
        ? null
        : stripTrailingSlash(options.endpoint);
    this.#apiVersion = options.apiVersion ?? AZURE_DEFAULT_API_VERSION;
    this.#auth = options.auth ?? "entra";
    this.#apiKey = toApiKeySource(options.apiKey);
    this.#deployments = Object.fromEntries(
      Object.entries(options.deployments ?? {}).map(([model, value]) => [
        model,
        normaliseDeployment(model, value),
      ]),
    );
    this.#getAccessToken = options.getAccessToken;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#generateTimeoutMs = options.generateTimeoutMs ?? DEFAULT_GENERATE_TIMEOUT_MS;
    this.#verifyTimeoutMs = options.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;
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
      Object.values(this.#deployments).map((deployment) => ({
        id: deployment.model,
        display_name: deployment.model,
        capabilities: {
          deployment: deployment.name,
          dialect: deployment.dialect,
          ...(deployment.dialect === "mai" ? {} : { api_version: this.#apiVersion }),
          source: "config",
          note: `Served by the Azure deployment "${deployment.name}", as configured in providers.${AZURE_ID}.deployments.`,
        },
      })),
    );
  }

  /**
   * What can honestly be checked without generating anything.
   *
   * Azure publishes no listing of *image deployments*, so a green result here
   * is not proof that a given deployment will answer. What it does prove
   * depends on the mode, and the summary says which:
   *
   * - `api_key`: the resource accepted the key on a data-plane read. A 401 or
   *   403 is a real rejection; anything else means the check found nothing out.
   * - `entra`: the managed identity obtained a token for the scope a
   *   generation would use, and — where the resource offers the listing — that
   *   token was accepted by the resource. Where it does not, the summary says
   *   plainly that this proves the identity and not the deployment.
   */
  async verify(): Promise<VerificationResult> {
    try {
      return await this.#verify();
    } catch (cause) {
      return failureFrom(cause);
    }
  }

  async #verify(): Promise<VerificationResult> {
    if (!this.#enabled) {
      return {
        ok: false,
        reason: "invalid_request",
        summary: `disabled in providers.${AZURE_ID}.enabled`,
      };
    }

    const endpoint = this.#endpoint;
    if (endpoint === null || endpoint.length === 0) {
      return {
        ok: false,
        reason: "invalid_request",
        summary: `no providers.${AZURE_ID}.endpoint is configured`,
      };
    }

    const configured = countOf(Object.keys(this.#deployments).length, "deployment");
    const scope = entraScopeFor(this.#dialectToVerify());
    const headers = { ...(await this.#authHeader(scope)), Accept: "application/json" };

    // A token minted for the MAI audience is not one this host accepts, so
    // asking it would report a 401 that means the wrong thing.
    if (this.#auth === "entra" && scope === AZURE_MAI_ENTRA_SCOPE) {
      return {
        ok: true,
        summary: `the identity has a token for ${scope}; that proves the identity, not the deployment (${configured} configured)`,
      };
    }

    const url = `${endpoint}${AZURE_MODELS_PATH}?api-version=${encodeURIComponent(this.#apiVersion)}`;
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(this.#verifyTimeoutMs),
      });
    } catch (cause) {
      throw transportError(cause);
    }

    const raw = await readBodyText(response);
    const parsed = parseJson(raw);

    if (response.ok) {
      const data = parsed?.["data"];
      const models = Array.isArray(data) ? data.length : 0;
      return {
        ok: true,
        summary: `the resource accepted the credential — ${countOf(models, "model")} on it, ${configured} configured`,
      };
    }

    if (response.status === 401 || response.status === 403) {
      throw httpError(response.status, parsed, raw, "");
    }

    if (this.#auth === "entra") {
      return {
        ok: true,
        summary: `the identity has a token for ${scope}, but the resource offers no model listing (${response.status}), so this proves the identity, not the deployment`,
      };
    }

    return {
      ok: false,
      reason: "unknown",
      summary: `nothing could be proven: the resource answered ${response.status} to a model listing, which neither accepts nor refuses the key`,
    };
  }

  /**
   * Which wire dialect's audience to check. An `openai` deployment is checkable
   * against the resource itself; a resource that only serves MAI is not, so its
   * own audience is the one worth proving a token for.
   */
  #dialectToVerify(): AzureWireDialect {
    const dialects = Object.values(this.#deployments).map(
      (deployment) => deployment.dialect,
    );
    return dialects.length > 0 && dialects.every((dialect) => dialect === "mai")
      ? "mai"
      : "openai";
  }

  async generate(
    request: NormalisedRequest,
    resolved?: ResolvedModel,
  ): Promise<NormalisedResult> {
    const started = this.#now();
    const deployment = this.#resolveDeployment(resolved);

    const payload = await this.#send(
      deployment,
      JSON.stringify(
        deployment.dialect === "mai"
          ? buildMaiGenerateBody(request, deployment.name)
          : buildGenerateBody(request),
      ),
    );

    const bytes = decodeBase64(firstImage(payload));
    /**
     * The header is the truth: MAI is asked for a clamped size and gpt-image for
     * a named one, and neither promises to honour it exactly.
     */
    const dimensions =
      imageDimensions(bytes) ??
      (deployment.dialect === "mai"
        ? maiDimensions(request.size)
        : requestedDimensions(request.size));

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

  /** A source, not a value: see the note on `isConfigured` in ADR 0026. */
  #hasCredential(): boolean {
    return this.#auth === "api_key"
      ? this.#apiKey.has()
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
      const deployment = this.#deployments[resolved.model_ref];
      if (deployment === undefined) {
        throw new ImagineError(
          "invalid_request",
          `No Azure deployment is configured for model "${resolved.model_ref}". Add providers.${AZURE_ID}.deployments["${resolved.model_ref}"] with the name of your deployment${describeKnown(entries)}.`,
        );
      }
      return deployment;
    }

    const only = entries[0];
    if (entries.length === 1 && only !== undefined) {
      return only[1];
    }

    throw new ImagineError(
      "invalid_request",
      entries.length === 0
        ? `No Azure deployments are configured. Add providers.${AZURE_ID}.deployments as a mapping of model id to deployment name, e.g. {"gpt-image-2": "my-gpt-image-2"}.`
        : `This call names no model and providers.${AZURE_ID}.deployments configures ${entries.length} of them (${entries.map(([model]) => model).join(", ")}), so there is no unambiguous default. Route through the router, or pass { model_ref } naming one of them.`,
    );
  }

  async #send(deployment: Deployment, body: string): Promise<Record<string, unknown>> {
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
      ...(await this.#authHeader(entraScopeFor(deployment.dialect))),
      Accept: "application/json",
      "Content-Type": "application/json",
    };

    const url =
      deployment.dialect === "mai"
        ? `${maiHost(deployment, endpoint)}${AZURE_MAI_PATH}`
        : `${deployment.endpoint ?? endpoint}/openai/deployments/${encodeURIComponent(deployment.name)}/images/generations?api-version=${encodeURIComponent(this.#apiVersion)}`;

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

    if (!response.ok) throw httpError(response.status, parsed, raw, deployment.name);

    if (parsed === null) {
      throw new ImagineError(
        "unknown",
        `Azure OpenAI answered ${response.status} with a body that is not JSON: ${truncate(raw)}`,
      );
    }

    return parsed;
  }

  async #authHeader(scope: string): Promise<Record<string, string>> {
    if (this.#auth === "api_key") {
      const apiKey = await this.#apiKey.get();
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
        `providers.${AZURE_ID}.auth is "entra" but this adapter was constructed without a token provider, so there is no way to obtain a bearer token for ${scope}.`,
      );
    }

    const token = await getAccessToken(scope).catch((cause: unknown) => {
      throw cause instanceof ImagineError
        ? cause
        : new ImagineError(
            "auth_failed",
            `Could not obtain an Entra token for ${scope}: ${describe(cause)}`,
            { cause },
          );
    });

    if (token.length === 0) {
      throw new ImagineError(
        "auth_failed",
        `The Entra token provider returned an empty token for ${scope}.`,
      );
    }

    return { Authorization: `Bearer ${token}` };
  }
}

/** Which Entra audience the dialect's endpoint accepts (`mai-image-2026-09.md` §1.5). */
export function entraScopeFor(dialect: AzureWireDialect): string {
  return dialect === "mai" ? AZURE_MAI_ENTRA_SCOPE : AZURE_ENTRA_SCOPE;
}

/**
 * MAI lives on a different host of the same resource. Rather than make every
 * operator configure a second endpoint, the resource name is taken from the one
 * they already configured and the suffix is swapped — `my-resource.openai.azure.com`
 * becomes `my-resource.services.ai.azure.com`. An explicit `endpoint` on the
 * deployment entry wins, for the resource whose host does not follow the pattern.
 */
export function maiHost(deployment: Deployment, fallback: string): string {
  if (deployment.endpoint !== undefined) return deployment.endpoint;
  return maiHostFor(fallback);
}

export function maiHostFor(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return endpoint;
  }
  if (url.hostname.endsWith(AZURE_MAI_HOST_SUFFIX))
    return stripTrailingSlash(url.origin);
  const resource = url.hostname.split(".")[0] ?? url.hostname;
  url.hostname = `${resource}.${AZURE_MAI_HOST_SUFFIX}`;
  return stripTrailingSlash(url.origin);
}

/**
 * The mirror image of `buildGenerateBody`: here `model` is *required* and is the
 * deployment name, there is no `n` and no `size`, and the dimensions are
 * integers inside the pixel budget (`mai-image-2026-09.md` §1.2).
 */
function buildMaiGenerateBody(
  request: NormalisedRequest,
  deployment: string,
): Record<string, unknown> {
  const { width, height } = maiDimensions(request.size);
  return {
    model: deployment,
    prompt: promptWithStyle(request),
    width,
    height,
  };
}

/**
 * `ImageSize` to a legal MAI width/height. The budget is `width × height ≤
 * 1,048,576` with each side ≥ 768, so `1024x1024` fits exactly and the
 * landscape and portrait sizes do not: `1536x1024` is 1,572,864 pixels and has
 * to shrink. Shrinking keeps the aspect ratio and lands on a multiple of eight,
 * which is what the endpoint returns for these shapes anyway; `auto` and an
 * absent size mean the square.
 */
export function maiDimensions(size: ImageSize | undefined): {
  width: number;
  height: number;
} {
  const requested = requestedDimensions(size);
  return clampToMaiBudget(
    requested.width > 0 ? requested.width : 1024,
    requested.height > 0 ? requested.height : 1024,
  );
}

function clampToMaiBudget(
  requestedWidth: number,
  requestedHeight: number,
): { width: number; height: number } {
  let width = requestedWidth;
  let height = requestedHeight;

  const area = width * height;
  if (area > MAI_MAX_AREA) {
    const scale = Math.sqrt(MAI_MAX_AREA / area);
    width = Math.max(MAI_MIN_SIDE, floorToEight(width * scale));
    height = Math.max(MAI_MIN_SIDE, floorToEight(height * scale));
  }

  /** The floor wins over the aspect ratio: below it the request is simply illegal. */
  width = Math.max(MAI_MIN_SIDE, width);
  height = Math.max(MAI_MIN_SIDE, height);

  /** Raising a side can push the area back over the cap. Trim the longer one. */
  if (width * height > MAI_MAX_AREA) {
    if (width >= height) width = floorToEight(MAI_MAX_AREA / height);
    else height = floorToEight(MAI_MAX_AREA / width);
  }

  return { width, height };
}

function floorToEight(value: number): number {
  return Math.floor(value / 8) * 8;
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
    { retryable, status },
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

function describeKnown(entries: readonly (readonly [string, Deployment])[]): string {
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
