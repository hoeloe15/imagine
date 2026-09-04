import type { FailureReason } from "../core/errors.js";
import type {
  NormalisedRequest,
  NormalisedResult,
  ProviderModel,
} from "../core/types.js";

/**
 * What one free, side-effect-free check of a provider's credential found.
 *
 * `summary` is rendered on a page and written to disk, so it is derived from a
 * status code and a {@link FailureReason} — never from the provider's response
 * body, and never from the credential.
 */
export interface VerificationResult {
  ok: boolean;
  summary: string;
  /** Set when `ok` is false. */
  reason?: FailureReason;
}

/**
 * The model `core/router.ts` chose, in the adapter's own namespace. It arrives
 * as its own argument rather than inside the request, so an adapter can never
 * mistake `NormalisedRequest.provider_hint` — which stays exactly what the
 * caller asked for — for a resolved decision. See ADR 0013.
 */
export interface ResolvedModel {
  model_ref: string;
}

/**
 * The whole surface an adapter has to implement. Adding a provider means
 * writing this interface and registering it; nothing else in the codebase
 * changes.
 *
 * `generate` resolves with decoded bytes or throws an `ImagineError` — it never
 * returns base64 and never touches the filesystem. `resolved` is absent only
 * when an adapter is driven directly, outside the router; an adapter then falls
 * back to a default model of its own.
 */
export interface ImageProvider {
  readonly id: string;
  /** Whether config and credentials for this provider are present and usable. */
  isConfigured(): boolean;
  /** Models this provider reports it can reach right now. */
  listModels(): Promise<ProviderModel[]>;
  /**
   * Whether the configured credential actually works, without generating
   * anything. Optional: `core/verification.ts` falls back to `listModels()`,
   * which is the same free call for every adapter that has one.
   */
  verify?(): Promise<VerificationResult>;
  generate(
    request: NormalisedRequest,
    resolved?: ResolvedModel,
  ): Promise<NormalisedResult>;
}
