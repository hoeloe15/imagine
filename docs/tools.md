# The three tools

Full argument tables and response envelopes for the tools `imagine` exposes over
MCP. For a one-paragraph tour, see the [README](../README.md).

## `generate_image`

Generates one image, writes it to disk and returns the path plus what it cost.
The bytes never travel back to the client
([why](adr/0010-mcp-server-and-the-generate-image-tool.md)).

| Argument        | Type                                                        | Required |
| --------------- | ----------------------------------------------------------- | -------- |
| `prompt`        | string                                                      | yes      |
| `size`          | `1024x1024` \| `1536x1024` \| `1024x1536` \| `auto`         | no       |
| `style`         | string, e.g. `"flat vector illustration"`                   | no       |
| `use_case`      | `text_in_image` \| `photoreal` \| `illustration` \| `diagram` \| `fast_bulk` | no |
| `provider_hint` | string — a provider id or a full model id                   | no       |
| `output_dir`    | string — overrides `output.dir` for this call               | no       |

`provider_hint` is a hint, never a contract. When it cannot be honoured the
router picks anyway and says so in `selection_reason`
([ADR 0007](adr/0007-router-selection-and-fallback.md)).

```json
{
  "prompt": "A flat vector illustration of a lighthouse at dusk",
  "use_case": "illustration",
  "size": "1536x1024"
}
```

```json
{
  "path": "/Users/you/Pictures/imagine/a-flat-vector-illustration-of-a-lighthouse-at-dusk-7f3ac91d.png",
  "provider": "openrouter",
  "model": "google/gemini-3.1-flash-image",
  "cost_usd": 0.039,
  "duration_ms": 4180,
  "width": 1536,
  "height": 1024,
  "selection_reason": "use_case=illustration; highest-scoring available model for illustration at the lowest price",
  "budget": {
    "session_spent_usd": 0.039,
    "session_limit_usd": 5
  }
}
```

A failure comes back as a tool result rather than a protocol error, so the
calling model can read it and act:

```json
{
  "error": "auth_failed",
  "message": "Environment variable OPENROUTER_API_KEY is not set, and providers.openrouter.api_key_env names it as the source of the openrouter key. Set it in your environment or in a .env file next to your config.",
  "provider": null,
  "model": null,
  "cost_usd": 0,
  "retryable": false,
  "suggestion": "Check that the environment variable naming this provider's key is set and holds a valid key, or name another provider with provider_hint."
}
```

`error` is one of `auth_failed`, `budget_exceeded`, `content_filtered`,
`invalid_request`, `provider_unavailable`, `rate_limited`, `timeout`, `unknown`.

## `list_capabilities`

Takes no arguments. Reports what this installation can do right now: which
providers are ready and which are waiting on an environment variable, which
models are reachable through them, what has been spent, and how fresh the curated
data is. Read-only, costs nothing, and never returns a key
([ADR 0011](adr/0011-what-list-capabilities-reports.md)).

```json
{
  "configured_providers": [
    {
      "id": "openrouter",
      "status": "ready",
      "models": ["openai/gpt-image-2", "google/gemini-3.1-flash-image", "..."],
      "models_source": "live"
    },
    {
      "id": "azure",
      "status": "not_configured",
      "models": ["gpt-image-2"],
      "models_source": "curated",
      "note": "Disabled in configuration."
    }
  ],
  "default_model": "gemini-3.1-flash-image",
  "use_cases": [
    "text_in_image",
    "photoreal",
    "illustration",
    "diagram",
    "fast_bulk"
  ],
  "models": [
    {
      "id": "gpt-image-2",
      "display_name": "GPT Image 2",
      "available": true,
      "provider": "openrouter",
      "model_ref": "openai/gpt-image-2",
      "per_image_usd": 0.19,
      "max_size": "1536x1024"
    }
  ],
  "budget": {
    "session_spent_usd": 0.039,
    "session_limit_usd": 5,
    "day_spent_usd": 0.039,
    "day_limit_usd": 10,
    "day": "2026-08-26",
    "day_resets_at": "2026-08-26T22:00:00.000Z",
    "on_exceed": "refuse"
  },
  "knowledge_updated": "2026-08-26",
  "disclaimer": "Scores are editorial judgements informed by public leaderboards and hands-on testing, not measurements. …"
}
```

