# imagine — a capability router for image generation

**Status:** early design. Nothing is built yet. This document is the plan.
**Last updated:** 2026-08-25

---

## 1. Why this exists

AI coding clients — Claude Code, Codex, Cursor — are good at producing structured
artefacts: decks, reports, landing pages, docs. They are bad at the pictures that
go in them. Ask an assistant to build a PowerPoint and you get correct, empty
slides: bullet points where a diagram should be, a grey placeholder rectangle
where an illustration should be.

The models that *can* make those pictures exist. They are just not reachable from
inside the client, and picking one is its own problem:

- **Which model is best changes every few weeks.** A choice hard-coded in
  February is stale by May.
- **"Best" is use-case dependent.** The model that renders legible text inside an
  image is not the model that does photorealism, is not the cheap model you want
  when the task is "generate 20 thumbnails".
- **Every provider has a different API shape**, different auth, different
  pricing, different response envelope.
- **Cost is invisible.** An assistant happily burns €4 on twenty images at the
  expensive model because nothing told it there was a €0.40 option that was fine.

`imagine` sits in between. One stable MCP interface for the client. Swappable
providers behind it. Plus curated, maintained knowledge about which model is good
at what, and what it costs — so the client can make an informed choice instead of
a hard-coded one.

### The driving use case

Claude is building a PowerPoint. Partway through it decides slide 4 needs an
illustration of a distribution network. It calls `generate_image` over MCP. The
tool writes a PNG to disk and returns the file path plus metadata. Claude passes
that path to `python-pptx` and places it in the slide. The deck comes out with
real images in it, generated in-flight, without the model ever handling image
bytes.

That flow — *tool writes file, returns path, client places file* — is the shape
the whole product is designed around.

---

## 2. What it is, concretely

A **capability router**: a small server that exposes one capability (image
generation) as provider-agnostic tools, and routes calls to whichever backend the
user has configured, informed by curated model knowledge.

Shipped as an **MCP server over stdio**, installed with `npx`. Written in
**TypeScript on Node**.

"Capability router" rather than "image router" is deliberate. A second capability
(speech, video, whatever earns its place) should be one more adapter plus one more
tool — not a rewrite. That is a design constraint, not a roadmap promise: speech
and TTS are explicitly **not** planned.

---

## 3. Architecture

```
   ┌─────────────────────────────────────────────────────────┐
   │  MCP client (Claude Code / Codex / Cursor / any client)  │
   └───────────────────────────┬─────────────────────────────┘
                               │  stdio, MCP protocol
                               │  tool calls in, {path, cost, ...} out
   ┌───────────────────────────▼─────────────────────────────┐
   │  MCP adapter layer  (thin — protocol only)              │
   │  • tool schemas & validation                            │
   │  • maps core results → MCP tool results                 │
   │  • NO routing logic, NO provider knowledge              │
   └───────────────────────────┬─────────────────────────────┘
                               │
   ┌───────────────────────────▼─────────────────────────────┐
   │  Core router                                            │
   │  ┌───────────┐ ┌──────────┐ ┌───────────┐ ┌──────────┐  │
   │  │ config &  │ │ model    │ │ cost      │ │ output   │  │
   │  │ key       │ │ knowledge│ │ ledger &  │ │ writer   │  │
   │  │ resolution│ │(models.  │ │ budgets   │ │(disk/blob)│ │
   │  │           │ │  json)   │ │           │ │          │  │
   │  └───────────┘ └──────────┘ └───────────┘ └──────────┘  │
   │           routing • retries • normalisation             │
   └───┬─────────────┬──────────────┬──────────────┬─────────┘
       │             │              │              │
  ┌────▼────┐  ┌─────▼──────┐  ┌────▼─────┐  ┌─────▼─────┐
  │ Azure   │  │ OpenRouter │  │ Google   │  │ xAI       │
  │ OpenAI  │  │            │  │ Gemini   │  │ Grok      │
  │ adapter │  │  adapter   │  │ adapter  │  │ adapter   │
  └────┬────┘  └─────┬──────┘  └────┬─────┘  └─────┬─────┘
       │             │              │              │
       └─────────────┴──────┬───────┴──────────────┘
                            │  all return base64 today
                            ▼
              base64 is decoded HERE and written to disk.
              It never travels back up to the client.
```

Later, a second front end can sit next to the MCP adapter on the *same core*:

