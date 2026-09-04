# Microsoft MAI-Image on Azure AI Foundry — research notes, September 2026

Research for [issue #59](https://github.com/hoeloe15/imagine/issues/59). Written 2026-09-04.
Companion to `providers-2026-08.md`, which covers the `gpt-image` path this
document deliberately contrasts with.

Every claim below carries the source it came from and the date that source
carries. Where a claim is a guess, it says so.

---

## Summary of conclusions

1. **MAI is a different API, not a different deployment of the same API.** It is
   `POST https://<resource>.services.ai.azure.com/mai/v1/images/generations`, no
   `api-version` query string, and the deployment name goes in the body as
   `model` — the exact opposite of the `gpt-image` rule this repo hard-codes.
   Sizes are `width`/`height` integers, not a `size` string. Output is base64
   PNG in `data[0].b64_json`, same as today.
2. **`src/providers/azure.ts` needs a code change.** A deployments-mapping entry
   alone will produce a 404 (wrong host, wrong path) and then a 400 (wrong body).
3. **Pricing is per token, not per image.** Microsoft publishes image *output
   token* rates. Converting to a per-image number requires a tokens-per-image
   figure Microsoft does not publish; the best available conversion is
   third-party and is flagged as such.
4. **MAI-Image-2.6 and 2.6-Flash are undocumented.** They are deployable in
   swedencentral according to the control plane, but they appear in no Learn
   page, no region table, no pricing table and no model card. 2.6-Flash appears
   in *no* public source at all — not even a press release.
5. **The quota story is good news for the capacity-1 problem:** a capacity-1
   GlobalStandard MAI deployment is documented at 2 RPM, not the effectively
   unusable allowance `gpt-image-2` gave us.

---

## 1. The wire shape

Primary source: [Deploy and use MAI image models in Microsoft Foundry](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/use-foundry-models-mai-image),
Microsoft Learn, `ms.date` **2026-08-19**, page metadata `updated_at`
**2026-08-28**. Read 2026-09-04.

### 1.1 Endpoint

```
POST https://<resource-name>.services.ai.azure.com/mai/v1/images/generations
POST https://<resource-name>.services.ai.azure.com/mai/v1/images/edits
```

Three differences from the `gpt-image` path in `providers-2026-08.md` §2, all of
them load-bearing:

| | `gpt-image` (what azure.ts does today) | MAI-Image |
| --- | --- | --- |
| Host | `<resource>.openai.azure.com` | `<resource>.services.ai.azure.com` |
| Path | `/openai/deployments/{deployment}/images/generations` | `/mai/v1/images/generations` |
| Deployment named in | the **URL path** | the **request body**, as `model` |
| `api-version` | required query string (`2025-04-01-preview`) | **none documented, none in any Microsoft example** |

The Learn page's cURL and Python examples contain no `api-version` query string
anywhere. The `v1` in the path is the version. (2026-09-04: I could not find a
REST API reference page for `/mai/v1/`, so "there is no api-version" is
inference from the absence of one in every official example, not from an
explicit statement. See §5.)

Note the irony worth recording next to the LiteLLM lesson: for `gpt-image` the
deployment name in the body is the classic failure; for MAI the deployment name
in the body is *mandatory*. The rule is per-API, not per-vendor.

### 1.2 Request body

Generations — JSON:

```json
{
  "model": "<your-deployment-name>",
  "prompt": "A photorealistic concept art poster of a university at sunset",
  "width": 1024,
  "height": 1024
}
```

Documented parameters, from the "Request parameters" table on the same page:

| Parameter | API | Type | Notes |
| --- | --- | --- | --- |
| `model` | both | string | The **deployment name**, not the model name |
| `prompt` | both | string | Max context 32,000 tokens |
| `image` | edits | file | multipart form data, JPEG or PNG |
| `width` | generations | integer | Minimum 768 |
| `height` | generations | integer | Minimum 768 |

Constraint: `width × height ≤ 1,048,576` (i.e. the 1024×1024 pixel budget), each
dimension ≥ 768. Either dimension may exceed 1024 if the product stays under the
cap — the page's own example of a valid non-square is **768×1365**.

Edits use **multipart form data**, not JSON.

### 1.3 What MAI has that gpt-image lacks, and vice versa

- **MAI lacks `n`.** No `n` parameter is documented, and
  [Foundry Models sold by Azure](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-sold-directly-by-azure)
  (`ms.date` **2026-08-26**) lists the output of every MAI-Image model as
  "Output: **One image**". One image per call.
- **MAI lacks `size`, `quality`, `style`, `background`, `response_format`,
  `output_format`.** None appear in the parameter table or any example.
- **MAI lacks a URL response mode.** "The output format is always PNG", and every
  example reads `data[0].b64_json`.
- **MAI has `width`/`height` as free integers**, which gpt-image does not — a
  genuinely more flexible aspect-ratio story within a fixed pixel budget.
- **MAI has a first-class edits endpoint** with identity/character preservation,
  which the repo has no abstraction for today.

Supported aspect ratios are therefore not an enumeration — anything from 768×768
up to the 1,048,576-pixel cap. Practical corners: 1024×1024 (1:1), 768×1365
(≈9:16), 1365×768 (≈16:9), 896×1152 (≈3:4).

### 1.4 Response

```json
{ "data": [ { "b64_json": "iVBORw0KG..." } ] }
```

Same shape the current `firstImage()` / `decodeBase64()` code already handles.
Always PNG, so the MIME sniffing stays correct and always lands on `image/png`.

### 1.5 Auth

Both modes, per the Learn page:

- **API key**: header `api-key: <key>` — identical to today.
- **Entra ID**: header `Authorization: Bearer <token>`, with the token issued for
  scope **`https://cognitiveservices.azure.com/.default`**.

The Learn page states this scope twice: once in the Python
`get_bearer_token_provider` example, and again in the Troubleshoot table under
`401 Unauthorized` ("ensure the token scope is
`https://cognitiveservices.azure.com/.default`").

**This conflicts with the repo.** `src/providers/azure.ts` exports
`AZURE_ENTRA_SCOPE = "https://ai.azure.com/.default"` citing research §2. Both
scopes are real Entra audiences and both are used by Foundry surfaces; the MAI
docs name only the `cognitiveservices` one. Treat the scope as
**per-API configurable** rather than a file-level constant. See risks (§7).

Deploying requires the **Cognitive Services Contributor** role on the Foundry
resource (same Learn page, Prerequisites).

---

## 2. Pricing

**MAI-Image is billed per token, not per image.** There is no per-image list
price anywhere in Microsoft's material.

Primary source: [Foundry Models Pricing — Microsoft models](https://azure.microsoft.com/en-us/pricing/details/ai-foundry-models/microsoft/),
read live in a browser 2026-09-04 (the table renders client-side, so a plain
fetch returns `$-` placeholders). Column headers are "Input (Per 1M tokens)",
"Cached Input (Per 1M tokens)", "Output (Per 1M tokens)".

| Model row on the page | Input | Cached input | Output |
| --- | --- | --- | --- |
| MAI-Image-2 Global | $5 | N/A | $33 |
| MAI-Image-2-Efficient Global | $5 | N/A | $19.50 |
| MAI-Image-2.5 | Text $5 / Image $8 | N/A | $47 |
| MAI-Image-2.5 Flash | Text $1.75 / Image $1.75 | N/A | $19.50 |
| MAI-Image-2.5 Pro Global | Text $5 / Image $8 | N/A | $106 |

**MAI-Image-2.6 and MAI-Image-2.6-Flash are not on the pricing page at all**
(checked 2026-09-04).

Corroborating Microsoft announcements (each states "pricing starts at"):

- MAI-Image-2-Efficient: $5 text in / $19.50 image out —
  [Foundry blog, 14 Apr 2026](https://techcommunity.microsoft.com/blog/azure-ai-foundry-blog/introducing-mai-image-2-efficient-faster-more-efficient-image-generation/4510918).
- MAI-Image-2.5: $5 text in / $8 image in / $47 image out. MAI-Image-2.5 Flash:
  $1.75 text and image in / **$33** image out —
  [Foundry blog, 2 Jun 2026, updated 12 Aug 2026](https://techcommunity.microsoft.com/blog/azure-ai-foundry-blog/new-mai-models-in-microsoft-foundry-across-text-image-voice-and-speech/4524632).
  Note the **discrepancy**: the blog says $33 for 2.5-Flash output, the live
  pricing page says $19.50. The pricing page is the newer and more authoritative
  of the two; read as a price cut since June.
- MAI-Image-2.5 Pro: $5 text in / $106 image out —
  [Foundry blog, 23 Jul 2026](https://techcommunity.microsoft.com/blog/azure-ai-foundry-blog/introducing-mai-image-2-5-pro-and-mai-voice-2-flash-in-microsoft-foundry/4539446).

### 2.1 EUR

**No EUR list price is published.** The `nl-nl` locale of the same pricing page
(read 2026-09-04) shows the identical figures with European decimal commas
(`$19,50`) but still in USD. Azure bills Foundry models in USD and converts at
the account's billing currency at invoice time; there is no published EUR rate
card for these models. Anything in EUR in `models.json` would be a made-up
conversion, so don't put one there.

### 2.2 Converting to a per-image number (the honest version)

`data/models.json` requires `price.per_image_usd` as a number. To produce one we
need image-output-tokens-per-image, which **Microsoft does not publish**.

The only figure available is third-party: a 1024×1024 image is billed at roughly
**1,024 image output tokens**, reported by
[tokencost.app](https://tokencost.app/blog/microsoft-mai-models-pricing) and
repeated by other aggregators (read 2026-09-04). It is weakly corroborated by
those same sources quoting "$0.034 per 1024×1024 image" for MAI-Image-2, which
is exactly `$33/1M × 1024` — internally consistent, but circular, since both
numbers likely come from the same derivation.

Under that assumption (1,024 output tokens per 1024×1024 image, plus a
negligible prompt cost):

| Model | Output $/1M | Derived $/image at 1024×1024 |
| --- | --- | --- |
| MAI-Image-2 | $33 | ~$0.034 |
| MAI-Image-2e | $19.50 | ~$0.020 |
| MAI-Image-2.5 | $47 | ~$0.048 |
| MAI-Image-2.5-Flash | $19.50 | ~$0.020 |
| MAI-Image-2.5-Pro | $106 | ~$0.109 |

For **2.6 and 2.6-Flash there is no published rate**, so any per-image number is
a proxy. The defensible proxy is the same-tier 2.5 model, since Microsoft has
priced each generation's standard and Flash tiers at the same points twice
running: **2.6 ≈ $0.048, 2.6-Flash ≈ $0.020**, both `confidence: "indicative"`
and both wrong the moment Microsoft publishes real rates.

**Verify against a real invoice line before trusting either number.** One
deployment plus one generation plus a look at Cost Management will settle
tokens-per-image definitively, and is cheaper than any amount of further
reading.

---

## 3. Quality positioning

### 3.1 Microsoft's own claims

[MAI-Image-2.6 launches at No. 2 on Arena](https://microsoft.ai/news/mai-image-2-6-launches-at-no-2-on-arena-ahead-of-google-meta-and-xai/),
Microsoft AI, published **10 Aug 2026**, updated **18 Aug 2026**:

- No. 2 on the Arena text-to-image leaderboard; No. 3 on image editing.
- **+79 Elo overall** over MAI-Image-2.5, with gains in every text-to-image
  category.
- **+91 Elo on text rendering** — the single largest improvement claimed.
- On editing: +19 overall, +43 text rendering, +38 product/branding/commercial.
- "Better portraits and 3D imagery", "more polished commercial and photorealistic
  outputs".
- Says the result puts MAI "ahead of leading models from Meta, Google and xAI" —
  note it conspicuously does **not** claim to beat OpenAI.
- Availability at time of writing: MAI Playground and **private preview** on
  Foundry.

The [Learn capability page](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/use-foundry-models-mai-image)
(2026-08-19) describes the 2.5 family's strengths as photorealistic synthesis;
product, branding and commercial design; high-fidelity portraits; accurate text
rendering ("labels, posters, packaging, and signage"); and visual reasoning over
scale and spatial position. The 2.5-Pro card adds object and character
consistency across scenes and material/physical-property accuracy.

The Flash line's positioning is explicit and consistent across two generations:
speed and cost, "fast, scalable production workloads", not maximum fidelity. For
2e Microsoft claimed "up to 22% faster with 4× more efficiency" versus
MAI-Image-2 and "outpaces leading text-to-image models by 40% on average"
(latency p50, tested 13 Apr 2026), and said to prefer non-Efficient MAI-Image-2
"when your images require precise, detailed text rendering". **Read that as the
standing Flash trade-off: Flash is where text rendering gets worse.**

### 3.2 The live leaderboard

Arena text-to-image leaderboard (arena.ai / lmarena.ai), read directly
**2026-09-04**:

| Rank | Model | Score | Votes |
| --- | --- | --- | --- |
| 1 | gpt-image-2 (medium) | 1382 ±4 | 77,830 |
| 2 | **mai-image-2.6** | **1332 ±7** | 10,086 |
| 3 | grok-imagine-image-2.0 (low) | 1315 ±12 (preliminary) | 2,682 |
| 4 | reve-2.1 | 1301 ±8 | 7,576 |
| 5 | Meta muse-image | 1279 ±6 | 24,856 |
| 7 | gemini-3.1-flash-image (nano-banana-2) | 1261 ±5 | 40,649 |
| 10 | **mai-image-2.5** | 1254 ±4 | 57,295 |
| 13 | gpt-image-1.5-high-fidelity | 1239 ±3 | 150,845 |
| 18 | **mai-image-2** | 1183 ±5 | 49,204 |
| 23 | flux-2-max | 1162 ±4 | 117,355 |
| 26 | **flux-2-pro** | 1154 ±3 | 186,907 |

Reading it straight:

- **MAI-Image-2.6 is genuinely the No. 2 text-to-image model on the board**, 50
  Elo behind `gpt-image-2` and ~71 ahead of Nano Banana 2. It is ~78 Elo ahead
  of `mai-image-2.5` — larger than Microsoft's own +79 claim would suggest
  against 2.5's current score, so the claim holds up.
- **It beats every model currently in `data/models.json` except `gpt-image-2`.**
  It is ~178 Elo above `flux-2-pro`, which the repo currently rates 5 on
  photoreal — that rating deserves revisiting, but that is issue #59's neighbour,
  not its job.
- The 10,086-vote count means the ±7 interval is wider than the established
  models'; the ranking is real but younger than the others.
- **`mai-image-2.6-flash` does not appear on the leaderboard at all** — not at
  any rank, under any spelling. Neither does `mai-image-2.5-flash`. Microsoft
  does not submit its Flash tiers to Arena.

### 3.3 Latency

There is **no Microsoft-published latency number** for any MAI-Image model.

The one measured figure I found: OpenRouter lists MAI-Image-2.5 at **end-to-end
P50 44.69s** with Azure as the upstream provider
([openrouter.ai/microsoft/mai-image-2.5](https://openrouter.ai/microsoft/mai-image-2.5),
read 2026-09-04). That is slow — roughly 4× the repo's 12s figure for
`gpt-image-2` — and it is one route's measurement of the previous generation,
not of 2.6 direct from Foundry.

Treat every latency number for MAI in `models.json` as an estimate anchored on
that single reading, and correct it the moment we have our own timings from a
live deployment.

---

## 4. Regions and quota

### 4.1 Regions

From the Learn how-to page (2026-08-19), MAI image models are available for
**Global Standard** deployment in:

> West Central US, East US, West US, West Europe, **Sweden Central**, South
> India, and UAE North.

The
[region availability table](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-sold-directly-by-azure-region-availability)
(`ms.date` **2026-08-21**) lists rows for `MAI-Image-2e` (2026-04-09),
`MAI-Image-2.5` (2026-06-02), `MAI-Image-2.5-Flash` (2026-06-02) and
`MAI-Image-2.5-Pro` (2026-06-19) — **and no row for MAI-Image-2.6 or
2.6-Flash**.

Sweden Central — the owner's region — is covered for the documented models.

### 4.2 Quota

From the "API quotas and limits" section of the Learn how-to page (2026-08-19).
The unit is **Requests Per Minute (RPM)**, and the tier is a property of the
subscription, not of the deployment SKU capacity:

| Deployment type | Tier | RPM (2.5-Pro / 2.5-Flash / 2.5, all identical) |
| --- | --- | --- |
| Global Standard | 0 (Free) | 0 |
| Global Standard | 1 | 2 |
| Global Standard | 2 | 4 |
| Global Standard | 3 | 6 |
| Global Standard | 4 | 8 |
| Global Standard | 5 | 10 |
| Global Standard | 6 | 12 |

Quota increases: <https://aka.ms/oai/stuquotarequest>.

**This is the answer to the capacity-1 429 problem we hit with `gpt-image-2`.**
The `gpt-image` quota unit is capacity-based and a capacity-1 deployment gave us
an allowance too small to demo against. MAI's documented floor is 2 RPM at tier
1 — thin, but usable for a single-user MCP server and for a live proof. Two
caveats: the table only covers the 2.5 family (nothing published for 2.6), and
"the tier available to you depends on your subscription", so a pay-as-you-go
subscription may land at tier 1 and no higher without a request.

The Learn troubleshooting table maps errors the way `azure.ts` already does:
401 = bad key/expired token/wrong scope, 404 = wrong deployment name or endpoint,
400 = width/height violating the pixel rules, 429 = rate limit. The existing
`mapStatus` needs no change; the 404 hint text stays accurate.

---

## 5. What is unknown or unverifiable

Stated plainly, because guessing here is how a curation file starts lying.

1. **Everything specific to MAI-Image-2.6 and 2.6-Flash on Foundry.** No Learn
   page, no region table row, no pricing row, no model card PDF, no catalog page
   that renders. The Microsoft AI announcement (10 Aug 2026) says 2.6 is in
   *private preview* on Foundry. The control plane in swedencentral offers both
   (per `az cognitiveservices model list`, 2026-09-04) — so the platform is ahead
   of the documentation, which is normal for a preview, but it means we would be
   deploying a model whose contract is documented only for its predecessor.
2. **MAI-Image-2.6-Flash has no public existence whatsoever.** Not in any
   Microsoft announcement, not on Arena, not on the pricing page, not in a
   third-party write-up. Its version stamp (2026-07-31) matching 2.6's is the
   only thing we know about it. Whether it supports edits, how fast it is, what
   it costs, how good it is — all unknown.
3. **Whether 2.6 keeps the 2.5 wire contract.** The `/mai/v1/` path is versioned
   `v1` and the parameter set is minimal, so continuity is the reasonable bet,
   but the announcement's phrase "greater control over reasoning, format and
   resolution" hints at *new parameters*. If 2.6 adds parameters, the
   pixel-budget cap may also have moved. Unverified.
4. **Tokens per image.** Not published by Microsoft. See §2.2 — every per-image
   price in this document is derived from a third-party figure.
5. **Whether `/mai/v1/` accepts or requires an `api-version`.** No Microsoft
   example includes one and I found no REST reference page for the path. "No
   api-version" is inference from consistent absence.
6. **Which Entra scope actually works.** Learn says
   `https://cognitiveservices.azure.com/.default` for MAI; the repo currently
   uses `https://ai.azure.com/.default` for gpt-image. I did not find a page
   stating whether one token is accepted at both surfaces.
7. **Latency of anything.** No first-party number exists. §3.3's 44.69s is one
   third-party P50 for the previous generation over a different route.
8. **Whether `n > 1` is silently accepted.** Docs say one image out and list no
   `n`; whether the endpoint 400s on an extra field or ignores it is untested.
9. **Content filtering vocabulary.** Whether MAI returns the same
   `content_filter` / `ResponsibleAIPolicyViolation` error codes `azure.ts`
   pattern-matches on. The Responsible AI section says filters exist; it does not
   name the error codes.

Items 1–3 and 6–8 are all settled by one deployment and a handful of calls. That
should happen before any of this is curated as fact.

---

## 6. Proposals

### (a) Proposed `data/models.json` entries

Every score below is an editorial judgement with the evidence that justifies it
named inline. Scores where the evidence is thin are marked; they are the ones to
revisit after hands-on testing.

```json
{
  "id": "mai-image-2.6",
  "display_name": "MAI-Image 2.6",
  "family": "microsoft",
  "leaderboard": {
    "source": "public image arena",
    "rank_band": "top-3",
    "checked": "2026-09-04"
  },
  "strengths": {
    "text_in_image": 4,
    "photoreal": 5,
    "illustration": 4,
    "diagram": 3,
    "fast_bulk": 2
  },
  "typical_latency_s": 40,
  "price": {
    "per_image_usd": 0.048,
    "per_image_usd_4k": null,
    "confidence": "indicative",
    "checked": "2026-09-04"
  },
  "availability": [
    {
      "provider": "azure",
      "model_ref": "MAI-Image-2.6",
      "note": "Preview, and undocumented at 2.6 — the Learn how-to covers the 2.5 family only. Reached over the MAI API (POST /mai/v1/images/generations on the services.ai.azure.com host) with the deployment name in the body as `model`, not in the URL path. One image per call; width/height instead of size."
    }
  ],
  "max_size": "1024x1024",
  "notes": "The strongest model here after GPT Image 2, and the only one that comes with an Entra-governed Azure endpoint of its own — pick it for photoreal, product and brand imagery inside an organisation that wants the whole pipeline in its own tenant. Do not pick it for bulk or for anything interactive: one image per call, no batching, and the only latency figure anyone publishes for the previous generation is about 45 seconds. Do not pick it when the output has to be larger than about a megapixel either — width x height is capped at 1,048,576, so 1024x1024 is the ceiling and there is no 4K tier. Price is a derived estimate, not a Microsoft list price."
},
{
  "id": "mai-image-2.6-flash",
  "display_name": "MAI-Image 2.6 Flash",
  "family": "microsoft",
  "leaderboard": null,
  "strengths": {
    "text_in_image": 3,
    "photoreal": 4,
    "illustration": 4,
    "diagram": 3,
    "fast_bulk": 4
  },
  "typical_latency_s": 15,
  "price": {
    "per_image_usd": 0.02,
    "per_image_usd_4k": null,
    "confidence": "indicative",
    "checked": "2026-09-04"
  },
  "availability": [
    {
      "provider": "azure",
      "model_ref": "MAI-Image-2.6-Flash",
      "note": "Offered by the control plane in swedencentral but absent from every public Microsoft source — no docs page, no pricing row, no leaderboard entry. Same MAI API shape as MAI-Image-2.6, assumed rather than confirmed."
    }
  ],
  "max_size": "1024x1024",
  "notes": "The cheap, fast half of the Azure-native pair: pick it when the work is high-volume and the images are illustrative rather than load-bearing, and you still want everything inside your own tenant. Do not pick it when words must be legible — Microsoft's own guidance for every previous Flash tier is to step back up to the full model for precise text rendering. Do not pick it on the strength of these numbers either: nothing about this model is published, so every score, the price and the latency are extrapolations from MAI-Image-2.5-Flash."
}
```

Justification for each score:

| Score | Value | Why |
| --- | --- | --- |
| 2.6 `text_in_image` | 4 | Microsoft claims +91 Elo on text rendering over 2.5, its largest single gain (microsoft.ai, 10 Aug 2026), and Learn names labels/posters/packaging/signage as a strength. Not a 5: `gpt-image-2` still leads the board overall by 50 Elo and holds the repo's 5, and no category-level board confirms MAI passing it on text. |
| 2.6 `photoreal` | 5 | Arena #2 at 1332, ~178 Elo above `flux-2-pro` which currently holds the repo's photoreal 5. Microsoft's positioning is explicitly photorealistic/commercial/product. This score implies `flux-2-pro`'s 5 should be re-examined. |
| 2.6 `illustration` | 4 | Announcement claims gains "across every category" incl. 3D imagery; no evidence it beats Nano Banana's 5, which is 71 Elo below it overall but rated on illustration specifically. |
| 2.6 `diagram` | 3 | No Microsoft or leaderboard evidence about diagram-like structured output at all. 3 is the honest "unproven" middle, not a measured claim. |
| 2.6 `fast_bulk` | 2 | One image per call (Learn, 2026-08-26 "Output: One image"), no `n`, 2 RPM at tier 1, and a ~45s P50 for the prior generation. Structurally the worst bulk story of anything curated. |
| 2.6-Flash `text_in_image` | 3 | Microsoft's own 2e guidance says step up to the full model "when your images require precise, detailed text rendering" (Foundry blog, 14 Apr 2026) — the standing Flash trade-off. |
| 2.6-Flash `photoreal` | 4 | Same family and architecture, tuned for throughput; one below the full model by Microsoft's own fidelity-vs-speed framing. Extrapolation, not evidence. |
| 2.6-Flash `fast_bulk` | 4 | Flash tier priced at ~40% of the standard tier and marketed for "fast, scalable production workloads" (2 Jun 2026). Not 5: still one image per call and still the same 2 RPM ceiling, which is what actually caps bulk here. |
| Both `typical_latency_s` | 40 / 15 | Anchored on OpenRouter's 44.69s P50 for MAI-Image-2.5, discounted for the generational improvement and the Flash tier. **Guesses.** Replace with measurements. |
| Both `max_size` | `1024x1024` | The pixel budget is 1,048,576, so 1024x1024 is the largest square. Non-square shapes up to 768x1365 are legal but `max_size` is a single string. |

Also worth doing while the file is open: `updated` moves to `2026-09-04`, and the
disclaimer's "prices are indicative list prices per image" line should
acknowledge that some entries are per-token prices converted with an unverified
token count.

### (b) Deployment command

```powershell
az cognitiveservices account deployment create `
  --name <ACCOUNT_NAME> `
  --resource-group <RESOURCE_GROUP> `
  --deployment-name mai-image-2-6 `
  --model-name "MAI-Image-2.6" `
  --model-format Microsoft `
  --model-version 2026-07-31 `
  --sku-name GlobalStandard `
  --sku-capacity 1
```

And for Flash:

```powershell
az cognitiveservices account deployment create `
  --name <ACCOUNT_NAME> `
  --resource-group <RESOURCE_GROUP> `
  --deployment-name mai-image-2-6-flash `
  --model-name "MAI-Image-2.6-Flash" `
  --model-format Microsoft `
  --model-version 2026-07-31 `
  --sku-name GlobalStandard `
  --sku-capacity 1
```

Shape taken verbatim from the Learn how-to's own example (which deploys
`MAI-Image-2.5` / `2026-06-02`); model names and versions from the issue's
`az cognitiveservices model list` output of 2026-09-04. Requires **Cognitive
Services Contributor** on the resource. If 2.6 is still gated behind private
preview for this subscription, expect the create to fail rather than to silently
deploy something else — in which case fall back to `MAI-Image-2.5` /
`2026-06-02`, which is fully documented and priced, and curate that instead.

### (c) Does `src/providers/azure.ts` need a code change?

**Yes. A deployments-mapping entry is not enough, and would fail twice over.**

Concretely, four things in the current adapter are wrong for MAI:

1. **Host.** `#endpoint` is one value for the whole adapter, documented as
   `https://my-resource.openai.azure.com`. MAI needs
   `https://<resource>.services.ai.azure.com`.
2. **URL construction.** `#send()` hard-codes
   `/openai/deployments/{deployment}/images/generations?api-version=...`. MAI
   needs `/mai/v1/images/generations` with no query string.
3. **Body.** `buildGenerateBody()` deliberately omits `model` and sends `size`
   and `n`. MAI requires `model` (the deployment name), rejects `size`, and
   documents no `n`. `width`/`height` must be derived from the requested size and
   clamped to ≥768 each and ≤1,048,576 product.
4. **Entra scope.** The file-level `AZURE_ENTRA_SCOPE` constant must become a
   per-variant value: `cognitiveservices.azure.com` for MAI.

What does *not* need to change: auth header handling, the base64/`data[0].b64_json`
decode path, MIME sniffing, `mapStatus`, the content-filter detection, and the
404 hint text — all of those remain correct.

Recommended shape, following the issue's own instruction and the LiteLLM lesson:
a **variant inside `azure.ts`** — a small "wire dialect" seam (`openai` | `mai`)
selected per deployment entry, with both dialects pinned by
`test/contract/azure-request.test.ts`. Adding a second contract test that asserts
the MAI dialect puts `model` in the *body* and *not* in the path — the mirror
image of the existing assertion — is the single most valuable artefact this issue
can produce, because it makes the difference impossible to lose later.

The config surface then needs a way to say which dialect a deployment speaks.
The least surprising option is to widen `providers.azure.deployments` values from
a bare string to `string | { deployment, dialect, endpoint? }`, keeping the
string form meaning "openai dialect" so nothing existing breaks. That is an ADR
0014 amendment and should be written up as one.

### (d) Risks

1. **We would ship a preview model whose contract is documented only for its
   predecessor.** 2.6 has no Learn page. If its parameters differ from 2.5, our
   adapter is wrong and we find out in production. *Mitigation: deploy
   `MAI-Image-2.5` first, verify the documented contract end to end, and only then
   point the same dialect at 2.6.*
2. **2.6-Flash is entirely unevidenced.** Curating it means publishing five
   strength scores, a price and a latency that are all extrapolation. A
   recommendation engine that confidently recommends a model nobody has measured
   is worse than one that does not list it. *Mitigation: either omit 2.6-Flash
   until it is deployed and tested, or ship `MAI-Image-2.5-Flash` instead, which
   is documented, priced and region-listed.*
3. **The price is derived from a third-party token count.** If tokens-per-image
   is not 1,024, every MAI price in `models.json` is wrong by that ratio, and the
   router will make cost decisions on it. *Mitigation: verify against a real
   billing line before merging; until then keep `confidence: "indicative"` and
   say so in the notes, which the proposed entries do.*
4. **The Entra scope conflict could break the keyless path.** The container
   identity currently requests `https://ai.azure.com/.default`. If MAI rejects
   that audience, the whole "keyless already works" premise of the issue's step 4
   fails at the last moment. *Mitigation: test the token exchange before writing
   the adapter; it is a two-minute `az account get-access-token --scope ...` plus
   one curl.*
5. **2 RPM is very thin.** Fine for one person demoing; instantly a 429 for
   anything concurrent, or for a retry loop. The repo already has a
   capacity-1 429 scar from `gpt-image-2`. *Mitigation: request a quota increase
   at the same time as the deployment, and make sure the 429 path surfaces a
   message that names RPM rather than looking like a transient blip.*
6. **~45 seconds per image, if the prior generation is any guide, exceeds what
   an MCP client will sit through.** The adapter's default 120s timeout covers it
   but a chat client may not. *Mitigation: measure first; if it is really that
   slow, that belongs prominently in the `notes` field and in what
   `recommend_model` says, because it changes when you would ever pick this.*
7. **A second wire dialect doubles the Azure surface area permanently.** Every
   future Azure change now has two paths to get right. *Mitigation: the contract
   tests, and keeping the dialect seam as small as possible — URL builder, body
   builder, scope. Nothing else should branch.*
8. **Preview terms.** MAI image models are public preview (2.5) or private
   preview (2.6): no SLA, and Microsoft explicitly does not recommend them for
   production. That is fine for this repo's purposes but should be visible in
   the model notes, not buried here.
9. **Curating 2.6 exposes that `flux-2-pro`'s photoreal 5 is now hard to
   defend** — it sits 178 Elo below 2.6 on the same board. Adding MAI without
   revisiting that makes the file internally inconsistent. *Mitigation: a
   follow-up issue to re-baseline the existing scores against the 2026-09-04
   board; do not quietly change them inside this one.*

---

## Sources

- [Deploy and use MAI image models in Microsoft Foundry](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/use-foundry-models-mai-image) — Microsoft Learn, ms.date 2026-08-19, updated 2026-08-28
- [Foundry Models sold by Azure](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-sold-directly-by-azure) — Microsoft Learn, ms.date 2026-08-26
- [Region availability for Foundry Models sold by Azure](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-sold-directly-by-azure-region-availability) — Microsoft Learn, ms.date 2026-08-21
- [Foundry Models Pricing — Microsoft models](https://azure.microsoft.com/en-us/pricing/details/ai-foundry-models/microsoft/) — Azure pricing, read 2026-09-04
- [MAI-Image-2.6 launches at No. 2 on Arena](https://microsoft.ai/news/mai-image-2-6-launches-at-no-2-on-arena-ahead-of-google-meta-and-xai/) — Microsoft AI, 2026-08-10, updated 2026-08-18
- [Introducing MAI-Image-2.5 Pro and MAI-Voice-2 Flash in Microsoft Foundry](https://techcommunity.microsoft.com/blog/azure-ai-foundry-blog/introducing-mai-image-2-5-pro-and-mai-voice-2-flash-in-microsoft-foundry/4539446) — Foundry blog, 2026-07-23
- [New MAI models in Microsoft Foundry across text, image, voice, and speech](https://techcommunity.microsoft.com/blog/azure-ai-foundry-blog/new-mai-models-in-microsoft-foundry-across-text-image-voice-and-speech/4524632) — Foundry blog, 2026-06-02, updated 2026-08-12
- [Introducing MAI-Image-2-Efficient](https://techcommunity.microsoft.com/blog/azure-ai-foundry-blog/introducing-mai-image-2-efficient-faster-more-efficient-image-generation/4510918) — Foundry blog, 2026-04-14
- [Arena text-to-image leaderboard](https://lmarena.ai/leaderboard/text-to-image) — read 2026-09-04
- [OpenRouter: microsoft/mai-image-2.5](https://openrouter.ai/microsoft/mai-image-2.5) — read 2026-09-04 (third party; latency P50)
- [tokencost.app: Microsoft MAI model pricing](https://tokencost.app/blog/microsoft-mai-models-pricing) — read 2026-09-04 (third party; tokens-per-image, unverified)
