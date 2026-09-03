# Troubleshooting

**"Environment variable OPENROUTER_API_KEY is not set"** — the config names a
variable that is not in the environment. Put it in the MCP client's `env` block
or in `~/.imagine/.env`, and remember that MCP clients do not inherit your shell
profile. `list_capabilities` names exactly which variables it is missing.

**`list_capabilities` shows a provider as `not_configured`** — read its `note`.
"Disabled in configuration" means `providers.<id>.enabled` is `false`. "No
adapter for this provider is registered in this build" means the provider is
planned but not implemented; OpenRouter and Azure OpenAI are the real ones
today. "The adapter reports itself unconfigured" for Azure means one of the four
things it needs is missing: `enabled`, `endpoint`, a credential, or at least one
entry in `deployments`.

**Azure fails with `provider_unavailable` and a 404** — the deployment name in
`providers.azure.deployments` does not exist on that resource. The message names
the deployment it tried; check it against the deployment list in Azure AI
Foundry, and remember it is the *deployment* name, not the model name.

**Azure fails with `auth_failed` mentioning `IDENTITY_ENDPOINT`** —
`providers.azure.auth` is `entra` but this process has no managed identity, which
is normal on a developer machine. Switch to `api_key` and set the variable
`api_key_env` names, or run it somewhere that provides an identity.

**Azure fails with `auth_failed` and a 403 from the resource** — the managed
identity has no **Cognitive Services OpenAI User** role on the Foundry resource,
or the assignment has not propagated yet. Assignments are eventually consistent;
if you just deployed, wait a minute and try again.

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

**Nothing happens when you run `npx -y imagine-mcp@latest` yourself** — that is
correct behaviour, not a hang. The server speaks MCP over stdio and is waiting
for a client to talk to it. Let your MCP client launch it instead.

**Images end up somewhere unexpected** — relative paths in `output.dir` resolve
against the server's working directory, not your project. Use an absolute path,
or pass `output_dir` on the call. The exact path is always in the tool result.