_(Provider and model lists abridged; a real answer lists all four curated models
and every provider the config names.)_ A `not_configured` provider whose key
variable is simply unset reports it under `missing`, by name — never by value.

## `recommend_model`

Advice before spending money. Spends nothing, calls no provider, touches the
ledger not at all. Both arguments are optional.

| Argument      | Type                                                                        |
| ------------- | --------------------------------------------------------------------------- |
| `use_case`    | `text_in_image` \| `photoreal` \| `illustration` \| `diagram` \| `fast_bulk` |
| `budget_hint` | free text, e.g. `"20 images for a deck"`, `"under $1 total"`                 |

A count and a dollar cap are parsed out of `budget_hint` where present, and the
assumption is stated back in `estimate.assumption` so a wrong parse is visible
rather than silent.

```json
{
  "use_case": "illustration",
  "budget_hint": "20 images for a deck"
}
```

```json
{
  "use_case": "illustration",
  "best_overall": {
    "model": "gemini-3.1-flash-image",
    "display_name": "Nano Banana (Gemini 3.1 Flash Image)",
    "available_to_you": true,
    "via": ["openrouter", "google"],
    "price_per_image_usd": 0.039,
    "why": "Scores 5/5 for illustration, the highest of the curated models. The default workhorse: fast, cheap, and the strongest of the four on illustration and clean diagram-like output — which is exactly what deck and doc images usually are."
  },
  "best_configured": {
    "model": "gemini-3.1-flash-image",
    "display_name": "Nano Banana (Gemini 3.1 Flash Image)",
    "via": "openrouter",
    "price_per_image_usd": 0.039,
    "why": "use_case=illustration; highest-scoring available model for illustration at the lowest price. The default workhorse: fast, cheap, and the strongest of the four on illustration and clean diagram-like output — which is exactly what deck and doc images usually are."
  },
  "cheaper_alternative": {
    "model": "grok-imagine-image-2.0",
    "display_name": "Grok Imagine Image 2.0",
    "via": "openrouter",
    "price_per_image_usd": 0.02,
    "trade_off": "Roughly 2x cheaper at $0.02 an image. Scores 4/5 for illustration where Nano Banana (Gemini 3.1 Flash Image) scores 5/5. Do not pick it when the output size is load-bearing: the API takes an aspect ratio plus a resolution and has no size, quality or style parameter, so a requested 1536x1024 is approximated rather than honoured."
  },
  "estimate": {
    "assumed_count": 20,
    "assumed_budget_usd": null,
    "assumption": "Read 20 images from budget_hint \"20 images for a deck\"; the estimate is wrong if that is not what you meant.",
    "recommended_total_usd": 0.78,
    "cheaper_total_usd": 0.4
  },
  "recommended_model": "grok-imagine-image-2.0",
  "recommendation": "For 20 images the price gap outweighs the quality gap: use Grok Imagine Image 2.0 (grok-imagine-image-2.0) via openrouter — about $0.40 instead of $0.78, a saving of $0.38. Nano Banana (Gemini 3.1 Flash Image) scores 5/5 for illustration against 4/5, so switch back if that difference is what the batch is about.",
  "note_on_unconfigured": [],
  "knowledge_updated": "2026-08-26",
  "disclaimer": "Scores are editorial judgements informed by public leaderboards and hands-on testing, not measurements. …"
}
```

The recommendation is willing to name the cheap model. When the best model for a
use case is out of reach, `note_on_unconfigured` says concretely what would
unlock it — the variable to set, the switch to flip, or the fact that this build
has no adapter for that provider at all
([ADR 0012](adr/0012-what-recommend-model-is-willing-to-say.md)).
