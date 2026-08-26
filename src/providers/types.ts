import type {
  NormalisedRequest,
  NormalisedResult,
  ProviderModel,
} from "../core/types.js";

/**
 * The whole surface an adapter has to implement. Adding a provider means
 * writing this interface and registering it; nothing else in the codebase
 * changes.
 *
 * `generate` resolves with decoded bytes or throws an `ImagineError` — it never
 * returns base64 and never touches the filesystem.
 */
export interface ImageProvider {
  readonly id: string;
  /** Whether config and credentials for this provider are present and usable. */
  isConfigured(): boolean;
  /** Models this provider reports it can reach right now. */
  listModels(): Promise<ProviderModel[]>;
  generate(request: NormalisedRequest): Promise<NormalisedResult>;
}