```
   MCP adapter ──┐
                 ├──► core router ──► providers
   REST layer  ──┘    (OpenAI-compatible /v1/images/generations)
```

That REST layer is not in the MVP, but the layering exists so it stays a small
addition rather than a refactor.

### Why the layering is strict

The MCP adapter must contain no provider knowledge whatsoever. If adding a
provider requires touching the MCP layer, the layering has failed. The test:
you should be able to delete the MCP layer, write a CLI in its place, and lose
no functionality.

---

## 4. Design principles

### 4.1 The router informs; it does not decide

This is the central one. `imagine` does not silently pick a model and hide the
choice. Its tools return **options, strengths, prices and trade-offs**, so the
client — the AI, and behind it the human — can choose with the facts visible.

- `list_capabilities()` says what is available *right now, given your config*.
- `recommend_model()` gives a ranked answer *with reasoning and price*, including
  "the best model overall is X, but you don't have it configured; the best you do
  have is Y."
- `provider_hint` is a **hint, not a contract**. If the hinted provider is
  unavailable or fails, the router falls back and says so in the response
  metadata. It never silently pretends the hint was honoured.

A router that quietly decides is a router you have to fight. A router that
explains is one the model can reason with.

### 4.2 Never base64 in tool results

Every provider API researched returns base64. Every single one. That is fine —
for the server. It is not fine for the client: a 1024×1024 PNG is roughly 1.4 MB
of base64, which is on the order of 350k tokens if it ever lands in a context
window. It would destroy the session it was meant to help.

So: the server decodes and writes. The client gets a path.

```json
{
  "path": "/home/user/deck/images/distribution-network-a41f.png",
  "provider": "openrouter",
  "model": "google/gemini-3.1-flash-image",
  "cost_usd": 0.039,
  "duration_ms": 4180,
  "width": 1024,
  "height": 1024
}
```

In the future cloud variant, "write to disk" becomes "write to Blob Storage" and
`path` becomes a URL. Same contract, different sink. Base64 still never leaves the
server toward the client.

### 4.3 Stable tools, shifting providers

The tool surface is the product's public contract. Providers, models, prices and
rankings churn underneath it. A user who set this up in August should get better
results in December without changing a line of config — because `models.json`
moved, not because the API did.

Corollary: no provider name ever appears in a *required* tool parameter.

### 4.4 Cost honesty

Cost is a first-class return value, not a footnote. Every generation logs what it
cost. Config can cap spend per day and per session. And `recommend_model` is
expected to say the unglamorous thing out loud:

> "You asked for 20 images for a deck. `gpt-image-2` is the strongest at text
> inside images, but at ~$0.19 each that's ~$3.80. For deck illustrations without
> embedded text, `gemini-3.1-flash-image` at ~$0.039 gets you the same job for
> ~$0.78. Recommend the latter unless the images need legible labels."

A recommender that always recommends the best model is a recommender nobody
trusts on their second invoice.

### 4.5 Boring failure

Image APIs fail: content filters, rate limits, timeouts, transient 5xx. The
router should fail in a way the calling model can act on — a clear reason code,
whether a retry or a different provider would help, and whether it cost anything.
(OpenRouter, usefully, does not charge for failed generations.)

---

## 5. Tool API design

Three tools in the MVP. Deliberately few.

### 5.1 `generate_image`

Generate an image, write it to disk, return the path.

**Parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `prompt` | string | yes | The image description. Passed through mostly untouched. |
| `size` | string | no | `"1024x1024"`, `"1536x1024"`, `"1024x1536"`, or `"auto"`. Normalised per provider (some take aspect ratios, not pixel sizes). |
| `style` | string | no | Free-text nudge, e.g. `"flat vector illustration"`, `"photorealistic"`. Appended to the prompt where the provider has no style parameter. |
| `use_case` | string | no | One of the known use-case tags (§6). Drives model selection when no hint is given. |
| `provider_hint` | string | no | A hint. `"azure"`, `"openrouter"`, `"google"`, `"xai"`, or a full model id. |
| `output_dir` | string | no | Where to write. Defaults to config `output.dir`. Respected exactly when given. |

**Example request**

```json
{
  "prompt": "A clean flat-vector diagram of a regional distribution network: one central warehouse, four spokes to smaller depots, muted blue and slate palette, no text labels",
  "size": "1536x1024",
  "use_case": "diagram",
  "output_dir": "/home/user/deck/images"
}
```

