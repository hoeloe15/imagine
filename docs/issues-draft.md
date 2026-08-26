# Draft GitHub issues

Ready to create with `gh issue create`. Each issue below has a title, a body, and
suggested labels. Bodies are written to stand on their own — someone picking one
up should not need this document for context.

Suggested milestones:

- **Phase 1 — local MVP** (issues 1–14)
- **Phase 2 — local portal** (issues 15–19)
- **Phase 3 — Azure deployment** (issues 20–24)
- **Ongoing** (issues 25–28)

Phase 1 is deliberately fine-grained — those issues are meant to be picked up and
finished. Phase 2 and 3 are epics; they get broken down when their phase starts.

Suggested labels to create first: `phase-1`, `phase-2`, `phase-3`, `epic`,
`provider`, `mcp-tool`, `core`, `docs`, `data`, `infra`, `research`.

---

# Milestone: Phase 1 — local MVP

## 1. Scaffold the TypeScript package and `npx` entry point

**Labels:** `phase-1`, `core`

**Body:**

Set up the repository so `npx <package>` starts a working (empty) MCP server over
stdio.

- TypeScript, Node, ESM
- `bin` entry pointing at the built `src/index.ts`
- Build (`tsc` or `tsup`), lint, format, and a test runner (`vitest`)
- CI: build + test on push and PR
- Directory skeleton per PLAN.md §8:
  `src/mcp/`, `src/core/`, `src/providers/`, `data/`, `schema/`, `test/`

**Package name is decided:** `imagine-mcp` (verified free on npm, 2026-08-25).
Claim the name as part of this issue. The binary name stays `imagine`.

**Done when:** `npx imagine-mcp` starts, speaks MCP over stdio, responds to a
`tools/list` request with an empty list, and exits cleanly. CI is green.

---

## 2. Define the internal normalised request/response types

**Labels:** `phase-1`, `core`

**Body:**

Define the types that flow between the MCP layer, the core router and the
provider adapters. These are the spine of the codebase; getting them right early
prevents provider details leaking upward.

- `NormalisedRequest`: prompt, size, style, use_case, provider_hint, output_dir
- `NormalisedResult`: **raw image bytes** plus metadata (provider, model,
  reported cost if any, duration, actual width/height, mime type)
- `ProviderModel`: id, display name, capabilities as reported by the provider
- Error type: reason code, message, retryable flag, whether it was billed

Explicit rule to encode here: `NormalisedResult` carries **bytes, not base64 and
not a file path**. Adapters decode; `core/output.ts` writes.

**Done when:** types exist with doc comments, and a stub provider implements the
`ImageProvider` interface against them.

---

## 3. Config loading, merging and validation

**Labels:** `phase-1`, `core`

**Body:**

Implement config loading per PLAN.md §7.

- Load `./config.json`, then `~/.imagine/config.json`, then defaults — merged with
  the most specific winning
- Load a `.env` next to the config if present
- Resolve API keys from the env var **named** in the config (`api_key_env`).
  Keys are never read from or written to the config file.
- Validate against a JSON Schema in `schema/config.schema.json`
- Clear, actionable errors: which file, which field, what was expected
- **Zero-config path:** with no config file and only `OPENROUTER_API_KEY` in the
  environment, the server must start with sensible defaults and work

**Done when:** unit tests cover merge precedence, env resolution, validation
failures, and the zero-config path. A key value never appears in any log line.

---

## 4. Curated model knowledge: `data/models.json` v1

**Labels:** `phase-1`, `data`

**Body:**

Create `data/models.json` following the schema in PLAN.md §6, with v1 entries for:

- `gpt-image-2`
- `gemini-3.1-flash-image` (Nano Banana)
- `grok-imagine-image-2.0`
- `flux-2-pro`

Each entry needs strengths scored 1–5 across `text_in_image`, `photoreal`,
`illustration`, `diagram`, `fast_bulk`; indicative price per image; availability
per provider; and a `notes` field explaining when to pick it and when not to.

