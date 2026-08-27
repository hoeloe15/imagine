import type {
  NormalisedRequest,
  NormalisedResult,
  ProviderModel,
} from "../core/types.js";
import type { ImageProvider, ResolvedModel } from "./types.js";

const ONE_PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const STUB_MODEL: ProviderModel = {
  id: "stub-image-1",
  display_name: "Stub Image 1",
  capabilities: { sizes: ["1024x1024"], max_size: "1024x1024" },
};

/**
 * A provider that generates nothing, costs nothing and touches no network.
 * It exists so the router, the output writer and the MCP tools can be tested
 * end to end, and so the seam types have at least one implementation proving
 * they are implementable.
 */
export class StubProvider implements ImageProvider {
  readonly id: string;

  constructor(id = "stub") {
    this.id = id;
  }

  isConfigured(): boolean {
    return true;
  }

  listModels(): Promise<ProviderModel[]> {
    return Promise.resolve([STUB_MODEL]);
  }

  generate(
    request: NormalisedRequest,
    resolved?: ResolvedModel,
  ): Promise<NormalisedResult> {
    const started = Date.now();
    const bytes = new Uint8Array(Buffer.from(ONE_PIXEL_PNG_BASE64, "base64"));

    return Promise.resolve({
      bytes,
      mime_type: "image/png",
      provider: this.id,
      model: resolved?.model_ref ?? STUB_MODEL.id,
      cost_usd: 0,
      duration_ms: Date.now() - started,
      width: 1,
      height: 1,
    });
  }
}