**Example response**

```json
{
  "path": "/home/user/deck/images/regional-distribution-network-7c2e.png",
  "provider": "openrouter",
  "model": "google/gemini-3.1-flash-image",
  "cost_usd": 0.039,
  "duration_ms": 4180,
  "width": 1536,
  "height": 1024,
  "selection_reason": "use_case=diagram; highest-scoring configured model for diagrams at lowest price tier",
  "budget": { "session_spent_usd": 0.117, "session_limit_usd": 5.0 }
}
```

**Example failure response**

```json
{
  "error": "content_filtered",
  "message": "Provider rejected the prompt under its content policy.",
  "provider": "azure",
  "model": "gpt-image-2",
  "cost_usd": 0.0,
  "retryable": false,
  "suggestion": "Rephrase the prompt, or try provider_hint='openrouter' — policies differ between providers."
}
```

### 5.2 `list_capabilities`

What can this installation actually do, right now?

**Parameters:** none.

**Example response**

```json
{
  "configured_providers": [
    {
      "id": "openrouter",
      "status": "ready",
      "models": ["google/gemini-3.1-flash-image", "black-forest-labs/flux-2-pro", "xai/grok-imagine-image-2.0"]
    },
    {
      "id": "azure",
      "status": "ready",
      "models": ["gpt-image-2"]
    },
    { "id": "google", "status": "not_configured", "missing": ["GOOGLE_API_KEY"] },
    { "id": "xai",    "status": "not_configured", "missing": ["XAI_API_KEY"] }
  ],
  "default_model": "google/gemini-3.1-flash-image",
  "use_cases": ["text_in_image", "photoreal", "illustration", "diagram", "fast_bulk"],
  "budget": {
    "session_spent_usd": 0.117,
    "session_limit_usd": 5.0,
    "day_spent_usd": 1.44,
    "day_limit_usd": 10.0
  },
  "knowledge_updated": "2026-08-22"
}
```

Note `knowledge_updated`: the client should be able to see how stale the curated
data is and weigh it accordingly.

### 5.3 `recommend_model`

Ask for advice before spending money.

**Parameters**

| Name | Type | Required | Notes |
|---|---|---|---|
| `use_case` | string | no | Use-case tag. Omit for a general answer. |
| `budget_hint` | string | no | Free text, e.g. `"20 images for a deck"`, `"one hero image, quality matters"`, `"under $1 total"`. |

**Example request**

```json
{ "use_case": "text_in_image", "budget_hint": "6 images, they need readable labels" }
```

**Example response**

```json
{
  "best_overall": {
    "model": "gpt-image-2",
    "available_to_you": true,
    "via": ["azure", "openrouter"],
    "price_per_image_usd": 0.19,
    "why": "Strongest current model for rendering legible text inside images."
  },
  "best_configured": {
    "model": "gpt-image-2",
    "via": "azure",
    "price_per_image_usd": 0.19
  },
  "cheaper_alternative": {
    "model": "google/gemini-3.1-flash-image",
    "price_per_image_usd": 0.039,
    "trade_off": "Roughly 5x cheaper, but text rendering is noticeably weaker — expect garbled words at small sizes. Fine if the labels are added afterwards in the deck instead of baked into the image."
  },
  "estimate": {
    "assumed_count": 6,
    "recommended_total_usd": 1.14,
    "cheaper_total_usd": 0.234
  },
  "recommendation": "Since the labels must be readable, use gpt-image-2 via azure — $1.14 for 6 images. If you can place the labels as PowerPoint text boxes over a plain illustration, switch to gemini-3.1-flash-image and pay $0.23.",
  "note_on_unconfigured": [],
  "knowledge_updated": "2026-08-22"
}
```

If the best model were *not* configured, `note_on_unconfigured` would carry the
nudge: *"The strongest model for this use case is X. You don't have it. Adding an
OpenRouter key would give you X, Y and Z with one credential."*

---

## 6. Curated model knowledge: `data/models.json`

The thing that makes this more than a thin proxy. A hand-maintained file, updated
weekly, describing what each model is good at and what it costs.

### Use-case tags (v1)

`text_in_image` · `photoreal` · `illustration` · `diagram` · `fast_bulk`

