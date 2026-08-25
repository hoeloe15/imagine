# Image generation providers — research notes, August 2026

**Researched:** 2026-08-25
**Purpose:** establish which providers `imagine` should support in the MVP, what
their API shapes actually are, and whether an existing routing library could do
the job instead of hand-written adapters.

Everything below reflects what public documentation said in late August 2026.
Image APIs move fast; re-verify before implementing an adapter.

---

## Summary of conclusions

1. **All four researched providers return base64.** None offers a URL response
   for the current image models. This confirms the core design constraint: the
   server must decode and write to disk, because base64 must never reach the
   client's context.
2. **OpenRouter is the best starting point for individuals.** One key, 30+ image
   models across 8 upstream providers, per-image pricing, model discovery over
   HTTP. It makes the "one credential, everything works" first-run experience
   possible.
3. **Azure OpenAI is the best starting point for organisations** — Entra ID auth,
   tenant governance, existing enterprise agreements.
4. **LiteLLM is not a safe engine for this.** Its image layer has repeated,
   fundamental breakage against Azure `gpt-image`, and the workaround suggested in
   its own issue threads is to bypass it. Details in §5.
5. **npx beats uvx on end-user friction**, particularly on Windows. §6.

---

## 1. OpenRouter

**Dedicated Image API**, launched late June 2026.

- Endpoint: `POST https://openrouter.ai/api/v1/images`
- Body carries `model` and `prompt`.
- Response is base64:

```json
{
  "data": [
    { "b64_json": "...", "media_type": "image/png" }
  ],
  "usage": { "cost": 0.04 }
}
```

- **Model discovery over HTTP:**
  - `GET /api/v1/images/models`
  - or `GET /api/v1/models?output_modalities=image`
- **Catalogue:** 30+ image models from 8 upstream providers — Google, OpenAI,
  Black Forest Labs, xAI, ByteDance, Microsoft, Recraft, Krea, Sourceful.
  Includes `openai/gpt-image-2` and `google/gemini-2.5-flash-image`.
- **Pricing:** per image. A failed generation is not charged.

**Relevance to imagine.** The `usage.cost` field means we get authoritative
per-call cost straight from the response rather than having to look it up in
`models.json` — worth preferring the reported cost over the curated estimate
whenever a provider supplies it. Live model discovery also means the OpenRouter
adapter can populate `list_capabilities` accurately without waiting for a
`models.json` refresh.

Sources:
- https://openrouter.ai/docs/guides/overview/multimodal/image-generation
- https://openrouter.ai/blog/tutorials/image-generation-models/
- https://openrouter.ai/collections/image-models

---

## 2. Azure OpenAI `gpt-image` (Azure AI Foundry)

- Endpoint:
  `https://<resource>.openai.azure.com/openai/deployments/<deployment>/images/generations?api-version=2025-04-01-preview`
  Edits use `/images/edits`.
- **The deployment name lives in the URL path**, not in the request body. This is
  the single most important detail on this page — see §5 for what happens to
  libraries that get it wrong.
- **Auth:** either an `api-key` header, or an Entra ID bearer token
  (`DefaultAzureCredential`, scope `https://ai.azure.com/.default`). Entra is the
  documented recommendation.
- **Response is always base64** (`b64_json`). `response_format` is *not*
  supported for the gpt-image series — there is no URL option to opt into.
- **Models:**
  | Model | Availability |
  |---|---|
  | `gpt-image-2` | GA |
  | `gpt-image-1.5` | limited access |
  | `gpt-image-1`, `gpt-image-1-mini` | limited access |
  | DALL·E 3 | retired 4 March 2026 |
- **FLUX / Black Forest Labs** is *not* confirmed available through this API. It
  may be reachable via the Foundry Model Catalog under a different endpoint shape.
  Unconfirmed — flagged as an open question in PLAN.md.

**Relevance to imagine.** The config needs a per-model deployment-name mapping,
because the user's deployment name is arbitrary and is not the model id. The
adapter must support both auth modes, defaulting to Entra.

Source: https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/dall-e

---

## 3. Google Gemini image (Nano Banana)

- Endpoint shape found in 2026 docs:
  `POST https://generativelanguage.googleapis.com/v1beta/interactions`
- Auth: `x-goog-api-key` header.
- Response: base64 at `interaction.output_image.data`.

**Caveat.** This differs from the classic `generateContent` path that most
existing code and tutorials use. It is not clear from the docs alone whether
`/v1beta/interactions` supersedes `generateContent`, sits alongside it, or is
specific to a subset of models. **Verify against a live key before writing the
adapter.** The cost of deferring is low, because OpenRouter reaches the same
models in the meantime.

**Variants:** Nano Banana Lite, Nano Banana (3.1 Flash Image), Nano Banana Pro,
and legacy 2.5 Flash Image.

