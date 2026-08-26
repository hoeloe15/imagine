/**
 * The normalised shapes that flow between the MCP layer, the core router and
 * the provider adapters. Nothing here may name a concrete provider: the MCP
 * layer speaks these types, every adapter speaks these types, and the core
 * router is the only thing that knows how to get from one to the other.
 *
 * Field names deliberately mirror the public tool API in `PLAN.md` §5, so a
 * value can travel from a tool argument to an adapter without being renamed.
 */

/** Use-case tags a caller can ask for; the input to model selection. */
export const USE_CASES = [
  "text_in_image",
  "photoreal",
  "illustration",
  "diagram",
  "fast_bulk",
] as const;

export type UseCase = (typeof USE_CASES)[number];

/**
 * A requested output size. Providers disagree on how size is expressed (pixel
 * dimensions, aspect ratio plus resolution), so this is what the *caller* may
 * ask for; each adapter maps it onto its own API and reports back the size it
 * actually produced in {@link NormalisedResult}.
 */
export type ImageSize = "1024x1024" | "1536x1024" | "1024x1536" | "auto";

/** One image generation request, provider-agnostic. */
export interface NormalisedRequest {
  /** The image description, passed to the provider mostly untouched. */
  prompt: string;
  /** Defaults to the configured default size when omitted. */
  size?: ImageSize;
  /**
   * Free-text style nudge, e.g. `"flat vector illustration"`. Appended to the
   * prompt by adapters whose API has no style parameter of its own.
   */
  style?: string;
  /** Drives model selection when no `provider_hint` is given. */
  use_case?: UseCase;
  /**
   * A hint, never a contract: a provider id or a full model id. The router
   * falls back when it cannot be honoured, and says so in the result it
   * builds for the client.
   */
  provider_hint?: string;
  /** Where to write the image. Overrides the configured output directory. */
  output_dir?: string;
}

/**
 * One generated image as it leaves an adapter: raw bytes plus what the
 * provider reported about them.
 *
 * The bytes are **decoded image data** — not base64, not a file path. Adapters
 * decode whatever their API returns; `core/output.ts` is the only place that
 * turns bytes into a file. See ADR 0003.
 */
export interface NormalisedResult {
  bytes: Uint8Array;
  /** As reported by the provider, e.g. `"image/png"`. */
  mime_type: string;
  /** Id of the adapter that produced this image. */
  provider: string;
  /** Model reference as the provider names it. */
  model: string;
  /** Provider-reported cost. `null` when the provider reports none. */
  cost_usd: number | null;
  duration_ms: number;
  /** The size actually produced, which may differ from the size requested. */
  width: number;
  height: number;
}

/**
 * A model as an adapter discovers it from its own API — not the curated
 * editorial knowledge in `data/models.json`, which is a separate source.
 */
export interface ProviderModel {
  /** Model reference in this provider's namespace. */
  id: string;
  display_name: string;
  /**
   * Capabilities exactly as the provider reports them. The router does not
   * interpret this; it exists so `list_capabilities` can surface what a
   * provider says about itself without every adapter inventing a schema.
   */
  capabilities: Readonly<Record<string, unknown>>;
}