Scores are 1–5, subjective, sourced from public leaderboards plus hands-on
checking. They are explicitly editorial. The file says so.

### Schema

```jsonc
{
  "schema_version": 1,
  "updated": "2026-08-22",
  "disclaimer": "Scores are editorial judgements informed by public leaderboards and hands-on testing. Prices are indicative list prices per image at ~1K resolution and change frequently — always confirm with the provider.",
  "models": [
    {
      "id": "…",                    // canonical id used in config and tool results
      "display_name": "…",
      "family": "…",
      "leaderboard": {              // indicative ranking signal, may be null
        "source": "…",
        "rank_band": "top-3 | top-10 | mid | unranked",
        "checked": "YYYY-MM-DD"
      },
      "strengths": {                // 1–5 per use case
        "text_in_image": 0,
        "photoreal": 0,
        "illustration": 0,
        "diagram": 0,
        "fast_bulk": 0
      },
      "typical_latency_s": 0,
      "price": {
        "per_image_usd": 0.0,       // at ~1K
        "per_image_usd_4k": 0.0,    // null if not offered
        "confidence": "indicative | confirmed",
        "checked": "YYYY-MM-DD"
      },
      "availability": [             // which adapters can reach it
        { "provider": "openrouter", "model_ref": "…" },
        { "provider": "azure", "model_ref": "…", "note": "requires a deployment of this model" }
      ],
      "max_size": "…",
      "notes": "…"
    }
  ]
}
```

### Worked example (indicative — verify before relying on it)

```jsonc
{
  "schema_version": 1,
  "updated": "2026-08-22",
  "disclaimer": "Editorial scores; indicative prices. Verify with the provider.",
  "models": [
    {
      "id": "gpt-image-2",
      "display_name": "GPT Image 2",
      "family": "openai",
      "leaderboard": { "source": "public image arena", "rank_band": "top-3", "checked": "2026-08-22" },
      "strengths": {
        "text_in_image": 5,
        "photoreal": 4,
        "illustration": 4,
        "diagram": 4,
        "fast_bulk": 2
      },
      "typical_latency_s": 12,
      "price": { "per_image_usd": 0.19, "per_image_usd_4k": null, "confidence": "indicative", "checked": "2026-08-22" },
      "availability": [
        { "provider": "azure", "model_ref": "<your-deployment-name>", "note": "GA; deployment name goes in the URL path, not the body" },
        { "provider": "openrouter", "model_ref": "openai/gpt-image-2" }
      ],
      "max_size": "1536x1024",
      "notes": "Best-in-class for legible text inside images. Meaningfully more expensive and slower than the flash-tier models; the wrong default for bulk work."
    },
    {
      "id": "gemini-3.1-flash-image",
      "display_name": "Nano Banana (Gemini 3.1 Flash Image)",
      "family": "google",
      "leaderboard": { "source": "public image arena", "rank_band": "top-3", "checked": "2026-08-22" },
      "strengths": {
        "text_in_image": 3,
        "photoreal": 4,
        "illustration": 5,
        "diagram": 4,
        "fast_bulk": 5
      },
      "typical_latency_s": 4,
      "price": { "per_image_usd": 0.039, "per_image_usd_4k": 0.12, "confidence": "indicative", "checked": "2026-08-22" },
      "availability": [
        { "provider": "google", "model_ref": "nano-banana" },
        { "provider": "openrouter", "model_ref": "google/gemini-3.1-flash-image" }
      ],
      "max_size": "4K",
      "notes": "The default workhorse: fast, cheap, strong on illustration and clean diagram-like output. Reported list price sits in the $0.02–0.054 band at 1K depending on tier; treat 0.039 as a mid-band estimate. A Pro tier exists at roughly $0.13 (1K/2K) and $0.24 (4K) for higher fidelity."
    },
    {
      "id": "grok-imagine-image-2.0",
      "display_name": "Grok Imagine Image 2.0",
      "family": "xai",
      "leaderboard": { "source": "public image arena", "rank_band": "top-10", "checked": "2026-08-22" },
      "strengths": {
        "text_in_image": 3,
        "photoreal": 4,
        "illustration": 4,
        "diagram": 3,
        "fast_bulk": 5
      },
      "typical_latency_s": 5,
      "price": { "per_image_usd": 0.02, "per_image_usd_4k": null, "confidence": "indicative", "checked": "2026-08-22" },
      "availability": [
        { "provider": "xai", "model_ref": "grok-imagine-image-2.0" },
        { "provider": "openrouter", "model_ref": "xai/grok-imagine-image-2.0" }
      ],
      "max_size": "1024x1024",
      "notes": "Cheapest of the four at ~$0.02/image (a pro tier lands around $0.05–0.07). OpenAI-SDK-compatible API. No quality/size/style parameters — aspect ratio and resolution instead, so size normalisation matters here."
    },
    {
      "id": "flux-2-pro",
      "display_name": "FLUX 2 Pro",
      "family": "black-forest-labs",
      "leaderboard": { "source": "public image arena", "rank_band": "top-10", "checked": "2026-08-22" },
      "strengths": {
        "text_in_image": 4,
        "photoreal": 5,
        "illustration": 4,
        "diagram": 3,
        "fast_bulk": 3
      },
      "typical_latency_s": 9,
      "price": { "per_image_usd": 0.055, "per_image_usd_4k": null, "confidence": "indicative", "checked": "2026-08-22" },
      "availability": [
        { "provider": "openrouter", "model_ref": "black-forest-labs/flux-2-pro" }
      ],
      "max_size": "1440x1440",
      "notes": "Strongest photorealism of the set. Reachable via OpenRouter in the MVP. Availability through Azure AI Foundry's model catalogue is unconfirmed — see Open questions."
    }
  ]
}
```