Prices are indicative and must be marked as such — the file carries a
`disclaimer` and each price carries a `confidence` and a `checked` date.

Also implement `src/core/knowledge.ts`: load the file, validate it, and expose
query helpers (best model for a use case, models available given a config,
price lookup).

**Done when:** the file validates against its schema, the loader has unit tests,
and `knowledge.ts` can answer "best model for use case X, restricted to
providers Y and Z".

---

## 5. Core router: model selection and fallback

**Labels:** `phase-1`, `core`

**Body:**

Implement `src/core/router.ts` — the piece that turns a `NormalisedRequest` into
a concrete (provider, model) pair.

Selection order:
1. `provider_hint`, if given and available — **a hint, not a contract**
2. `use_case` matched against `models.json`, restricted to configured providers
3. `default.model` from config
4. Bundled default

Requirements:
- When a hint cannot be honoured, fall back **and say so** in the result
  metadata. Never silently pretend the hint was used.
- Populate `selection_reason` in the result so the client can see the reasoning.
- Retry transient failures once against the same provider; on persistent failure
  try the next viable provider if one exists, and report the fallback.

**Done when:** unit tests cover each selection path, unavailable-hint fallback,
and provider failover — all against stub providers with no network.

---

## 6. Output writer: decode, name, write, manifest

**Labels:** `phase-1`, `core`

**Body:**

Implement `src/core/output.ts`. This is the only place in the codebase that
writes image files.

- Take raw bytes from a `NormalisedResult` and write them to disk
- Honour `output_dir` from the request exactly when given; otherwise use
  `output.dir` from config; create the directory if needed
- Filename from the config template, default `{slug}-{hash}.{ext}`, where `slug`
  is derived from the prompt and `hash` is a short content hash. Never collide,
  never overwrite.
- Append a record to the manifest (JSONL) with prompt, model, provider, cost,
  dimensions, timestamp and path — this is what the phase 2 gallery reads
- Sanitise paths: reject traversal, handle Windows and POSIX separators

**Done when:** unit tests cover naming, collisions, directory creation, path
sanitisation and manifest append. A cross-platform path test is included.

---

## 7. Cost ledger and budget limits

**Labels:** `phase-1`, `core`

**Body:**

Implement `src/core/budget.ts`.

- Record every generation's cost to `costs.jsonl`
- Prefer the provider-reported cost (OpenRouter returns `usage.cost`) over the
  estimate in `models.json`; record which source was used
- Track spend per session (one server process) and per day
- Enforce `budget.max_usd_per_session` and `max_usd_per_day`; the tighter limit
  wins
- `on_exceed: "refuse"` returns a structured error stating the limit, the amount
  spent and when it resets. `on_exceed: "warn"` proceeds but flags it in the
  response. Never stall silently.
- A failed generation that was not billed must not count against the budget

**Done when:** unit tests cover accumulation, both limit types, both `on_exceed`
modes, day rollover, and unbilled failures.

---

## 8. Provider adapter: OpenRouter

**Labels:** `phase-1`, `provider`

**Body:**

Implement `src/providers/openrouter.ts` against the `ImageProvider` interface.

- `POST https://openrouter.ai/api/v1/images` with `model` and `prompt`
- Parse `data[].b64_json` and `media_type`; decode to bytes in the adapter
- Read `usage.cost` and pass it up as the authoritative cost
- Model discovery via `GET /api/v1/images/models` (fallback:
  `GET /api/v1/models?output_modalities=image`)
- Map size to whatever this API accepts; report the actual dimensions back
- Error mapping: rate limit, content filter, auth failure, transient 5xx — each
  to a reason code with a correct `retryable` flag. Failed generations are not
  billed here.

This is the primary MVP provider and the zero-config default. See
`docs/research/providers-2026-08.md` §1.

**Done when:** contract tests pass against recorded fixtures, and a manual live
run with a real key produces a file on disk.