**Indicative pricing** (per image; treat as indicative, not confirmed):
| Variant | ~1K | 4K |
|---|---|---|
| Nano Banana 2 | $0.02 – $0.054 | ~$0.12 |
| Nano Banana Pro | ~$0.134 (1K/2K) | ~$0.24 |

Sources:
- https://ai.google.dev/gemini-api/docs/image-generation
- https://ark-route.com/blog/nano-banana-api-guide
- https://evolink.ai/nano-banana-2

---

## 4. xAI Grok image

- Endpoint: `POST https://api.x.ai/v1/images/generations`
- **OpenAI-SDK-compatible**, which makes this the cheapest adapter to write.
- Model example: `grok-imagine-image-2.0`
- Supports: up to 10 outputs per call, aspect ratio, resolution, response format.
- **Does not support** `quality`, `size` or `style` parameters.

**Relevance to imagine.** The missing `size` parameter is the concrete case that
forces the size-normalisation question: the router's `size: "1536x1024"` has to
become an aspect ratio plus a resolution here. Whatever normalisation rule we
adopt, the actual output dimensions must be reported back in the tool result.

**Indicative pricing:** ~$0.02/image at 1K; pro tier roughly $0.05–$0.07.

Sources:
- https://docs.x.ai/developers/model-capabilities/images/generation
- https://www.eesel.ai/blog/xai-pricing

---

## 5. LiteLLM as a routing engine — evaluated and rejected

LiteLLM was the obvious candidate for "don't write your own routing layer". It
was evaluated seriously and rejected on evidence.

**Documented image providers:** OpenAI, Azure, Google AI Studio, Vertex AI,
Bedrock, Black Forest Labs, Recraft, OpenRouter, Xinference, Nscale. **xAI is not
listed** — one of our four MVP providers is absent outright.

**Azure `gpt-image` breakage, repeatedly:**

| Issue | Problem |
|---|---|
| [#26316](https://github.com/BerriAI/litellm/issues/26316) | `gpt-image-2`: deployment name sent as the `model` field in the request body; Azure does not accept it |
| [#23709](https://github.com/BerriAI/litellm/issues/23709) | Same failure against `gpt-image-1.5` |
| [#15273](https://github.com/BerriAI/litellm/issues/15273) | `extra_body` injection causes Azure to return 400 |
| [#16422](https://github.com/BerriAI/litellm/issues/16422) | Managed Identity auth fails |
| [#20741](https://github.com/BerriAI/litellm/issues/20741), [#11707](https://github.com/BerriAI/litellm/issues/11707) | Further image-path failures |

The pattern is consistent: the chat layer is well-polished, the image layer is
not. The specific bug in #26316 and #23709 is exactly the Azure detail called out
in §2 — the deployment name belongs in the URL path, not the body. And the
workaround offered inside the issue threads is *"call Azure directly."*

**Judgement.** Taking a large dependency is worth it when it absorbs complexity
you would otherwise carry. Here the complexity we need absorbed is precisely
where the dependency is weakest, and one of our four providers is not covered at
all. Four thin adapters we control is the lower-risk option.

**The trade-off, stated honestly:** we now own four adapters and their
maintenance indefinitely, including the churn as these APIs change. At four
providers that is a few hundred lines. At forty it would be the wrong decision,
and this conclusion should be revisited if the provider list ever grows that far.

Source: https://docs.litellm.ai/docs/image_generation

---

## 6. MCP distribution: npx vs uvx

- Roughly **55% of MCP servers ship via npm/npx**, roughly **38% via
  Python/uvx**.
- **uvx friction is concentrated on Windows:** Python and `uv` are not present by
  default, and GUI applications frequently do not inherit a PATH that works fine
  in a terminal — so a server that launches from a shell fails to launch from the
  client.

**Conclusion:** TypeScript on Node, distributed via `npx`. This is a
distribution-friction decision, not a language-preference one.

Source: https://buildtolaunch.substack.com/p/mcp-server-types-installation-guide-claude-cursor

---

## 7. What this means for the design

| Finding | Design consequence |
|---|---|
| Every provider returns base64 | Decode-and-write in the server is mandatory, not a nicety |
| Azure puts the deployment in the URL path | Config needs a model → deployment-name map; contract tests must assert the request shape |
| Azure supports Entra ID | Auth mode is configurable, defaulting to Entra |
| OpenRouter reports `usage.cost` | Prefer provider-reported cost over the curated estimate when available |
| OpenRouter has live model discovery | `list_capabilities` can be accurate without a `models.json` refresh |
| xAI has no `size` parameter | Size normalisation is a real core concern; report actual dimensions back |
| Gemini endpoint shape is ambiguous | Defer the Google adapter; reach the models via OpenRouter first |
| LiteLLM's image layer breaks on Azure | Own thin adapters; contract tests specifically guard request shape |
| npx has lower Windows friction | TypeScript + Node |