### Keeping it fresh

- **Now:** manual weekly pass. A dated entry in the file; stale data is visible
  because `updated` and `knowledge_updated` are surfaced to the client.
- **Later:** a scheduled GitHub Action that checks public leaderboards and
  provider pricing pages, and **opens a PR** with proposed diffs. A PR, never a
  direct commit — editorial scores need a human eye, and an automated commit that
  silently changes what the router recommends is exactly the failure mode this
  project exists to avoid.

---

## 7. Configuration

Config lives in `config.json` (project-local, then user-level at
`~/.imagine/config.json`), with secrets resolved from environment variables. A
`.env` next to the config is loaded if present.

**Keys are never stored in the config file.** The config stores the *name of the
environment variable* holding the key. This is what makes the file safe to commit
and safe to share in a blog post.

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/hoeloe15/imagine/main/schema/config.schema.json",

  "default": {
    "model": "gemini-3.1-flash-image",
    "size": "1024x1024"
  },

  "providers": {
    "openrouter": {
      "enabled": true,
      "api_key_env": "OPENROUTER_API_KEY"
    },
    "azure": {
      "enabled": true,
      "endpoint": "https://my-resource.openai.azure.com",
      "api_version": "2025-04-01-preview",
      "auth": "entra",                    // "entra" | "api_key"
      "api_key_env": "AZURE_OPENAI_API_KEY",   // only used when auth = "api_key"
      "deployments": {
        "gpt-image-2": "my-gpt-image-2-deployment"
      }
    },
    "google": {
      "enabled": false,
      "api_key_env": "GOOGLE_API_KEY"
    },
    "xai": {
      "enabled": false,
      "api_key_env": "XAI_API_KEY"
    }
  },

  "output": {
    "dir": "./imagine-output",
    "filename": "{slug}-{hash}.{ext}",     // {slug} from prompt, {hash} short content hash
    "manifest": "./imagine-output/manifest.jsonl"
  },

  "budget": {
    "max_usd_per_session": 5.0,
    "max_usd_per_day": 10.0,
    "on_exceed": "refuse"                  // "refuse" | "warn"
  },

  "logging": {
    "level": "info",
    "cost_log": "./imagine-output/costs.jsonl"
  }
}
```

**Budget semantics.** `refuse` returns a structured error explaining the limit was
hit, what has been spent, and when it resets — never a silent stall. `warn`
proceeds but flags it in the response so the model can mention it. Both budgets
apply; the tighter one wins. A "session" is one server process lifetime.

**Zero-config path.** With only `OPENROUTER_API_KEY` in the environment and no
config file at all, the server starts, enables OpenRouter, uses bundled defaults,
and works. That is the intended first-run experience: one key, everything works.

---

## 8. Distribution and package layout

### Why TypeScript + npx

Two decisions, one reasoning chain — documented properly in
[`docs/research/providers-2026-08.md`](docs/research/providers-2026-08.md).

**npx over uvx.** Roughly 55% of published MCP servers ship via npm/npx against
~38% Python/uvx, and the friction gap is worst exactly where the users are:
Windows, where Python and `uv` are not present by default and GUI applications
routinely fail to pick up a PATH that works fine in a terminal. Node is a single
installer and `npx` is already how most MCP clients expect to launch a server.

**Own thin adapters over LiteLLM.** LiteLLM was the obvious "don't build a
routing layer" answer, and it is a good library — for chat. Its image layer has a
repeated pattern of fundamental breakage on Azure `gpt-image`: issues
[BerriAI/litellm#26316](https://github.com/BerriAI/litellm/issues/26316) and
[#15273](https://github.com/BerriAI/litellm/issues/15273) both come down to the
library putting a `model` field in the request body that Azure's image endpoint
does not accept — and the workaround offered in the threads is "call Azure
directly". With four providers, four small adapters we control is less risk than
one large dependency whose failure mode is in the exact place we live. Also worth
noting: LiteLLM's documented image providers do not include xAI at all.

The trade-off is honest: we own four adapters and their upkeep forever. At four,
that is a few hundred lines. At forty it would be the wrong call.

### Package name

`imagine` on npm is taken (an unrelated package). **`imagine-mcp` is free**
(verified against the npm registry on 2026-08-25), so that is the package name:
users run `npx imagine-mcp`. The binary name stays `imagine`.

### Repository layout

```
imagine/
├── package.json
├── README.md
├── PLAN.md
├── src/
│   ├── index.ts               # bin entry: parse args, start stdio server
│   ├── mcp/
│   │   ├── server.ts          # MCP wiring only
│   │   └── tools/
│   │       ├── generate-image.ts
│   │       ├── list-capabilities.ts
│   │       └── recommend-model.ts
│   ├── core/
│   │   ├── router.ts          # model selection + fallback
│   │   ├── config.ts          # load, merge, validate, resolve env keys
│   │   ├── knowledge.ts       # models.json loading + queries
│   │   ├── recommend.ts       # the advice engine
│   │   ├── budget.ts          # ledger, limits, session/day accounting
│   │   ├── output.ts          # decode base64, name file, write, manifest
│   │   └── types.ts           # the internal normalised request/response
│   └── providers/
│       ├── types.ts           # the ImageProvider interface every adapter implements
│       ├── openrouter.ts
│       ├── azure.ts
│       ├── google.ts
│       └── xai.ts
├── data/
│   └── models.json
├── schema/
│   └── config.schema.json
├── docs/
│   ├── issues-draft.md
│   └── research/
│       └── providers-2026-08.md
└── test/
    ├── unit/                  # router, budget, config, recommend — pure logic
    ├── contract/              # each adapter against recorded fixtures
    └── live/                  # opt-in, real keys, real money, off by default
