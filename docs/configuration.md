# Configuration reference

Configuration is optional. The bundled defaults are a working zero-config setup:
OpenRouter enabled and reading `OPENROUTER_API_KEY`; Azure, Google and xAI named
but disabled; images in `./imagine-output`; a $5 session and $10 daily budget
that refuses rather than warns.

## Where the key comes from

The default configuration needs exactly one credential: an OpenRouter key in the
environment as `OPENROUTER_API_KEY`. You can pass it in the MCP client's `env`
block, or put it in a `.env` file that the server picks up:

```sh
# ~/.imagine/.env
OPENROUTER_API_KEY=sk-or-v1-...
```

`.env` files are read from `~/.imagine/`, from the directory of any config file
that was found, and from the server's working directory. **The ambient
environment always wins over a `.env` file**, so an `env` block in your MCP
client overrides the file.

**A missing key does not stop the server from starting.** It starts anyway and
answers with a failure envelope naming the variable it wanted — a client that
cannot start the server cannot show you why.

## Discovery and precedence

Config is merged least- to most-specific: **bundled defaults**, then
`~/.imagine/config.json`, then `./config.json` in the server's working
directory, then the `IMAGINE_OUTPUT_*` variables, then the `IMAGINE_CONFIG_JSON`
environment variable. Every field is optional, so a fragment only contributes
what it actually names.

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

## Every field, with its default

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
    "manifest": "./imagine-output/manifest.jsonl",
    "sink": "local",
    "blob": null
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
| `providers.<id>.api_key_secret` | The **name** of the Key Vault secret holding the key. Only used where a vault is configured; derived from `api_key_env` when absent. |
| `providers.<id>.endpoint`    | Resource URL, for providers that need one. Required when `auth` is `entra`.                     |
| `providers.<id>.api_version` | API version string. Azure defaults to `2025-04-01-preview`.                                    |
| `providers.<id>.auth`        | `api_key` or `entra`. `entra` needs no key variable, and needs a managed identity to run under. |
| `providers.<id>.deployments` | Model id → deployment mapping. Azure needs one entry per model you can reach. A plain string is the deployment name; an object `{ "deployment": …, "dialect": …, "endpoint": … }` also says which API the deployment speaks. |
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
[ADR 0004](adr/0004-config-loading-and-key-resolution.md).

## Keys from Azure Key Vault, on a running deployment

Where the server runs in Azure with a Key Vault — which is what the azd template
gives you — a key does not have to arrive as an environment variable at all. The
server reads the vault itself, **at the moment a call needs a key**, so putting a
key in is one command and no deployment:

```powershell
$vault = azd env get-value AZURE_KEY_VAULT_NAME
az keyvault secret set --vault-name $vault --name openrouter-api-key --value "<key>"
```

The next `generate_image` uses it. Values are cached for a minute, so the honest
promise is **"ready within a minute"**, not "instantly" — and with more than one
replica running, the replica that answers may not be the one that noticed first.

This switches itself on: the template sets `IMAGINE_KEY_VAULT_URL` on the
container, and the container's managed identity is what reads the vault. Neither
present means the server reads the environment and nothing else, which is exactly
what a laptop does.

**Which secret is read.** By convention, the name of `api_key_env` lower-cased
with underscores turned into hyphens — `OPENROUTER_API_KEY` becomes
`openrouter-api-key`, `AZURE_OPENAI_API_KEY` becomes `azure-openai-api-key`.
Those are the names the template already uses, so nothing needs configuring. If
your vault names things differently, say so:

```json
{
  "providers": {
    "openrouter": {
      "api_key_env": "OPENROUTER_API_KEY",
      "api_key_secret": "prod-openrouter"
    }
  }
}
```

Like `api_key_env`, this is a **name and never a value** — it only accepts what
Key Vault accepts as a secret name (letters, digits and hyphens, up to 127 of
them), so most accidental pastes of a key become a validation error.

**The vault wins over the environment**, because the vault is what a person can
change without a deployment. If the vault has no such secret, or cannot be
reached for a moment, the environment variable is used instead.

`list_capabilities` reports which of the two a provider's key came from as
`key_source: "vault" | "env" | null`, and a provider that is still waiting lists
both places it could be put:

```json
{
  "id": "openrouter",
  "status": "not_configured",
  "key_source": null,
  "missing": ["OPENROUTER_API_KEY", "vault secret openrouter-api-key"]
}
```

It never reports the value, a fragment of it, or its length. See
[ADR 0026](adr/0026-runtime-provider-secrets-from-key-vault.md).

## Azure OpenAI

Azure OpenAI is implemented. Point it at your resource, name the key variable,
and map each curated model id to the name of your deployment — the deployment
name is arbitrary and is not the model id, which is why the mapping exists:

```json
{
  "providers": {
    "azure": {
      "enabled": true,
      "auth": "api_key",
      "api_key_env": "AZURE_OPENAI_API_KEY",
      "endpoint": "https://my-resource.openai.azure.com",
      "deployments": { "gpt-image-2": "my-gpt-image-2" }
    }
  }
}
```

Google and xAI are reserved: enabling either today gets you a `not_configured`
entry saying no adapter is registered. See
[ADR 0014](adr/0014-azure-openai-adapter.md).

### Two kinds of Azure deployment

One Azure resource can serve two different image APIs, and they do not agree on
anything that matters for a request. GPT Image 2 puts the deployment name in the
URL; Microsoft's own MAI-Image models put it in the request body, on a different
host, with no API version and with a width and a height instead of a size. So a
deployment entry can say which of the two it speaks:

```json
{
  "providers": {
    "azure": {
      "enabled": true,
      "auth": "entra",
      "endpoint": "https://my-resource.openai.azure.com",
      "deployments": {
        "gpt-image-2": "my-gpt-image-2",
        "mai-image-2.6": { "deployment": "mai-image-2-6", "dialect": "mai" }
      }
    }
  }
}
```

- **A plain string is the deployment name and means `"dialect": "openai"`** — the
  GPT Image 2 shape. Every config written before this existed keeps working
  exactly as it did.
- **`"dialect": "mai"`** is for the MAI-Image models. The server derives the host
  it needs from the endpoint you already configured, swapping
  `my-resource.openai.azure.com` for `my-resource.services.ai.azure.com`. Set
  `"endpoint"` on the entry only if your resource does not follow that pattern.
- Under `"auth": "entra"` the two dialects need **different Entra audiences**, and
  the server asks for the right one per call. The identity needs the **Cognitive
  Services User** role for MAI in addition to the **Cognitive Services OpenAI
  User** role for GPT Image 2.

Two things about MAI are worth knowing before you route work to it. It produces
**one image per call** and caps the output at about a megapixel, so a requested
`1536x1024` is shrunk to the largest same-shape size that fits (`1248x832`) and
the result reports the size that actually came back. And a capacity-1 deployment
is quota'd in **requests per minute**, in the low single digits — enough for a
person, not for a batch.

See [ADR 0027](adr/0027-the-mai-image-wire-dialect.md).

### Azure OpenAI without a key at all

Set `"auth": "entra"` and drop `api_key_env`, and the server authenticates with
the managed identity of whatever it is running on — no Azure OpenAI key is
created, stored or rotated anywhere:

```json
{
  "providers": {
    "azure": {
      "enabled": true,
      "auth": "entra",
      "endpoint": "https://my-resource.openai.azure.com",
      "deployments": { "gpt-image-2": "my-gpt-image-2" }
    }
  }
}
```

This works where the platform provides an identity — Azure Container Apps and
App Service both set `IDENTITY_ENDPOINT` and `IDENTITY_HEADER`, which is how the
server detects it — and the identity needs the **Cognitive Services OpenAI
User** role on the resource. The azd template of
[ADR 0020](adr/0020-the-azd-template.md) does both for you.

On a developer machine there is no such identity, and a call fails with a message
saying so rather than quietly picking up your `az login`. Local development uses
`"auth": "api_key"` and a `.env`; the environment chooses, not the code. See
[ADR 0022](adr/0022-hosted-config-and-managed-identity.md).

## `IMAGINE_CONFIG_JSON`, for hosts with no config file

Where there is no filesystem to put a `config.json` on — a container, a serverless
host — the whole fragment can travel in one environment variable:

```bash
export IMAGINE_CONFIG_JSON='{"providers":{"azure":{"enabled":true,"auth":"entra","endpoint":"https://my-resource.openai.azure.com","deployments":{"gpt-image-2":"my-gpt-image-2"}}}}'
```

It is the same schema as a `config.json`, validated the same way — an unknown key
or a bad value is an error naming `IMAGINE_CONFIG_JSON` and the field — and it is
merged last, so it wins over every config file including one passed with
`--config`. Unset or empty means "nothing to add".

**It cannot carry a secret**: `api_key_env` still only accepts the *name* of an
environment variable, so a pasted key is a validation error rather than a value
sitting in your deployment history. Keys keep arriving as their own environment
variables.

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
[ADR 0008](adr/0008-cost-ledger-and-budget-enforcement.md).

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
[ADR 0006](adr/0006-output-writing-naming-and-the-manifest.md).

### Storing images in Azure Blob Storage instead

`output.sink` picks where the bytes go. `"local"`, the default, is everything
above. `"blob"` uploads them to a container instead and adds a `url` to the tool
result — a signed link that renders in a chat client without any Azure sign-in.
It only works where the platform provides a managed identity, which means a
hosted deployment, not a laptop.

```json
{
  "output": {
    "sink": "blob",
    "blob": {
      "account_url": "https://stabc123.blob.core.windows.net",
      "container": "images",
      "url_ttl_hours": 1
    }
  }
}
```

| Field           | Default | Meaning                                                        |
| --------------- | ------- | -------------------------------------------------------------- |
| `account_url`   | —       | the storage account's blob endpoint, `https://` only            |
| `container`     | —       | an existing container; this never creates one                   |
| `url_ttl_hours` | `1`     | how long a returned link stays valid, 1 to 168                  |

The naming rules, the never-overwrite rule and the manifest all still apply; the
manifest stays a local file for now.

Because the account URL and container only exist once a deployment has created
them, four environment variables can fill this section in without anyone editing
JSON: `IMAGINE_OUTPUT_SINK`, `IMAGINE_OUTPUT_BLOB_ACCOUNT_URL`,
`IMAGINE_OUTPUT_BLOB_CONTAINER` and `IMAGINE_OUTPUT_BLOB_URL_TTL_HOURS`. They sit
just below `IMAGINE_CONFIG_JSON` in precedence, so an `output` section written by
hand always wins. The azd template sets the first three for you
([hosting](hosting.md#where-the-pictures-go),
[ADR 0024](adr/0024-output-sinks-and-renderable-urls.md)).
