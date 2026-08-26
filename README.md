# imagine

A capability router for image generation, exposed as an MCP server. AI clients
like Claude Code, Codex and Cursor can generate images through one stable tool
interface while the providers behind it — Azure OpenAI, OpenRouter, Google
Gemini, xAI — stay swappable. It ships with curated, regularly updated knowledge
about which image model is good at what and what it costs, so the client can pick
deliberately instead of relying on a choice hard-coded months ago. Generated
images are written to disk and returned as a file path, never as base64 in the
tool result.

## Status

**Early development, but usable end to end.** The server speaks MCP over stdio
and exposes all three tools: `generate_image` routes a prompt to a configured
provider, writes the image to disk and returns its path, what it cost and why
that model was chosen; `list_capabilities` reports what this installation can
actually reach right now; `recommend_model` gives advice before you spend
anything.

What is **not** there yet:

- **Only the OpenRouter adapter exists.** The config vocabulary already covers
  Azure OpenAI (endpoint, deployment mapping, Entra auth), Google and xAI, and
  `data/models.json` records their availability, but no adapter is registered
  for them, so enabling one only makes `list_capabilities` say "no adapter for
  this provider is registered in this build".
- **The npm release predates the tools.** `imagine-mcp@0.0.1` on npm is the
  scaffold, not this. Until the next release, run it from a clone
  ([Development](#development)).
- `logging.level` is accepted by the config schema but nothing reads it yet.
- No web portal, no gallery, no `azd` template. See
  [PLAN.md](PLAN.md) for the full architecture and phasing.

## Quickstart

Zero to a generated image: one OpenRouter key, one JSON snippet, no config file
required.

### 1. Get the server

Requires Node 20 or newer.

```sh
git clone https://github.com/hoeloe15/imagine.git
cd imagine
npm install
npm run build
```

That produces `dist/index.js`, the stdio server binary.

> Once a release with the tools is published, `npx -y imagine-mcp` replaces this
> step. The npm `0.0.1` currently on the registry does not have them.

### 2. Get an API key

Create a key at [openrouter.ai](https://openrouter.ai/keys) and put it in the
environment as `OPENROUTER_API_KEY`. That is the only credential the default
configuration needs — OpenRouter is enabled out of the box and every one of the
four curated models is reachable through it.

You can pass the key in the MCP client's `env` block (below), or put it in a
`.env` file that the server picks up:

```sh
# ~/.imagine/.env
OPENROUTER_API_KEY=sk-or-v1-...
```

`.env` files are read from `~/.imagine/`, from the directory of any config file
that was found, and from the server's working directory. **The ambient
environment always wins over a `.env` file**, so an `env` block in your MCP
client overrides the file.

### 3. Register it with your MCP client

The server speaks MCP over stdio, so it is meant to be launched by a client
rather than run by hand. In a Claude Code / Claude Desktop style MCP config:

```json
{
  "mcpServers": {
    "imagine": {
      "command": "node",
      "args": ["/absolute/path/to/imagine/dist/index.js"],
      "env": {
        "OPENROUTER_API_KEY": "sk-or-v1-..."
      }
    }
  }
}
```

In Claude Code the same thing from the command line:

```sh
claude mcp add imagine --env OPENROUTER_API_KEY=sk-or-v1-... \
  -- node /absolute/path/to/imagine/dist/index.js
```

Alternatively, `npm link` in the clone puts an `imagine` binary on your PATH and
lets you use `"command": "imagine"`.

### 4. Ask for an image

Restart the client, then ask it for a picture. Behind the scenes it calls
`generate_image`, the image lands in `./imagine-output` and the model gets back a
file path to put in your document.

**A missing key does not stop the server from starting.** It starts anyway and
answers with a failure envelope naming the variable it wanted — a client that
cannot start the server cannot show you why.

## Configuring it

Configuration is optional. The bundled defaults are a working zero-config setup:
OpenRouter enabled and reading `OPENROUTER_API_KEY`; Azure, Google and xAI named
but disabled; images in `./imagine-output`; a $5 session and $10 daily budget
that refuses rather than warns.

Config files are merged least- to most-specific: **bundled defaults**, then
`~/.imagine/config.json`, then `./config.json` in the server's working
directory. Every field is optional in a file, so a fragment only contributes what
it actually names.

> **Where to put it.** The working directory of the server is whatever your MCP
> client launches it in, which is usually not your project. Prefer
> `~/.imagine/config.json` and absolute paths for `output.dir` unless you
> deliberately want per-project config.

A minimal `config.json` — the `$schema` line gives you completion and validation
in any editor with JSON Schema support:

```json
{
  "$schema": "https://raw.githubusercontent.com/hoeloe15/imagine/main/schema/config.schema.json",
  "output": {
    "dir": "/Users/you/Pictures/imagine"
  },
  "budget": {
    "max_usd_per_day": 2
  }
}
```

Everything the schema accepts, with the values it defaults to:

```json
{
  "$schema": "https://raw.githubusercontent.com/hoeloe15/imagine/main/schema/config.schema.json",
  "default": {
    "model": null,
    "size": "1024x1024",
    "use_case": null
  },
  "providers": {
    "openrouter": { "enabled": true, "api_key_env": "OPENROUTER_API_KEY" },
    "azure": { "enabled": false, "api_key_env": "AZURE_OPENAI_API_KEY" },
    "google": { "enabled": false, "api_key_env": "GOOGLE_API_KEY" },
    "xai": { "enabled": false, "api_key_env": "XAI_API_KEY" }
  },
  "output": {
    "dir": "./imagine-output",
    "filename": "{slug}-{hash}.{ext}",
    "manifest": "./imagine-output/manifest.jsonl"
  },
  "budget": {
    "max_usd_per_session": 5,
    "max_usd_per_day": 10,
    "on_exceed": "refuse"
  },
  "logging": {
    "level": "info",
    "cost_log": "./imagine-output/costs.jsonl"
  }
}
```

| Key                          | What it does                                                                                   |
| ---------------------------- | ---------------------------------------------------------------------------------------------- |
| `default.model`              | Curated model id used when a call gives no hint and no use case. `null` lets the router rank.   |
| `default.size`               | One of `1024x1024`, `1536x1024`, `1024x1536`, `auto`.                                          |
| `default.use_case`           | One of `text_in_image`, `photoreal`, `illustration`, `diagram`, `fast_bulk`, or `null`.        |
| `providers.<id>.enabled`     | Whether the router may route to it at all.                                                     |
| `providers.<id>.api_key_env` | The **name** of the environment variable holding the key. Never the key itself.                |
| `providers.<id>.endpoint`    | Resource URL, for providers that need one. Required when `auth` is `entra`. _(Azure: planned.)_ |
| `providers.<id>.api_version` | API version string. _(Azure: planned.)_                                                        |
| `providers.<id>.auth`        | `api_key` or `entra`. `entra` needs no key variable. _(Azure: planned.)_                       |
| `providers.<id>.deployments` | Model id → deployment name mapping. _(Azure: planned.)_                                        |
| `output.dir`                 | Where images are written. Relative paths resolve against the server's working directory.        |
| `output.filename`            | Template over `{slug}`, `{hash}` and `{ext}`. Names a file, never a path.                      |
| `output.manifest`            | JSONL log of every image. `null` falls back to `manifest.jsonl` inside the output directory.    |
| `budget.max_usd_per_session` | Cap for one server process. `null` for no cap.                                                 |
| `budget.max_usd_per_day`     | Cap for one local calendar day, across restarts. `null` for no cap.                            |
| `budget.on_exceed`           | `refuse` to block the call, `warn` to run it and flag it.                                      |
| `logging.level`              | `error`, `warn`, `info`, `debug`. Accepted but not yet read.                                   |
| `logging.cost_log`           | Append-only JSONL cost ledger. `null` keeps spend in memory only.                              |

**No key value ever goes in the config file.** `api_key_env` names the variable;
the whole config object is therefore safe to log, and `list_capabilities` can
report a missing credential by naming the variable without ever reading it. See
[ADR 0004](docs/adr/0004-config-loading-and-key-resolution.md).

Azure OpenAI, including the deployment-name mapping and Entra authentication, is
designed for and reserved in the schema but **not implemented**; the same goes
for Google and xAI. Enabling `providers.azure` today gets you a
`not_configured` entry saying no adapter is registered.

## The three tools

### `generate_image`

Generates one image, writes it to disk and returns the path plus what it cost.
The bytes never travel back to the client
([why](docs/adr/0010-mcp-server-and-the-generate-image-tool.md)).

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
([ADR 0007](docs/adr/0007-router-selection-and-fallback.md)).

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

### `list_capabilities`

Takes no arguments. Reports what this installation can do right now: which
providers are ready and which are waiting on an environment variable, which
models are reachable through them, what has been spent, and how fresh the curated
data is. Read-only, costs nothing, and never returns a key
([ADR 0011](docs/adr/0011-what-list-capabilities-reports.md)).

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

### `recommend_model`

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
([ADR 0012](docs/adr/0012-what-recommend-model-is-willing-to-say.md)).

## Cost and budgets

Every generation is priced from the provider's own figure when it gives one, and
from the curated per-image price in `data/models.json` when it does not. The
OpenRouter adapter reads `usage.cost` off the response, so its numbers are
authoritative rather than estimated. Each ledger line records which of the two
it used.

Two limits apply at once, and both default to on:

- `budget.max_usd_per_session` — **$5**, for one server process. Resets when the
  client restarts the server.
- `budget.max_usd_per_day` — **$10**, for one local calendar day. Survives
  restarts, because it is recomputed from the cost log.

Before each call, the estimated cost is checked against both. When either would
be breached, the tighter one decides, and `budget.on_exceed` says what happens:

- `refuse` (the default) — the call is blocked and `generate_image` answers with
  `"error": "budget_exceeded"` and a message naming the limit, the spend so far
  and when it resets. Nothing is charged.
- `warn` — the call runs and the success envelope carries a `budget_warning`
  field.

Set either limit to `null` to switch it off. Spend is appended as JSONL to
`logging.cost_log` (`./imagine-output/costs.jsonl` by default); set it to `null`
to keep the ledger in memory only, which also means the daily total no longer
survives a restart. See
[ADR 0008](docs/adr/0008-cost-ledger-and-budget-enforcement.md).

## Where images land

Images go to `output.dir` (`./imagine-output` by default, or `output_dir` on the
individual call), named by the `output.filename` template
`{slug}-{hash}.{ext}`:

- `{slug}` — the prompt, lowercased and hyphenated, cut to 60 characters
- `{hash}` — the first 8 hex characters of the SHA-256 of the image bytes
- `{ext}` — from the MIME type the provider reported

Nothing is ever overwritten: a collision appends `-2`, `-3` and so on. The
template names a file, not a path — a `/` or `\` in it is an error.

Alongside the images, one JSONL line per image is appended to `output.manifest`
(`./imagine-output/manifest.jsonl` by default), recording path, prompt,
provider, model, cost, dimensions, MIME type, duration and timestamp. That
manifest is what the phase 2 gallery will read. Set it to `null` and it falls
back to `manifest.jsonl` inside the resolved output directory. See
[ADR 0006](docs/adr/0006-output-writing-naming-and-the-manifest.md).

## Troubleshooting

**"Environment variable OPENROUTER_API_KEY is not set"** — the config names a
variable that is not in the environment. Put it in the MCP client's `env` block
or in `~/.imagine/.env`, and remember that MCP clients do not inherit your shell
profile. `list_capabilities` names exactly which variables it is missing.

**`list_capabilities` shows a provider as `not_configured`** — read its `note`.
"Disabled in configuration" means `providers.<id>.enabled` is `false`. "No
adapter for this provider is registered in this build" means the provider is
planned but not implemented; only OpenRouter is real today.

**`"error": "invalid_request"` with "No image provider is available"** — nothing
is both enabled and credentialled. Set `OPENROUTER_API_KEY`, or check that you
have not disabled `providers.openrouter`.

**`"error": "budget_exceeded"`** — the message names which limit, what has been
spent and when it resets. Raise `budget.max_usd_per_session` or
`budget.max_usd_per_day`, set `budget.on_exceed` to `"warn"`, or wait. Nothing
was charged.

**`"error": "content_filtered"`** — the provider's moderation refused the
prompt. Rephrase it, or name another provider with `provider_hint`; content
policies differ. This one is not retryable, and the router deliberately does not
try a second provider on your behalf.

**Config file changes have no effect** — the server resolves `./config.json`
against its own working directory, which your MCP client chooses. Use
`~/.imagine/config.json` instead, and restart the client so the server is
relaunched. A config file that is malformed or names an unknown key fails
loudly at startup with the file path and the offending field.

**`npx -y imagine-mcp` says `'imagine' is not recognized`** — you are running it
from inside a clone of this repo. npm resolves the package name to the local
project instead of the registry, and a package's own bin is never shimmed into
its own `node_modules/.bin`. Run it from any other directory, or use
`node <repo>/dist/index.js` when working inside the clone.

**Images end up somewhere unexpected** — relative paths in `output.dir` resolve
against the server's working directory, not your project. Use an absolute path,
or pass `output_dir` on the call. The exact path is always in the tool result.

## Development

```sh
npm install     # install dependencies
npm run build   # bundle src/index.ts to dist/ with tsup
npm test        # build, then run the vitest suite
npm run lint    # eslint
npm run format  # prettier --write
```

`npm run typecheck` runs `tsc --noEmit` over `src` and `test`. CI runs lint,
format check, typecheck and tests on every push to `main` and every pull
request.

To run the local build as a server, point your MCP client at
`node <repo>/dist/index.js`, or `npm link` the package and use `imagine`.

### Layout

| Path             | What lives there                                |
| ---------------- | ----------------------------------------------- |
| `src/index.ts`   | binary entry point: starts the stdio server     |
| `src/mcp/`       | MCP protocol wiring and tool definitions        |
| `src/core/`      | router, config, knowledge, budget, output       |
| `src/providers/` | one adapter per image provider                  |
| `data/`          | curated model knowledge (`models.json`)         |
| `schema/`        | JSON Schema for the user config file            |
| `test/`          | `unit/`, `contract/`, `live/` and `e2e/` suites |

## Curated model knowledge

[`data/models.json`](data/models.json) is the editorial half of the project: for
each curated model, a 1–5 score per use case, an indicative price per image, a
typical latency, which providers can serve it, and a `notes` field that says both
what to pick it for and what *not* to pick it for. Four models are curated today
— GPT Image 2, Nano Banana (Gemini 3.1 Flash Image), Grok Imagine Image 2.0 and
FLUX 2 Pro.

The scores are editorial judgements, not measurements, and the prices are
indicative list prices that change often; both tools return the file's own
disclaimer alongside their answer, and a provider's reported cost always beats
the number in the file. The file carries an `updated` date so staleness is
visible. See [ADR 0005](docs/adr/0005-two-schemas-for-curated-model-knowledge.md).

## Planned features

- Providers beyond OpenRouter: Azure OpenAI with deployment mapping and Entra
  authentication, then Google Gemini and xAI Grok
- A published npm release carrying the three tools, installable with `npx`
- A local web portal for key management and a searchable gallery of everything
  generated, reading the manifest
- An `azd up` template for a governed deployment in your own Azure tenant

## Documentation

- [PLAN.md](PLAN.md) — the design
- [docs/adr/](docs/adr/) — the decisions, and why they went that way
- [docs/research/providers-2026-08.md](docs/research/providers-2026-08.md) — provider API research
- [docs/issues-draft.md](docs/issues-draft.md) — planned work
- [AGENTS.md](AGENTS.md) — working agreements for agents in this repo

## License

[MIT](LICENSE)
