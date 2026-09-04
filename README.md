# imagine

![A robot hand painting a lighthouse into the empty grey placeholder on a slide](docs/assets/readme-hero.png)

*(Made by imagine, of course — gpt-image-2 via Azure, $0.19, one prompt.)*

Your AI writes a great deck and then leaves grey rectangles where the pictures
should be. It can describe the illustration for slide 4 perfectly; it just has no
hand to draw it with. `imagine` is that hand: one MCP server that any AI client
can call to make an image, with curated knowledge of which model is actually good
at what and what it costs — so the client picks the right one this month rather
than the one someone hard-coded last year. The picture lands on disk, the client
gets a file path, and every generation comes with a receipt.

**Early development, but usable end to end.** It runs on your laptop with one
API key, or in your own Azure tenant behind a Microsoft login.

## What it does

Three tools, and your AI decides when to use them.

**`generate_image`** makes one picture, writes it to disk and hands back the
path, the cost and why that model was chosen. The image bytes never travel back
through the conversation. Running in the cloud, the picture comes back as a link
you can open instead of a path on a machine you cannot reach
([how](docs/hosting.md#where-the-pictures-go)).

> "Make me a flat vector illustration of a lighthouse at dusk for slide 4."

**`list_capabilities`** says what this installation can actually reach right
now: which providers are ready, which are waiting on a key, which models are
available, what you have spent today.

> "What image models can you get to, and how much have we spent?"

**`recommend_model`** gives advice before you spend anything — it calls no
provider and costs nothing.

> "I need 20 illustrations for a deck. What should we use, and what will it
> cost?"

The full argument tables and response envelopes are in
[docs/tools.md](docs/tools.md).

## Use it on your machine (2 minutes)

You need Node 20 or newer. There is nothing to install and nothing to build.

**1. Get a key.** Create one at [openrouter.ai](https://openrouter.ai/keys).
That is the only credential you need — OpenRouter is enabled out of the box and
all four curated models are reachable through it.

**2. Put it in a file** at `~/.imagine/.env`:

```sh
# ~/.imagine/.env
OPENROUTER_API_KEY=sk-or-v1-...
```

**3. Tell your client about it.** In Claude Code, one command:

```sh
claude mcp add imagine -- npx -y imagine-mcp@latest
```

In Claude Desktop, the same thing as a config entry:

```json
{
  "mcpServers": {
    "imagine": {
      "command": "npx",
      "args": ["-y", "imagine-mcp@latest"],
      "env": {
        "OPENROUTER_API_KEY": "sk-or-v1-..."
      }
    }
  }
}
```

(You can pass the key here instead of in the `.env` file — in Claude Code that
is `--env OPENROUTER_API_KEY=sk-or-v1-...`. The real environment always wins
over the file.)

**4. Start a new chat and ask for a picture.** The image lands in
`./imagine-output` and your assistant gets a path to drop into your document.

> **Don't run `npx -y imagine-mcp@latest` yourself — and if you do, silence is
> normal.** It starts, waits for an MCP client to talk to it over stdin, and
> sits there looking broken. It isn't. That command is for your MCP client to
> run, not for you. (And a missing key doesn't stop it starting either: it comes
> up anyway and answers with a friendly failure naming the variable it wanted,
> because a server that refuses to start can't tell you why.)

Prefer Azure OpenAI, your own resource, your own quota? That is a few lines of
config — see [docs/configuration.md](docs/configuration.md#azure-openai).

## Put it in the cloud (and why you'd want to)

Running it on your laptop is the fast way in. Putting it in your own Azure tenant
buys you five things:

- **The same toolbox on every device** — laptop, desktop, phone, all pointing at
  one URL.
- **A login instead of keys everywhere.** You sign in with your work account;
  no API key sits on any laptop.
- **Share it with your team** by sending them the URL.
- **Azure OpenAI with no key at all**, using the managed identity of the app —
  nothing to store, nothing to rotate.
- **A cost log that survives restarts**, so the spend is still there tomorrow.

### How

You need a clone of this repo, the Azure CLI, `azd`, and Docker Desktop running.
Then:

```powershell
azd auth login
azd env new imagine-dev
azd up
```

A bare `azd up` gives you a reachable endpoint that is **unauthenticated** and
has **no provider key** — verifiable rather than finished. Three switches close
that, and the order matters:

| `azd env set …`                      | Default | What it does                                                                 |
| ------------------------------------ | ------- | ---------------------------------------------------------------------------- |
| `IMAGINE_ENTRA_HOOK`                 | `false` | Lets the postprovision hook create the Entra app registration for you         |
| `IMAGINE_AUTH_ENABLED`               | `false` | Makes the container demand a verified Entra bearer token on every `/mcp` POST |
| `IMAGINE_OPENROUTER_SECRET_IN_VAULT` | `false` | Declares that `openrouter-api-key` is in the vault, so the app may read it    |

**Turn authentication on before you put any key in the vault.** That is the
whole point of the order: an open endpoint with no credentials costs a stranger
nothing, an open endpoint with your OpenRouter key spends your money.

```powershell
azd env set IMAGINE_ENTRA_HOOK true
azd env set IMAGINE_AUTH_ENABLED true
azd up
# only now:
az keyvault secret set --vault-name (azd env get-value AZURE_KEY_VAULT_NAME) `
  --name openrouter-api-key --value "<paste the key>"
azd env set IMAGINE_OPENROUTER_SECRET_IN_VAULT true
azd up
```

**The terminal then tells you what's next.** When `azd up` finishes it prints
your endpoint and a short **Next steps** block that reads the environment back
and says which of those three switches are still open, with the exact command
for each.

### Connecting to it

**Cowork and claude.ai** take the endpoint as a **custom connector**: add
`https://<fqdn>/mcp` by URL, and Claude reads the server's protected-resource
document, discovers your tenant and shows the Microsoft login itself.

**Sharing it by URL alone** — no client id, no secret, in claude.ai, Cowork or
Mistral Le Chat — needs an authorization server that lets those clients register
themselves, which Entra does not do. Put WorkOS AuthKit in front, keep the
Microsoft login, and set `IMAGINE_AUTH_ISSUER` instead of a tenant:
[docs/deploy/azure-wizard.md §6e](docs/deploy/azure-wizard.md).

**Claude Code** can carry a bearer token directly:

```powershell
$fqdn  = azd env get-value MCP_ENDPOINT_URL
$appId = azd env get-value AZURE_MCP_APP_ID
$token = az account get-access-token --resource "api://$appId" --query accessToken -o tsv
claude mcp add --transport http imagine "$fqdn/mcp" --header "Authorization: Bearer $token"
```

That token expires in about an hour, so it proves the deployment rather than
being a setup you keep; the runbook's `headersHelper` variant refreshes it.

One thing to know before you share it: the app registration is **single-tenant**
(`AzureADMyOrg`), so a colleague in another tenant is not a permissions problem
you can fix from the portal — it is a second `azd env` and a second `azd up` in
that tenant.

The long version — tenant permissions, the manual app registration for when you
cannot create one, every verification step, and tearing it all down — is
[docs/deploy/azure-wizard.md](docs/deploy/azure-wizard.md). Running the HTTP
server yourself, in a container or anywhere else, is
[docs/hosting.md](docs/hosting.md).

## It keeps up with the leaderboards so you don't have to

The best image model changes every few weeks, and "best" depends on the job:
the model that renders legible text inside a picture is not the one that does
photorealism, and neither is the cheap one you want for twenty thumbnails. Most
integrations freeze one choice in code and quietly go stale. `imagine` keeps that
knowledge as **data** instead, and gives you advice from it before you spend
anything.

Ask your assistant *"I need twenty illustrations for a deck, what should we
use?"* and `recommend_model` answers with the best model overall, the best one
**you can actually reach** with your keys, a cheaper alternative and its trade-off
in plain words, and what each option would cost for twenty images. It will
happily recommend the cheap model when the cheap model is fine — an adviser that
always picks the premium option is one you stop trusting after the second bill.
When the best model for the job is one you have not configured, it says so and
tells you exactly what enabling it would take.

Behind that sits [`data/models.json`](data/models.json): per model a score per
use case, an indicative price, a leaderboard rank band and — importantly — a
`checked` date on every price and ranking, so you can always see how fresh the
advice is. Today that file is curated by hand and shipped with each release; a
weekly refresh that proposes updates as a pull request is planned
([#25](https://github.com/hoeloe15/imagine/issues/25),
[#26](https://github.com/hoeloe15/imagine/issues/26)), so the knowledge moves
with the leaderboards without anyone hard-coding a model name again.

## How it decides

[`data/models.json`](data/models.json) is the editorial half of the project: for
each curated model, a 1–5 score per use case, an indicative price per image, a
typical latency, which providers can serve it, and a `notes` field that says both
what to pick it for and what *not* to pick it for. Four models are curated today
— GPT Image 2, Nano Banana (Gemini 3.1 Flash Image), Grok Imagine Image 2.0 and
FLUX 2 Pro. The scores are editorial judgements, not measurements, and the prices
are indicative list prices that change often; both advisory tools return the
file's own disclaimer alongside their answer, a provider's reported cost always
beats the number in the file, and the file carries an `updated` date so
staleness is visible ([ADR 0005](docs/adr/0005-two-schemas-for-curated-model-knowledge.md)).

On top of that sit two budgets that are on by default: **$5 per server session**
and **$10 per day**, and by default a call that would breach either is refused
rather than run. Every image is logged — path, prompt, model, cost — so the
spend is a receipt you can read, not a surprise on a bill. Both are configurable
([budgets and the cost ledger](docs/configuration.md#cost-and-budgets)).

## What is not there yet

- **Only the OpenRouter and Azure OpenAI adapters exist.** The config vocabulary
  also covers Google and xAI, and `data/models.json` records their availability,
  but no adapter is registered for them, so enabling one only makes
  `list_capabilities` say "no adapter for this provider is registered in this
  build".
- **Azure Entra authentication needs a managed identity to run under.** With
  `"auth": "entra"` the server gets its token from the identity the platform
  provides (Container Apps, App Service). On a developer machine there is none,
  and a call fails with an `auth_failed` saying so; use `"auth": "api_key"`
  locally.
- `logging.level` is accepted by the config schema but nothing reads it yet.
- No web portal and no gallery yet, and no pre-registered OAuth client for
  claude.ai and Claude Desktop — so a custom connector still needs a hand-made
  second app registration. See [PLAN.md](PLAN.md) for the full architecture and
  phasing.

## Something not working?

Most of it comes down to three things: a key the server can't see, a config file
in a directory you didn't expect, or an Azure deployment name that isn't the
model name. [docs/troubleshooting.md](docs/troubleshooting.md) has the symptom,
the cause and the fix for each of those, and for every error code the tools can
return.

## Development

```sh
git clone https://github.com/hoeloe15/imagine.git
cd imagine
npm install
npm run build
npm test
```

More — the repo layout, the lint and format commands, and how to point a client
at your local build — is in [docs/development.md](docs/development.md).

## Documentation

- [docs/tools.md](docs/tools.md) — the three tools in full
- [docs/configuration.md](docs/configuration.md) — config, keys, budgets, output
- [docs/hosting.md](docs/hosting.md) — HTTP, authentication, containers
- [docs/deploy/azure-wizard.md](docs/deploy/azure-wizard.md) — the Azure runbook
- [docs/troubleshooting.md](docs/troubleshooting.md) — when it misbehaves
- [docs/development.md](docs/development.md) — working on imagine itself
- [docs/demo.md](docs/demo.md) — a real deck, images generated in-flight
- [PLAN.md](PLAN.md) — the design
- [docs/adr/](docs/adr/) — the decisions, and why they went that way
- [docs/research/providers-2026-08.md](docs/research/providers-2026-08.md) — provider API research
- [docs/issues-draft.md](docs/issues-draft.md) — planned work
- [AGENTS.md](AGENTS.md) — working agreements for agents in this repo

## License

[MIT](LICENSE)