```

### The provider interface

Every adapter implements the same small surface. Adding a provider means writing
this and registering it — nothing else in the codebase changes.

```ts
interface ImageProvider {
  readonly id: string;
  isConfigured(): boolean;
  listModels(): Promise<ProviderModel[]>;
  generate(req: NormalisedRequest): Promise<NormalisedResult>;
}
```

`NormalisedResult` carries **raw bytes plus metadata**, not base64 and not a
path. Decoding happens in the adapter; writing happens in `core/output.ts`. One
place writes files, so `output_dir`, naming and the manifest behave identically
regardless of provider.

### Testing strategy

- **Unit tests** on the pure logic — routing decisions, budget arithmetic, config
  merging, recommendation output. This is where the actual product behaviour
  lives, and it needs no network.
- **Contract tests** per adapter against recorded HTTP fixtures, asserting we send
  the shape each provider documents (this is precisely the class of bug that bit
  LiteLLM) and parse the shape it returns.
- **Live tests** behind an explicit flag and real keys. Not in CI by default —
  they cost money and they flake. Run before a release.
- **One end-to-end smoke test**: start the server, call `generate_image` against a
  stub provider, assert a real file lands on disk at the requested path and that
  no base64 appears anywhere in the tool result. That last assertion is worth a
  dedicated test; it is the invariant most likely to be broken by a careless
  change.

---

## 9. Phases

### Phase 1 — local-first MVP

Stdio MCP server, config from file plus env, two providers, no UI.

Scope:
- Scaffold, TypeScript build, `npx`-runnable binary
- Core router, config loading, normalised types
- Adapters: OpenRouter, Azure OpenAI
- All three MCP tools
- `models.json` v1 with the four models above
- Cost logging and budget limits
- Output writing with `output_dir` support
- README + quickstart

**Definition of done:** a person who has never seen the repo can run
`npx imagine-mcp`, with only an OpenRouter key in their environment, add it to
Claude Code, ask Claude to build a slide deck with generated illustrations, and
get a `.pptx` with real images in it. Cost of the run is visible afterwards in
the cost log. No base64 ever appears in the transcript.

### Phase 2 — local mini-portal

A localhost web UI served by the same package (`imagine ui`, or a flag).

Scope:
- Key management: see which providers are configured, add/remove keys, test a key
- **Library / gallery**: every image ever generated, browsable
- Filter by date, model, provider, prompt text, cost
- Metadata in a local manifest alongside the images — JSONL first for
  greppability and diff-friendliness; migrate to SQLite if filtering gets slow
- Budget view: spend per day, per model

**Definition of done:** after a week of real use, you can open the portal, find
the image you made on Tuesday by typing part of its prompt, see what it cost and
which model made it, and copy its path. Keys can be added through the UI without
hand-editing JSON.

### Phase 3 — Azure deployment

The same thing, deployable into your own tenant, governed.

Scope:
- `azd up` template
- Azure Container Apps hosting both the MCP endpoint and the portal
- Key Vault for provider credentials
- Entra ID auth on **both** the MCP endpoint and the portal
- Blob Storage as the output sink; `path` becomes a URL
- Same portal code as phase 2 — the storage backend swaps, the UI does not

**Definition of done:** `azd up` in a clean subscription produces a working,
authenticated MCP endpoint; a colleague in the same tenant can point their client
at it, generate an image, and see it appear in the shared gallery — with no
provider key ever leaving Key Vault and no key on their machine.

### Explicitly not on the roadmap

- Azure Marketplace listing
- Speech / TTS / any second capability

The architecture keeps a second capability cheap. That is not the same as
planning one.

---

## 10. Writing about it

Two natural moments:

1. **After phase 1** — the demo (Claude assembling a deck with images it made
   itself, end to end) plus the build story: *the abstraction layer you shouldn't
   build — and shouldn't import either.* The LiteLLM evaluation is the interesting
   half; "we wrote our own adapters" is only a good story when you can show the
   issue numbers.
2. **After phase 3** — governed deployment in your own tenant: Entra ID on the
   MCP endpoint, keys in Key Vault, images in Blob Storage. The part most MCP
   write-ups skip.

Raw material accumulates in a private build log kept outside this repository.

---

## 11. Open questions

1. **npm package name.** Resolved: `imagine` is taken, `imagine-mcp` is free
   (checked 2026-08-25). Package name is `imagine-mcp`; claim it at scaffold time.
2. **Gemini endpoint shape.** Research surfaced a `POST /v1beta/interactions`
   endpoint (auth via `x-goog-api-key`, image at
   `interaction.output_image.data`) alongside the classic `generateContent` path.
   Which is current — and whether both work — must be verified against a live key
   before the Google adapter is written. Low cost to defer: OpenRouter reaches
   the same models in the meantime.
3. **FLUX on Azure AI Foundry.** Black Forest Labs models are not confirmed
   reachable through the Azure OpenAI images API. They may be available via the
   Foundry model catalogue with a different endpoint shape. Unconfirmed. Until
   confirmed, `models.json` lists FLUX as OpenRouter-only.
4. **Gallery thumbnails.** Phase 2 needs thumbnails for a gallery that may hold
   thousands of images. Generate on write (fast browsing, more disk, wasted work
   for images never viewed) or on demand with a cache (lazier, first-scroll
   stutter)? And in phase 3, do thumbnails live in Blob Storage next to the
   originals, or get generated at request time from the original? Deferred to
   phase 2 design.
5. **Size normalisation semantics.** Providers disagree fundamentally: some take
   pixel dimensions, xAI takes aspect ratio plus resolution. When a requested
   size cannot be honoured exactly, does the router pick the nearest and report
   it, or refuse? Current lean: nearest match, reported explicitly in the
   response — consistent with "inform, don't decide", as long as the actual
   dimensions come back in the result.