---

## 9. Provider adapter: Azure OpenAI

**Labels:** `phase-1`, `provider`

**Body:**

Implement `src/providers/azure.ts`.

- `POST https://<resource>.openai.azure.com/openai/deployments/<deployment>/images/generations?api-version=<version>`
- **The deployment name goes in the URL path and must NOT appear as a `model`
  field in the body.** This is the exact bug that broke LiteLLM repeatedly
  (issues #26316, #23709) — add a contract test that asserts the request body
  contains no `model` key.
- Resolve the deployment name from `providers.azure.deployments[modelId]` in
  config
- Support both auth modes: `api-key` header, and Entra ID bearer via
  `DefaultAzureCredential` with scope `https://ai.azure.com/.default`. Entra is
  the default.
- Response is always `b64_json`; `response_format` is not supported for the
  gpt-image series — do not send it
- Map errors, including content-filter rejections, which Azure applies more
  strictly than some other providers

See `docs/research/providers-2026-08.md` §2.

**Done when:** contract tests pass, including the "no `model` in body" assertion
and both auth paths. Manual live run against a real deployment succeeds.

---

## 10. MCP tool: `generate_image`

**Labels:** `phase-1`, `mcp-tool`

**Body:**

Implement `src/mcp/tools/generate-image.ts` per PLAN.md §5.1.

Parameters: `prompt` (required), `size`, `style`, `use_case`, `provider_hint`,
`output_dir`.

Returns: `path`, `provider`, `model`, `cost_usd`, `duration_ms`, `width`,
`height`, `selection_reason`, `budget`.

Hard requirement: **no base64 anywhere in the tool result.** Add a dedicated
regression test asserting that the serialised result contains no base64 payload —
this is the invariant most likely to be broken by a careless change later.

The tool file should contain protocol wiring and validation only. All routing
logic lives in the core.

**Done when:** the tool is registered, an end-to-end test against a stub provider
writes a real file and returns its path, and the no-base64 test passes.

---

## 11. MCP tool: `list_capabilities`

**Labels:** `phase-1`, `mcp-tool`

**Body:**

Implement `src/mcp/tools/list-capabilities.ts` per PLAN.md §5.2.

Returns, per provider: status (`ready` / `not_configured` / `error`), the models
reachable through it, and — when not configured — which environment variables are
missing. Plus the default model, known use-case tags, current budget state, and
`knowledge_updated` (the `updated` date from `models.json`) so the client can
judge how stale the curated data is.

Where a provider supports live model discovery (OpenRouter), use it and cache the
result for the process lifetime rather than relying solely on `models.json`.

Must never include a key value, or enough of one to be useful.

**Done when:** the tool returns accurate output for a config with a mix of
configured and unconfigured providers, verified by test.

---

## 12. MCP tool: `recommend_model`

**Labels:** `phase-1`, `mcp-tool`

**Body:**

Implement `src/mcp/tools/recommend-model.ts` and `src/core/recommend.ts` per
PLAN.md §5.3.

Parameters: `use_case`, `budget_hint` (both optional).

Returns `best_overall`, `best_configured`, `cheaper_alternative` with its explicit
trade-off, a cost `estimate`, a plain-language `recommendation`, and
`note_on_unconfigured`.

Two behaviours that matter more than the shape:

1. When the best model for a use case is **not** configured, say so and name what
   would unlock it — e.g. "an OpenRouter key would give you X, Y and Z with one
   credential."
2. When `budget_hint` implies volume ("20 images for a deck"), the recommendation
   must weigh cost honestly and be willing to recommend the cheap model. A
   recommender that always names the most expensive model is not trusted twice.

Parse a count out of `budget_hint` where one is present; state the assumed count
in the response so a wrong parse is visible rather than silent.

**Done when:** unit tests cover: best-is-configured, best-is-not-configured,
volume implies cheap, and no-arguments (general answer).

---

## 13. README and quickstart

**Labels:** `phase-1`, `docs`

**Body:**

Replace the placeholder README with real getting-started documentation once the
MVP works.

- What it is, in one paragraph
- Install / run: the `npx` line, and the JSON snippet to paste into a client's
  MCP config
- The zero-config path first: one OpenRouter key, nothing else
- Azure setup as a second section, including the deployment-name mapping and
  Entra auth
- The three tools with a short example each
- A cost section: how pricing is reported, how budgets work
- Troubleshooting: key not found, provider not configured, budget exceeded,
  content filtered

No overpromising. Features that do not exist yet are labelled as planned.

**Done when:** someone who has never seen the repo can follow it from zero to a
generated image without asking a question.

---

## 14. End-to-end demo: Claude builds a deck with generated images

**Labels:** `phase-1`, `docs`

**Body:**

The phase 1 definition of done, as a reproducible demo.

- A short prompt/script that has an MCP client build a PowerPoint via
  `python-pptx`, calling `generate_image` for illustrations along the way and
  placing the returned paths into slides
- Capture the resulting `.pptx`, the generated images, and the cost log
- Verify no base64 appears anywhere in the transcript
- Write it up in `docs/demo.md`; this is also the phase 1 blog material

**Done when:** the demo runs start to finish with only an OpenRouter key
configured, and the deck contains real images.

---

# Milestone: Phase 2 — local portal

## 15. EPIC: local web portal (`imagine ui`)

**Labels:** `phase-2`, `epic`

**Body:**

A localhost web UI served by the same npm package, for people who want to see and
manage what the router has been doing. Not required for the MCP server to work —
it must remain fully optional.

Scope covered by the issues in this milestone: key management, gallery, search
and filtering, budget view. To be broken down further at the start of phase 2.

**Done when:** `imagine ui` starts a local server, and issues 16–19 are complete.

---

## 16. EPIC: key management in the portal

**Labels:** `phase-2`, `epic`

**Body:**

See which providers are configured, add or remove keys, and test a key with a
real call before saving.

Constraint carried over from phase 1: keys still live in environment variables or
an OS keychain, never in a plaintext config file the user might commit. The
portal writes the env-var reference and helps the user set the value — it does
not turn the config into a secret store. Decide how "helps the user set the
value" works on each OS as part of this epic.

---

## 17. EPIC: image library and gallery

**Labels:** `phase-2`, `epic`

**Body:**

Browse everything ever generated: thumbnail grid, click through to full image,
see the prompt, model, provider, cost, dimensions and timestamp, and copy the
file path.

Reads the manifest written in phase 1 (issue #6).

Open question to resolve here: thumbnail strategy — generate on write (fast
browsing, more disk, wasted work for images never viewed) or on demand with a
cache (lazier, first-scroll stutter). See PLAN.md Open questions.

---

## 18. EPIC: search and filtering over the library

**Labels:** `phase-2`, `epic`

**Body:**

Filter the gallery by date range, model, provider, cost, and free-text search
over prompts.

Storage decision: start with the JSONL manifest for greppability and
diff-friendliness. If filtering over a realistic library (thousands of images)
gets slow, migrate to SQLite behind the same interface. Measure before migrating.

**Done when:** you can find an image you made last week by typing part of its
prompt, on a library of a few thousand entries, without a noticeable wait.

---

## 19. EPIC: budget and spend view

**Labels:** `phase-2`, `epic`

**Body:**

Visualise the cost log: spend per day, per model, per provider. Show current
limits and how close you are to them. Surface the honest comparison — what this
month would have cost on the expensive model versus what it did cost.

---

# Milestone: Phase 3 — Azure deployment

## 20. EPIC: `azd up` template

**Labels:** `phase-3`, `epic`, `infra`

**Body:**

An `azd`-deployable template that provisions the whole thing into a user's own
Azure subscription: Container Apps, Key Vault, Blob Storage, Entra app
registrations, and the necessary role assignments.

**Done when:** `azd up` in a clean subscription produces a working, authenticated
deployment with no manual portal steps.

---

## 21. EPIC: Container Apps hosting for MCP endpoint and portal

**Labels:** `phase-3`, `epic`, `infra`

**Body:**

Host both the MCP endpoint (HTTP transport rather than stdio) and the phase 2
portal on Azure Container Apps.

Requires an HTTP/SSE MCP transport alongside the existing stdio transport —
scoped as part of this epic. The core router must not change.

---

## 22. EPIC: Key Vault for provider credentials

**Labels:** `phase-3`, `epic`, `infra`

**Body:**

Provider API keys live in Key Vault; the container reads them via managed
identity. No provider key ever lands on a user's machine, and none appears in
container configuration.

---

## 23. EPIC: Entra ID authentication on the MCP endpoint and portal

**Labels:** `phase-3`, `epic`, `infra`

**Body:**

Both the MCP endpoint and the portal require Entra ID authentication. Access is
governed by the tenant, not by whoever has the URL.

This is the differentiating part of phase 3 and the main blog material for it —
most MCP deployment write-ups stop before authentication.

---

## 24. EPIC: Blob Storage output sink

**Labels:** `phase-3`, `epic`, `infra`

**Body:**

Swap the output sink from local disk to Azure Blob Storage. `path` in the tool
result becomes a URL.

Constraint unchanged: base64 still never reaches the client. The server decodes,
uploads, and returns a URL.

The portal code from phase 2 must run unmodified against the new backend — only
the storage adapter changes. If the portal needs changes, the phase 2 abstraction
was wrong and that is the actual bug to fix.

---

# Milestone: Ongoing

## 25. Weekly refresh of `data/models.json`

**Labels:** `data`

**Body:**

Recurring task: review public leaderboards and provider pricing pages, update
scores, prices and availability in `data/models.json`, and bump `updated`.

Keep it honest — if a score has not actually been re-checked, do not touch its
`checked` date.

---

## 26. GitHub Action: propose `models.json` updates via PR

**Labels:** `data`, `infra`

**Body:**

Automate the mechanical half of issue #25. A scheduled workflow checks public
leaderboards and pricing pages and **opens a pull request** with proposed diffs.

**A PR, never a direct commit.** Editorial scores need a human eye, and an
automated commit that silently changes what the router recommends is exactly the
failure mode this project exists to avoid.

The PR body should show what changed and cite where each number came from.

---

## 27. Verify the Google Gemini image endpoint shape

**Labels:** `research`, `provider`

**Body:**

Blocks the Google adapter.

Research found `POST https://generativelanguage.googleapis.com/v1beta/interactions`
(auth `x-goog-api-key`, image bytes at `interaction.output_image.data`) alongside
the classic `generateContent` path. It is unclear whether the new form supersedes
`generateContent`, sits alongside it, or applies only to certain models.

Verify against a live key, then write `src/providers/google.ts`. Low urgency:
OpenRouter reaches the same models in the meantime.

**Done when:** the correct endpoint shape is confirmed and documented in
`docs/research/`, and the adapter is implemented with contract tests.

---

## 28. Provider adapter: xAI Grok

**Labels:** `provider`

**Body:**

Implement `src/providers/xai.ts`.

- `POST https://api.x.ai/v1/images/generations`, OpenAI-SDK-compatible — the
  cheapest of the four adapters to write
- Model e.g. `grok-imagine-image-2.0`; up to 10 outputs per call
- **No `quality`, `size` or `style` parameters** — aspect ratio plus resolution
  instead. This is the concrete case that forces the size-normalisation rule:
  map the router's requested size to the nearest supported aspect ratio and
  resolution, and report the actual output dimensions in the result.

See `docs/research/providers-2026-08.md` §4.

**Done when:** contract tests pass, size normalisation is covered by tests, and a
manual live run succeeds.
