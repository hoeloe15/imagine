import type {
  NormalisedRequest,
  NormalisedResult,
  ProviderModel,
} from "../core/types.js";

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
  generate(
    request: NormalisedRequest,
    resolved?: ResolvedModel,
  ): Promise<NormalisedResult>;
}
