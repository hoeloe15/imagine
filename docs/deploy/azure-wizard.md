# Deploying imagine to Azure — operator runbook

Windows, PowerShell 7. This is a runbook to execute step by step, by a human at
a keyboard. It covers only the parts a human must do: the sign-ins, the
subscription choice, the one secret, and the client connection. Everything else
is `azd`'s job.

**Executed against a live subscription on 2026-09-03**, in a personal
(hotmail-rooted) tenant, from `azd up` through the Entra hook, token validation
and a real authenticated `tools/list`. The timings and error messages below are
measured, not estimated. What that run did **not** exercise: a provider key in
the vault and the two-pass `*_SECRET_IN_VAULT` flow (§6), managed-identity Azure
OpenAI end to end (§6b), the claude.ai / Cowork custom-connector login from the
client side (§8), and `azd down --purge` with the `predown` hook (§9). Those
sections are still written from the template rather than from experience — the
list at the bottom says exactly which questions are open.

For the short version — the three switches and nothing else — see
**Deploying to Azure** in the [README](../../README.md). This is the long
version: tenant permissions, the manual app registration, every verification
step, teardown.

Background and the reasoning behind the choices here:
[`docs/research/remote-mcp-2026-08.md`](../research/remote-mcp-2026-08.md).

---

## 0. Before you start

**What you need in the tenant.** More than most `azd` templates:

| Need                                                   | Why                                                       |
| ------------------------------------------------------ | --------------------------------------------------------- |
| Contributor on the target subscription                 | To create the resource group and everything in it          |
| **User Access Administrator** (or Owner)               | The template makes role assignments (Key Vault, Blob)      |
| Permission to **create app registrations** in Entra ID | The MCP endpoint is a protected API (#44)                  |
| Someone who can **grant admin consent**, if the tenant requires it for delegated scopes | Otherwise every user consents individually, or nobody can |

If you do not have the app-registration permission, that is fine and expected:
the template's default path does not create one. Section 6c has both routes, the
automated hook and the manual registration whose ids are fed to `azd` as
environment values. In a corporate tenant the manual one is the normal case.

**Tools.** Check each one before you begin:

```powershell
az version
azd version
docker version
node --version   # 20 or newer
```

Install what is missing:

```powershell
winget install --exact --id Microsoft.AzureCLI
winget install --exact --id Microsoft.Azd
winget install --exact --id Docker.DockerDesktop
```

Docker Desktop must actually be **running** — `azd` builds the image locally and
pushes it to the registry. A stopped Docker daemon lets the provision succeed
and then fails the deploy — the infrastructure exists, the app does not.

The image is built from [`Containerfile`](../../Containerfile), not a
`Dockerfile`, which is why `azure.yaml` names it explicitly
(`docker: { path: ./Containerfile }`). Prove the build before you provision
anything — it is a minute here versus a failed `azd up` after the
infrastructure already exists:

```powershell
docker build -f Containerfile -t imagine:local .
docker run --rm -d -p 8080:8080 --name imagine-local imagine:local
curl.exe -s http://127.0.0.1:8080/healthz
docker rm -f imagine-local
```

Expect `{"status":"ok",...}`. The image already sets `IMAGINE_TRANSPORT=http`,
`IMAGINE_HTTP_HOST=0.0.0.0` and a port that follows Container Apps' `PORT`, so
the container app needs no transport environment of its own — only the provider
key from Key Vault (§6). Health probes go on `/healthz` and never on `/mcp`
(ADR 0018).

**Cost.** A Container Apps environment with min replicas 1 (which the template
sets deliberately — scale-to-zero cold starts are visible inside a tool call and
read to the user as a broken connector), a Basic container registry, a Key
Vault and a Log Analytics workspace. Small, but not zero, and it runs whether or
not anyone
generates an image. `azd down` at the end of a trial is not optional.

---

## 1. Sign in to Azure CLI

```powershell
az login
```

A browser opens. Sign in with the account that has the permissions above. If you
belong to more than one tenant, be explicit:

```powershell
az login --tenant <tenant-id-or-domain>
```

Confirm who you are:

```powershell
az account show --query "{user:user.name, sub:name, subId:id, tenant:tenantId}" -o table
```

---

## 2. Choose the subscription

List what you can see, then pick deliberately — the default is whichever
subscription happens to be first, and that is how test resources end up in a
production subscription.

```powershell
az account list --query "[].{name:name, id:id, isDefault:isDefault}" -o table
az account set --subscription "<subscription-name-or-id>"
az account show --query "{sub:name, subId:id}" -o table
```

Note the subscription id; step 4 asks for it.

Confirm the resource providers you will need are registered. On a fresh
subscription they often are not, and the failure message from Bicep is not
helpful:

```powershell
foreach ($p in "Microsoft.App","Microsoft.ContainerRegistry","Microsoft.KeyVault","Microsoft.Storage","Microsoft.OperationalInsights") {
  az provider show --namespace $p --query "{ns:namespace, state:registrationState}" -o tsv
}
```

Anything not `Registered`:

```powershell
az provider register --namespace <namespace> --wait
```

---

## 3. Sign in to azd

`azd` keeps its own credential; `az login` does not cover it.

```powershell
azd auth login
```

Same tenant caveat:

```powershell
azd auth login --tenant-id <tenant-id>
```

---

## 4. Create the azd environment

From the repo root:

```powershell
cd C:\Users\mark9\Shippable\imagine
azd env new imagine-dev
azd env set AZURE_SUBSCRIPTION_ID <subscription-id>
azd env set AZURE_LOCATION westeurope
```

Pick a region that supports Container Apps and is near you; `westeurope` is the
obvious choice from the Netherlands. The environment name becomes the resource
group name (`rg-imagine-dev`) and seeds every resource name, so keep it short
and lower case.

Everything else the template accepts has a default and is set later, in the
section that needs it. The full list, so nothing is a surprise:

| `azd env set …`                       | Default                         | Set it in |
| ------------------------------------- | ------------------------------- | --------- |
| `AZURE_SUBSCRIPTION_ID`               | —                               | here      |
| `AZURE_LOCATION`                      | —                               | here      |
| `AZURE_RESOURCE_GROUP`                | `rg-<env-name>`                 | rarely    |
| `IMAGINE_CONTAINER_IMAGE`             | `ghcr.io/hoeloe15/imagine:edge` | rarely    |
| `IMAGINE_OPENROUTER_SECRET_IN_VAULT`  | `false`                         | §6        |
| `IMAGINE_AZURE_OPENAI_SECRET_IN_VAULT`| `false`                         | §6        |
| `IMAGINE_CONFIG_JSON`                 | — (built-in defaults)           | §6b       |
| `IMAGINE_FOUNDRY_RESOURCE_ID`         | — (no role assignment)          | §6b       |
| `IMAGINE_ENTRA_HOOK`                  | `false`                         | §6c       |
| `IMAGINE_AUTH_ENABLED`                | `false`                         | §6d       |
| `IMAGINE_AUTH_CLIENT_ID`              | — (hook writes it)              | §6c/§6d   |
| `IMAGINE_AUTH_TENANT_ID`              | the deployment tenant           | §6d       |
| `IMAGINE_AUTH_REQUIRED_SCOPE`         | `access_as_user`                | rarely    |
| `IMAGINE_AUTH_EXTRA_AUDIENCES`        | —                               | rarely    |
| `IMAGINE_AUTH_ISSUER`                 | derived from the tenant         | rarely    |

`AZURE_PRINCIPAL_ID` is set by `azd` itself and is what earns you Key Vault
Secrets Officer on your own vault in §6 — do not clear it.

Check what the environment holds before provisioning:

```powershell
azd env get-values
```

---

## 5. Provision and deploy

```powershell
azd up
```

This provisions the infrastructure, builds the container image, pushes it to the
registry and deploys the container app. **Measured on 2026-09-03: about two
minutes end to end** — 1m20 to 1m45 for the provision, 25 to 30 seconds for the
deploy. Later runs that flip a flag take about the same. It prints the endpoint
FQDN at the end; keep it.

What you have after this run is deliberately not the finished thing: a reachable,
**unauthenticated** endpoint running with **no provider key**. That is issue
#40's intermediate state, and it is verifiable rather than merely broken —
`/healthz` answers 200 and `list_capabilities` reports every provider as
`not_configured`. Sections 6, 6c and 6d close the remaining three gaps.

A note on the image, because it changes what a bare `azd provision` does. The
container app is created with the published GHCR image
(`ghcr.io/hoeloe15/imagine:edge`) so that a brand-new, empty ACR does not leave
it with nothing to start; `azd deploy` then replaces it with an image built from
*your* working tree and pushed to ACR (ADR 0020). The consequence: **after
flipping any flag with `azd provision`, follow it with `azd deploy`**, or the app
reverts to the published `main` image. `azd up` does both and is the safe habit.

Retrieve the endpoint again at any time:

```powershell
azd env get-value MCP_ENDPOINT_URL
```

The outputs the later sections use, all written into the `azd` environment:
`MCP_ENDPOINT_URL`, `MCP_RESOURCE_URI` (the same URL with `/mcp`, which is the
string that must be an Application ID URI), `AZURE_RESOURCE_GROUP`,
`AZURE_CONTAINER_APP_NAME`, `AZURE_KEY_VAULT_NAME`,
`AZURE_CONTAINER_REGISTRY_NAME`, `AZURE_MANAGED_IDENTITY_CLIENT_ID`,
`AZURE_MANAGED_IDENTITY_PRINCIPAL_ID`.

**If the first run fails on a role assignment with a 403**, that is Entra
propagation delay, not a broken template — a role assignment made in the same
deployment as the identity it grants can land before the identity is visible.
Re-run `azd up`. See #43. (On the live run of 2026-09-03 this did not happen:
all role assignments landed on the first attempt.)

**If provisioning fails with `RoleDefinitionDoesNotExist`**, your checkout
predates commit `911edea` — the template carried an invented GUID for Key Vault
Secrets Officer. Pull, and re-run.

**The app registration step cannot fail this run**: it is off by default and is
section 6c's business, not `azd up`'s.

### What the terminal tells you after `azd up`

A `postdeploy` hook (`infra/hooks/postdeploy-next-steps.ps1`) prints a **Next
steps** block once the deploy finishes. It reads the `azd` environment back
rather than assuming anything, and names the gaps that are actually still open
in *your* environment: whether authentication is on, whether a provider
credential has reached the container, and the exact commands to close each one.
It prints only — it never provisions, never writes to the environment and never
fails the deploy.

Read it before you read the rest of this document: it tells you which of the
following sections you still need. If it warns that authentication is off, §6c
and §6d are next, and §6 waits until after them.

---

## 6. Set the OpenRouter key

> **Not yet executed live.** Everything from here to the end of this section is
> written from the template, not from a run. The 2026-09-03 run left the vault
> empty. Turn authentication on (§6c, §6d) *before* you put a key in it.

The template deliberately does not contain the key. It provisions the vault and
grants the container's managed identity read access; you put the value in, once,
by hand.

**Why this is two passes, and not one.** A Container Apps secret whose value is a
Key Vault reference is resolved when the revision is created. Reference a secret
that does not exist yet and the revision fails, taking the deployment with it. So
the template only declares the reference once you tell it the secret is there.
That is what the `IMAGINE_*_SECRET_IN_VAULT` flags are; the alternatives (a
placeholder value the template would keep overwriting, or the key as a
parameter) are both worse and are argued down in ADR 0020.

```powershell
$vault = azd env get-value AZURE_KEY_VAULT_NAME
az keyvault secret set --vault-name $vault --name openrouter-api-key --value "<paste the key>"
```

The vault is RBAC-authorized, not access-policy. Being Owner of the subscription
does **not** give you data-plane access; the template grants **Key Vault Secrets
Officer** to the principal `azd` deployed as. If this command returns a 403,
either you are signed in as someone else than the deployer, or the role
assignment has not propagated yet — wait a minute and retry before assuming the
template is wrong.

Azure OpenAI, if you use it, is the same command with `--name
azure-openai-api-key`. Its endpoint is not a secret and lives in `config.json`
under `providers.azure.endpoint`, not here.

Now tell the template the secret exists, and redeploy:

```powershell
azd env set IMAGINE_OPENROUTER_SECRET_IN_VAULT true
# and, only if you set the Azure OpenAI key too:
# azd env set IMAGINE_AZURE_OPENAI_SECRET_IN_VAULT true
azd up
```

The container app now declares a secret whose value is
`https://<vault>.vault.azure.net/secrets/openrouter-api-key`, resolved by the
user-assigned managed identity, and maps it to `OPENROUTER_API_KEY`. Confirm
that the configuration holds a reference and not a key:

```powershell
$rg  = azd env get-value AZURE_RESOURCE_GROUP
$app = azd env get-value AZURE_CONTAINER_APP_NAME
az containerapp secret list --name $app --resource-group $rg -o table
```

Expect a `keyVaultUrl` column with a value and an empty `value` column.

Do not put the key in a script, a `.env` file in the repo, or an `azd env`
value. `az keyvault secret set` reads it from the command line, which means it
lands in your PowerShell history — clear it afterwards if that matters to you:

```powershell
Clear-History
Remove-Item (Get-PSReadlineOption).HistorySavePath -ErrorAction SilentlyContinue
```

The container reads the secret through a Key Vault reference that surfaces as the
`OPENROUTER_API_KEY` environment variable, which is exactly what
`providers.openrouter.api_key_env` already names — no config change (ADR 0004).

The running revision must restart to pick up a newly set secret:

```powershell
$rg  = azd env get-value AZURE_RESOURCE_GROUP
$app = azd env get-value AZURE_CONTAINER_APP_NAME
az containerapp revision restart --name $app --resource-group $rg `
  --revision (az containerapp revision list --name $app --resource-group $rg --query "[0].name" -o tsv)
```

**Rotation later is this same pair of commands and nothing else** — `az keyvault
secret set` and a revision restart. No `azd`, no redeploy, no template change:
the reference points at the secret's unversioned URI, so a new version is picked
up on the next container start. That is the template's design and is still
unverified against a live vault — correct this paragraph the first time you do
it.

---

## 6b. Point the hosted server at Azure OpenAI

Skip this if you only use OpenRouter.

> **Not yet executed live.** No part of this section was exercised on
> 2026-09-03 — no Foundry account, no `IMAGINE_CONFIG_JSON`, no managed-identity
> token against the Azure OpenAI data plane. Treat it as the template's intent.

The container has no `~/.imagine/config.json` and nowhere to write one, so the
whole config fragment travels in one environment variable,
`IMAGINE_CONFIG_JSON`. It is the same JSON a `config.json` holds, validated the
same way, and merged after every file (ADR 0022). It carries **no secrets** —
`api_key_env` only ever names an environment variable, and the schema rejects
anything that looks like a key — which is why it is an ordinary azd env value
rather than a vault secret.

The recommended shape uses **no Azure OpenAI key at all**: the container app's
managed identity gets the token.

```powershell
$config = '{"providers":{"azure":{"enabled":true,"auth":"entra","endpoint":"https://<your-resource>.openai.azure.com","deployments":{"gpt-image-2":"<your-deployment-name>"}}}}'
azd env set IMAGINE_CONFIG_JSON ($config -replace '"', '\"')
```

The `-replace` is not optional: azd splices the value verbatim into
`main.parameters.json`, so unescaped quotes break that file and `azd up` fails
with `error unmarshalling Bicep template parameters` before anything is
deployed. The escaped form arrives in the container as plain JSON. (Learned on
the first real run, 2026-09-04.)

`deployments` maps a curated model id to the name **you** gave the deployment in
Azure AI Foundry. They are usually not the same string, and a mismatch surfaces
as a 404 that names the deployment it tried.

Then tell the template which resource the identity needs access to. It is
normally in a different resource group from this deployment, so it is given as a
full resource id:

```powershell
az cognitiveservices account list --query "[].{name:name,rg:resourceGroup,id:id}" -o table
azd env set IMAGINE_FOUNDRY_RESOURCE_ID "/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.CognitiveServices/accounts/<account>"
azd up
```

That grants the container's user-assigned identity the **Cognitive Services
OpenAI User** role (`5e0bd9bd-7b93-4f28-af87-19fc36ad61bd`) on that account —
data-plane inference and nothing more. Leave the variable empty and the role
assignment is skipped, which is what you want if you would rather grant it by
hand or the identity already has it.

Check that it took:

```powershell
$mi = azd env get-value AZURE_MANAGED_IDENTITY_PRINCIPAL_ID
az role assignment list --assignee $mi --all -o table
```

Role assignments are eventually consistent. A first `generate_image` that fails
with a 403 and succeeds a minute later is propagation, not misconfiguration.

**If you would rather use a key**, set `"auth": "api_key"` and
`"api_key_env": "AZURE_OPENAI_API_KEY"` in the fragment instead, put the key in
the vault as `azure-openai-api-key` and set
`IMAGINE_AZURE_OPENAI_SECRET_IN_VAULT true` (step 6). The endpoint and the
deployment mapping still travel in `IMAGINE_CONFIG_JSON` either way.

Verify what the server ended up with:

```powershell
$rg  = azd env get-value AZURE_RESOURCE_GROUP
$app = azd env get-value AZURE_CONTAINER_APP_NAME
az containerapp show --name $app --resource-group $rg `
  --query "properties.template.containers[0].env[?name=='IMAGINE_CONFIG_JSON']" -o json
```

If the fragment is malformed the container will not start, and the log line names
`IMAGINE_CONFIG_JSON` and the field that is wrong.

---

## 6c. The Entra app registration

The endpoint is a protected API. That means one app registration in the tenant,
and — the part that breaks the demo when it is missed — the deployed endpoint
URL **including the `/mcp` path** registered as an Application ID URI. Claude
sends the full MCP server URL as the RFC 8707 `resource`, and Entra answers
`AADSTS9010010` when it does not match one (research §3.3).

The exact string, from the provision outputs:

```powershell
azd env get-value MCP_RESOURCE_URI     # https://ca-imagine-....azurecontainerapps.io/mcp
```

### Route A — the hook, if you can create app registrations

Off by default, because in a corporate tenant most operators cannot.

```powershell
azd env set IMAGINE_ENTRA_HOOK true
azd provision
azd deploy
```

`infra/hooks/postprovision-entra.ps1` then creates or reuses a single-tenant
registration named `imagine-mcp-<env-name>`, sets both `api://<client-id>` and
the `/mcp` URL as Application ID URIs, declares `access_as_user` as a delegated
scope, pre-authorizes the Azure CLI (`04b07795-8ddb-461a-bbee-02f9e1bf7b46`) and
VS Code (`aebc6443-996d-45c2-90f0-388ff96faa56`), creates the service principal,
and writes `AZURE_MCP_APP_ID` and `IMAGINE_AUTH_CLIENT_ID` back into the `azd`
environment.

**This route was executed on 2026-09-03** in a personal, hotmail-rooted tenant,
and the big open assumption held: Entra accepted `https://<fqdn>/mcp` on an
unverified `azurecontainerapps.io` domain as an Application ID URI, because the
registration is single-tenant. Two things had to be fixed to get there and are
fixed in the repo: the scope declaration and the client pre-authorisation were
sent as one Graph `PATCH`, which Entra silently rejected while the hook reported
success — they are now two calls with an exit-code check on each; and the Azure
CLI was not pre-authorised, so `az account get-access-token --scope
"api://<client-id>/access_as_user"` demanded consent. Both now work without a
prompt.

It never fails the provision. If it prints a warning about permissions, take
route B — nothing is half-created, because it stops before writing.

**Two things the hook cannot do**, and no script can:

- **Admin consent**, if your tenant requires it for delegated scopes. Someone
  with Privileged Role Administrator or Global Administrator runs
  `az ad app permission admin-consent --id <app-id>`. Without it, each user
  consents individually — or, if user consent is disabled tenant-wide, nobody
  can.
- **Grant you the permission to create the registration in the first place.**
  That is the Application Developer role, or an equivalent, and it is granted by
  a human in the directory.

### Route B — the manual registration

Do this in the portal or with `az ad`, then feed the ids to `azd`. This is the
common case in a corporate tenant and it is a supported path, not a
consolation prize.

1. **Entra ID → App registrations → New registration.** Name it
   `imagine-mcp-<env-name>`. Supported account types: **single tenant**. No
   redirect URI — this registration is the API, not a client.
2. **Expose an API → Application ID URI.** Accept the default
   `api://<client-id>`, then **Add** a second one and paste the value of
   `azd env get-value MCP_RESOURCE_URI` exactly: `https`, the FQDN, `/mcp`, and
   **no trailing slash**. If the portal refuses the https URI, check the
   registration really is single-tenant — Entra requires a verified domain for
   multi-tenant apps, not for single-tenant ones. (Confirmed live on
   2026-09-03: an unverified `azurecontainerapps.io` URL is accepted.)
3. **Expose an API → Add a scope.** Name it `access_as_user`, consentable by
   **Admins and users**, and fill the four display strings. This is the value
   `IMAGINE_AUTH_REQUIRED_SCOPE` expects.
4. **Add a client application.** The **Azure CLI**,
   `04b07795-8ddb-461a-bbee-02f9e1bf7b46`, is not optional if you want
   `az account get-access-token` to work without a consent prompt — §7c depends
   on it. Add VS Code / Copilot too if that is a target:
   `aebc6443-996d-45c2-90f0-388ff96faa56`. Tick `access_as_user` on both.
5. Grant admin consent if the tenant requires it.
6. Hand the ids to `azd`:

```powershell
azd env set IMAGINE_AUTH_CLIENT_ID <application-client-id>
azd env set AZURE_MCP_APP_ID <application-client-id>
azd env set IMAGINE_AUTH_TENANT_ID <tenant-id>
```

`azd down` will not remove a registration you made by hand. Section 9 has the
delete command.

---

## 6d. Turn on token validation

The container validates every bearer token itself (ADR 0017). It does that only
once the `IMAGINE_AUTH_*` variables are set on the container app — with none of
them set, the endpoint is open, which is correct locally and wrong here. Do not
leave a provisioned endpoint sitting in that state.

Section 6c must be done first: there is nothing to validate against without a
registration. Then one flag:

```powershell
azd env set IMAGINE_AUTH_ENABLED true
azd up
```

The template sets all four variables for you. `IMAGINE_AUTH_AUDIENCE` gets
**three audiences**, because callers do not agree on what the resource is
called:

- `https://<fqdn>/mcp` — Claude sends the full MCP URL, path included, as the
  RFC 8707 `resource`. Computed by the template from the container app's FQDN
  and always present.
- `api://<client-id>` — what `az account get-access-token --resource
  "api://<app-id>"` asks for. Comes from `IMAGINE_AUTH_CLIENT_ID`.
- the **bare client id**, no scheme — because an Entra **v2** access token
  carries the bare id in `aud` whatever identifier URI the scope was requested
  through. Found the hard way on 2026-09-03; see §7c.

The first two must also exist as Application ID URIs on the app registration, or
the token request itself fails with `AADSTS9010010`. This is the single most
likely thing to break the demo. If you ever set `IMAGINE_AUTH_AUDIENCE` by hand,
it must contain all three.

Do not set these with `az containerapp update`. The next `azd provision` would
drop them again — the template owns the container app's environment.

`access_as_user` must exist as a delegated scope on that app registration, and be
consented to. An autonomous agent with its own service principal gets an **app
role** of the same name instead; the server accepts either.

Half-configured is a startup error by design (ADR 0017), so a container that
crash-loops after this step is telling you one of the four variables is missing
or empty — read the logs rather than guessing.

The banner on the container's stderr says which mode it is in. `az containerapp
logs show --name $app --resource-group $rg` should show `AUTHENTICATED: every
POST to /mcp needs a Microsoft Entra ID bearer token` and the tenant, issuer,
audience and scope underneath it, followed by the `resource:` and `metadata:`
lines — the endpoint URL it will publish and the discovery document it will
serve there (ADR 0021). If it still shows the block-capital UNAUTHENTICATED
warning, the variables did not reach the running revision. If it shows a
block-capital warning about protected-resource metadata instead, it could not
work out its own public URL — §7b says what to look at.

---

## 6e. Or: WorkOS AuthKit in front, so the URL alone is enough

**Take this route instead of 6c/6d if you want to share the endpoint with
people by sending them the URL.** Sections 6c and 6d give you an endpoint that
Claude Code can use with a token from the Azure CLI, and that hosted clients can
only use if you hand-register an OAuth client for each of them. Entra has no
dynamic client registration, so claude.ai, Cowork and Mistral Le Chat stop at
"this connector does not support Dynamic Client Registration".

WorkOS AuthKit becomes the authorization server; Microsoft stays the way people
log in, as a free social provider. The server does not know it is WorkOS — this
is "issuer mode", ADR 0023 — so any DCR-capable OIDC issuer would do.

**You need the deployed MCP URL before you start.** It is the exact string the
dashboard wants:

```powershell
azd env get-value MCP_RESOURCE_URI     # https://ca-imagine-....azurecontainerapps.io/mcp
```

### The WorkOS dashboard checklist

Every step is in the WorkOS dashboard at <https://dashboard.workos.com>, in the
environment you intend to use (Staging and Production are separate; use
Production for a real deployment, and note that its AuthKit domain differs).

1. **Create a WorkOS account and a project**, if you have none. The free tier
   covers a million monthly active users; nothing here needs a paid plan.
2. **AuthKit → note the AuthKit domain.** It looks like
   `your-project.authkit.app`. Your issuer is that with `https://` in front:
   `https://your-project.authkit.app`. **This is value ① to hand back.**
3. **Authentication → enable "Microsoft OAuth"** as a login method. This is the
   free *social* provider, not the paid Enterprise SSO connection — do not buy
   an SSO connection unless you specifically need tenant-restricted login.
   *(Whether WorkOS requires you to register your own Microsoft OAuth
   application, or provides shared credentials, could not be confirmed from
   their documentation — follow whatever the dashboard asks for on that screen.
   If it does ask for a client id and secret, that is an Entra **app
   registration** with the redirect URI WorkOS shows you, and it is the only
   Entra-side action this route needs.)*
4. **Connect → Configuration → MCP Auth: turn on "Client ID Metadata Document
   (CIMD)".** Off by default. This is what the 2026-07-28 MCP revision prefers.
5. **Connect → Configuration → MCP Auth: turn on "Dynamic Client Registration
   (DCR)"** as well, for clients that do not do CIMD yet — Mistral Le Chat is
   documented as a DCR client.
6. **Add your MCP URL as a Resource Indicator**, pasting the
   `MCP_RESOURCE_URI` value exactly: `https`, the FQDN, `/mcp`, no trailing
   slash. **Do not skip this.** Without it AuthKit issues tokens with an
   environment-wide default audience, this server refuses them, and the only
   symptom is a `401` after a successful login. Optionally open the `…` menu
   next to it and **Set as default**.
7. **Note whether the dashboard offers a "default resource indicator"** and
   what audience it uses; if you ever see `401`s after a clean login, this is
   the first thing to re-check.

Two values come back from all of that:

| ① AuthKit issuer | `https://<your-project>.authkit.app` |
| ② MCP URL registered as a Resource Indicator | the `MCP_RESOURCE_URI` string, confirmed present in the dashboard |

No client id and no client secret: that is the entire point. The chat clients
register themselves.

### Point the deployment at it

```powershell
azd env set IMAGINE_AUTH_ENABLED true
azd env set IMAGINE_AUTH_ISSUER https://your-project.authkit.app
azd env set IMAGINE_AUTH_TENANT_ID ""
azd env set IMAGINE_AUTH_REQUIRED_SCOPE ""
azd up
```

`IMAGINE_AUTH_TENANT_ID` **must be empty**: an issuer plus a tenant means "an
Entra tenant reachable at a different issuer URL", and the `tid` check would
then reject every WorkOS token. With it empty the template sets no tenant
variable at all and the server skips that check by design.

`IMAGINE_AUTH_REQUIRED_SCOPE` **must be empty too**. AuthKit publishes only
`openid`, `profile`, `email` and `offline_access`; asking for `access_as_user`
would fail the login at the authorization request, before this server ever sees
a token.

The audience needs nothing: the template already puts `https://<fqdn>/mcp` first
in `IMAGINE_AUTH_AUDIENCE`, and that is precisely what WorkOS stamps into `aud`
for the resource indicator you registered. Two optional variables exist if you
ever need them:

```powershell
azd env set IMAGINE_AUTH_METADATA_URL https://your-project.authkit.app/.well-known/oauth-authorization-server
azd env set IMAGINE_AUTH_AUDIENCE https://your-host/mcp   # replaces the computed list outright
```

Neither is normally needed — discovery is derived from the issuer, trying
`/.well-known/oauth-authorization-server` and then
`/.well-known/openid-configuration`.

### Verify it

```powershell
$fqdn = azd env get-value MCP_ENDPOINT_URL

# 1. The issuer really is an authorization server, and it registers clients.
curl.exe -s "https://your-project.authkit.app/.well-known/oauth-authorization-server"

# 2. Our document points at it.
curl.exe -s "$fqdn/.well-known/oauth-protected-resource/mcp"

# 3. The endpoint still refuses an anonymous call, and points at (2).
curl.exe -i -X POST "$fqdn/mcp" -H "Content-Type: application/json" -d "{}"
```

Check 1 must show a `registration_endpoint` (that is DCR) and `"none"` in
`token_endpoint_auth_methods_supported` (that is what lets a public client
register without a secret). Check 2 must show
`"authorization_servers": ["https://your-project.authkit.app"]` and a
`resource` equal to your endpoint URL exactly. Check 3 must be a `401` with
`WWW-Authenticate: Bearer resource_metadata="…"` — note that in this mode there
is deliberately no `scope=` in the challenge.

The container's logs should show `AUTHENTICATED: every POST to /mcp needs a
bearer token from the issuer below`, with
`tenant: none configured, so the tid claim is not checked` and
`required scope: none` under it.

Then the actual test, and the reason for all of it: in **Mistral Le Chat** or
**claude.ai** (Settings → Connectors → Add custom connector), paste
`https://<fqdn>/mcp` and nothing else. No client id, no secret. It should send
you to a WorkOS login page, offer "Continue with Microsoft", and come back
connected.

> **Not yet executed live.** As of 2026-09-04 nobody has run this route against
> a real WorkOS account and a real deployment. The server side is covered by
> tests against a fake issuer; the dashboard labels above come from WorkOS's
> documentation on 2026-09-04 and may be worded differently on screen.

---

## 6f. Make the images visible: turn on the blob sink

**Symptom this fixes.** A chat client asks for a picture, everything succeeds,
and the client shows a broken image. Look at the tool result and you will see
something like `"path": "/app/imagine-output/a-lighthouse-7f3ac91d.png"`. That
is a directory inside the container. The client cannot open it, and the next
deploy erases it anyway.

The fix is to store the images in Blob Storage and hand back a link.

### Turn it on

```powershell
azd env set IMAGINE_OUTPUT_SINK blob
azd up
```

That provisions, in your existing resource group:

- a StorageV2 account, `st<token>` — HTTPS only, TLS 1.2 minimum, public blob
  access **off**, shared key access **off**;
- one blob container, `images`;
- **Storage Blob Data Contributor** for the container app's identity, scoped to
  that container, so it can write;
- **Storage Blob Delegator** for the same identity, scoped to the storage
  account, so it can sign a read link. (Account scope is not a mistake — the
  key-signing action does not exist at container scope.)

Nothing else changes. No key and no connection string is created; the identity
is the only way in.

### What the server does with it

`azd up` sets three environment variables on the container app —
`IMAGINE_OUTPUT_SINK`, `IMAGINE_OUTPUT_BLOB_ACCOUNT_URL` and
`IMAGINE_OUTPUT_BLOB_CONTAINER` — so there is nothing to paste by hand. Every
`generate_image` result now carries a `url` next to `path`: a signed link to
that one image, valid for an hour, that opens without any Azure sign-in.

To make links live longer, up to a week:

```powershell
azd env set IMAGINE_OUTPUT_BLOB_URL_TTL_HOURS 8
azd up
```

If you would rather control it from your config fragment, an `output` section in
`IMAGINE_CONFIG_JSON` wins over all three variables.

### Verify it

The real verification is the one that failed before: **generate an image from a
chat client and look at it.**

In Mistral Le Chat, claude.ai or Claude Code, connected as in section 8, ask for
a picture. You should see the image itself, not a placeholder. Then check the
result envelope: `path` should be an `https://st….blob.core.windows.net/images/…`
URL, and `url` the same thing with `?sp=r&…&sig=…` after it.

From the shell, the same thing without a client:

```powershell
azd env get-value MCP_OUTPUT_BLOB_URL
# https://st....blob.core.windows.net/images

az storage blob list --account-name (azd env get-value AZURE_STORAGE_ACCOUNT_NAME) `
  --container-name images --auth-mode login --query "[].name" -o tsv

# The link handed back really does need no credentials - paste it and expect 200:
curl.exe -s -o NUL -w "%{http_code}`n" "<the url from the tool result>"

# And the blob really is not public - the same URL without the query string:
curl.exe -s -o NUL -w "%{http_code}`n" "<the path from the tool result>"
```

The first `curl` must print `200`, the second `404` — Azure hides a blob it will
not serve rather than admitting it exists.

> **A first 403 is not a broken deployment.** The role assignments are made in
> the same deployment as they are used, and Entra replicates them at its own
> pace. If the first image after this `azd up` comes back
> `auth_failed … status 403`, wait a minute and ask again. Same caveat as the
> Foundry role in section 6b.

### Switching back, and what it costs

```powershell
azd env set IMAGINE_OUTPUT_SINK local
azd up
```

The storage account and every image in it are removed. `azd down` removes them
too.

At this volume, storage is cents per month. There is no lifecycle rule, so
images accumulate until you delete them — as does the fact that the manifest and
the cost log are still on the container's ephemeral disk. Both are
[#45](https://github.com/hoeloe15/imagine/issues/45).

> **Not yet executed live.** As of 2026-09-04 the blob sink has not been run
> against a real storage account. `az bicep build` passes, the upload and the
> link signing are covered by unit tests with an injected `fetch`, and the
> string-to-sign is pinned against the format Microsoft documents for service
> version `2020-12-06`. The first real run is the test of that.

---

## 7. Verify the deployed endpoint

Three checks, in order. Do not skip to the client until all three pass — the
client-side error messages are far worse than the HTTP ones. All three were run
with `curl.exe` against the public endpoint on 2026-09-03 and pass; the
responses quoted below are what came back, not what was expected.

**7a. It is alive.**

```powershell
$fqdn = azd env get-value MCP_ENDPOINT_URL
curl.exe -i "$fqdn/healthz"
```

Expect `200`. (Use `curl.exe`, not PowerShell's `curl` alias, which is
`Invoke-WebRequest` and formats differently.)

**7b. It challenges.** With auth enabled (#37), an unauthenticated request to the
MCP endpoint must be a `401` **carrying a `WWW-Authenticate` header with a
`resource_metadata` pointer**. This is not cosmetic: without it, claude.ai and
Claude Desktop cannot begin the OAuth flow and report "Couldn't reach the MCP
server".

```powershell
curl.exe -i -X POST "$fqdn/mcp" -H "Content-Type: application/json" -d "{}"
curl.exe -i "$fqdn/.well-known/oauth-protected-resource/mcp"
curl.exe -i "$fqdn/.well-known/oauth-protected-resource"
```

Expect on the first a `401` whose header reads

```
WWW-Authenticate: Bearer resource_metadata="https://<fqdn>/.well-known/oauth-protected-resource/mcp", scope="access_as_user"
```

and on both of the others a `200` with JSON whose `resource` field equals the
endpoint URL **exactly**, path included, no trailing slash — and whose
`authorization_servers` has one entry, your tenant's
`https://login.microsoftonline.com/<tenant>/v2.0`.

The container serves all of this itself (ADR 0021). The template configures no
platform ("Easy Auth") authentication and that is now a permanent decision, not
a gap: platform auth in `Return401` mode would answer the unauthenticated
request in front of the container and would stand in front of `/.well-known/*`,
which is the one route that has to answer without a token. Do not turn it on.

If the metadata comes back `404`, the container could not work out its own
public URL, and the stderr banner will say so in block capitals instead of
printing `resource:` and `metadata:` lines. That should not happen here: the
server derives the URL from the first `IMAGINE_AUTH_AUDIENCE` entry, and the
template always puts `https://<fqdn>/mcp` first. If it does happen, read
`IMAGINE_AUTH_AUDIENCE` off the running revision — something has reordered or
replaced it.

Two variables override that derivation — `IMAGINE_PUBLIC_URL` (the public
origin) and `IMAGINE_MCP_RESOURCE_URI` (the whole endpoint URL, for a proxy on a
different path). The template does not set either yet; passing
`IMAGINE_MCP_RESOURCE_URI` through from the Bicep's `mcpResourceUri` is a
one-line follow-up on the infrastructure issue and would remove the last piece
of inference.

**7c. It answers a real tool call.** Get a token and call
`list_capabilities` — read-only, costs nothing, and tells you whether the key
reached the container:

```powershell
$appId = azd env get-value AZURE_MCP_APP_ID
$token = az account get-access-token --resource "api://$appId" --query accessToken -o tsv
curl.exe -s -X POST "$fqdn/mcp" `
  -H "Content-Type: application/json" `
  -H "Accept: application/json, text/event-stream" `
  -H "Authorization: Bearer $token" `
  -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"list_capabilities\",\"arguments\":{}}}'
```

On 2026-09-03 this returned `200` and a `tools/list` showed all three tools, so
the token path is proven end to end. Look for `openrouter` with status `ready`.
If it says `not_configured` and names `OPENROUTER_API_KEY`, the secret did not
reach the container — go back to step 6 and restart the revision. (On that run
it correctly said `not_configured`: no key had been set.)

If instead you get `AADSTS9010010` when acquiring the token, the endpoint URL is
not registered as an Application ID URI on the app registration. Add it under
**Expose an API → Application ID URI**, exactly, including the `/mcp` path and
with no trailing slash. See §6c.

Two more failures seen on the live run of 2026-09-03, both fixed in the repo but
worth recognising:

- `AADSTS65001` / `consent_required` when acquiring the token with the Azure
  CLI: the CLI's own app is not pre-authorised on the `access_as_user` scope.
  The hook now pre-authorises it (and VS Code); on a hand-registered app, add
  both under **Expose an API → Authorized client applications**.
- `401` with `error_description="The token was minted for another resource"`
  although the token was requested for `api://<client-id>/access_as_user`:
  Entra v2 access tokens carry the **bare client id** as `aud`, whatever
  identifier URI the scope was requested through. The template therefore lists
  the bare id as an accepted audience next to the URL and `api://` forms; a
  hand-set `IMAGINE_AUTH_AUDIENCE` must include it too.

**7d. It refuses what it should refuse.** The rejection paths are unit-tested
with locally minted keys, but only a live tenant proves the deployed
configuration. Three tokens, all of which must fail. The third — no token at all
— is the one 7b already exercised live; run the other two as well:

```powershell
# A token for a resource this server does not accept: expect 401, invalid_token.
$wrong = az account get-access-token --resource "https://graph.microsoft.com" --query accessToken -o tsv
curl.exe -i -X POST "$fqdn/mcp" -H "Content-Type: application/json" `
  -H "Accept: application/json, text/event-stream" -H "Authorization: Bearer $wrong" -d "{}"

# A mangled signature: expect 401, invalid_token.
curl.exe -i -X POST "$fqdn/mcp" -H "Content-Type: application/json" `
  -H "Accept: application/json, text/event-stream" -H "Authorization: Bearer $($token)x" -d "{}"

# No token at all: expect 401 and a bare `WWW-Authenticate: Bearer` challenge.
curl.exe -i -X POST "$fqdn/mcp" -H "Content-Type: application/json" -d "{}"
```

An expired token is the fourth case and needs no special ceremony: keep the token
from 7c for an hour and repeat the call, which must then answer `401`. A caller
who is authenticated but lacks `access_as_user` gets `403` with
`error="insufficient_scope"` — remove the consent, or use a service principal
without the app role, to see it.

If any of these returns `200`, stop and treat it as a security finding: the
container is not enforcing what section 6d configured.

---

## 8. Connect Claude to it

Full detail, including the hosted surfaces, is #48. The short version, by
client.

### Claude Code — a token, to prove it works

```powershell
$appId = azd env get-value AZURE_MCP_APP_ID
$fqdn  = azd env get-value MCP_ENDPOINT_URL
$token = az account get-access-token --resource "api://$appId" --query accessToken -o tsv
claude mcp add --transport http imagine "$fqdn/mcp" --header "Authorization: Bearer $token"
```

Then ask Claude for a picture. This works, and the token expires in about an
hour, so treat it as a proof rather than a setup.

### Claude Code — the one you actually keep

`.mcp.json` supports `headersHelper`, a script Claude Code runs to produce the
headers for each request. Pointed at the Azure CLI, it refreshes the token by
itself:

```json
{
  "mcpServers": {
    "imagine": {
      "type": "http",
      "url": "https://<fqdn>/mcp",
      "headersHelper": "C:\\Users\\mark9\\.imagine\\mcp-auth-headers.ps1"
    }
  }
}
```

> **Blocked on #48**, which ships the script and the tested invocation. The shape
> of it is `az account get-access-token --resource api://<app-id>` printed as an
> `Authorization` header.

### claude.ai and Claude Desktop — a custom connector

These need real OAuth, not a header. Entra does not offer dynamic client
registration in the shape Claude wants, so there are two routes: **§6e**, which
puts WorkOS AuthKit in front and lets the client register itself so the URL
alone is enough, or — staying on Entra — a
**pre-registered OAuth client**: create a second app registration for the client,
consent it to the API's `access_as_user` scope, and paste its Client ID (and
secret, if you make it confidential) into **Advanced settings** when adding the
custom connector by URL.

Two things that will otherwise waste an afternoon:

- The connector's redirect URI is `https://claude.ai/api/mcp/auth_callback`.
- claude.ai reaches your server from Anthropic's egress range
  `160.79.104.0/21`, over the public internet. An IP restriction or private
  endpoint that leaves Claude Code working will silently break the hosted
  surfaces, and the error you get says "Couldn't reach the MCP server".

The **server** half of this is verified live (2026-09-03): the endpoint
challenges with a `resource_metadata` pointer and serves the document it points
at (§7b, ADR 0021), which is what lets the connector dialog get as far as asking
Entra for a token. The **client** half is not: nobody has yet completed a
claude.ai or Cowork connector login against this deployment. That, plus the
**client registration** above — pasting a pre-registered Client ID — is #48.

---

## 9. Tear it down

> **Not yet executed live.** The 2026-09-03 run was left standing. Whether
> `predown` fires before the resources go is still an open question.

```powershell
azd down --purge
```

`--purge` also purges the soft-deleted Key Vault; without it, redeploying with
the same name fails on a name still held by the deleted vault.

A `predown` hook (`infra/hooks/predown-entra.ps1`) deletes the app registration
first, but only the one it created itself — that is, only when
`IMAGINE_ENTRA_HOOK` is `true` and `AZURE_MCP_APP_ID` is in the environment. A
registration you made by hand in route B is yours to remove. Check either way:

```powershell
az ad app list --display-name "imagine-mcp" --query "[].{name:displayName, id:appId}" -o table
```

Delete a leftover by hand:

```powershell
az ad app delete --id <app-id>
```

---

## Verified on the first run

Executed 2026-09-03 against a live subscription in a personal, hotmail-rooted
tenant.

- [x] `azd up` accepts the boolean parameters as `"${VAR=false}"` strings in
      `main.parameters.json`. No change to string parameters needed.
- [x] **Entra accepts `https://<fqdn>/mcp` as an Application ID URI** on an
      unverified `azurecontainerapps.io` domain, for a single-tenant
      registration (§6c). This was the assumption the whole auth story rested
      on; it holds.
- [x] The Entra hook works from a personal tenant, creating a single-tenant
      registration. Its first version silently failed the Graph `PATCH` because
      it sent the scope declaration and the client pre-authorisation in one
      request; now split, with an exit-code check on each. It also
      pre-authorises the Azure CLI, so
      `az account get-access-token --scope "api://<client-id>/access_as_user"`
      succeeds without a consent prompt.
- [x] Entra **v2** access tokens carry the **bare client id** as `aud`. The
      template now lists it as an accepted audience alongside the URL and
      `api://` forms (§6d, §7c).
- [x] The role assignments propagate in time — the first `azd up` needed no
      re-run for #43. It did fail once on `RoleDefinitionDoesNotExist`, because
      the template carried an invented GUID for Key Vault Secrets Officer;
      fixed in `911edea` (the real one is
      `b86a8fe4-44ce-4948-aee5-eccb2c155cd7`).
- [x] With auth on, verified with `curl.exe` against the public endpoint:
      `GET /.well-known/oauth-protected-resource/mcp` returns the RFC 9728
      document; `POST /mcp` without a token returns `401` with
      `WWW-Authenticate: Bearer resource_metadata=…, scope="access_as_user"`;
      with a real token, `200`, and `tools/list` shows all three tools.
- [x] **Wall-clock `azd up`: about two minutes** — provision 1m20 to 1m45,
      deploy 25 to 30 seconds. Incremental re-runs are comparable.
- [x] Admin consent was **not** required in this tenant.
- [x] A bare `azd provision` after a deploy does revert the app to the GHCR
      `edge` image, as §5 warns. `azd up` is the habit; the postdeploy hook's
      advice says so too.

## Still open

Not exercised on 2026-09-03, and still a guess until someone runs it.

- [ ] The whole of §6: a provider key in the vault, the two-pass
      `IMAGINE_*_SECRET_IN_VAULT` flow, and whether the Key Vault reference is
      really picked up by a plain revision restart after
      `az keyvault secret set`, with no redeploy.
- [ ] The whole of §6b: managed-identity Azure OpenAI end to end. (The
      `IMAGINE_CONFIG_JSON` round trip is answered: it does **not** survive with
      raw quotes — escape them as §6b now shows. Verified 2026-09-04.)
- [ ] Whether `resource=https://ai.azure.com` is the resource the Foundry data
      plane actually accepts, as opposed to
      `https://cognitiveservices.azure.com` (the `AZURE_ENTRA_SCOPE` question).
- [ ] Whether the Container Apps identity endpoint answers on api-version
      `2019-08-01` with `expires_on` as epoch seconds, and whether
      `AZURE_CLIENT_ID` is required or merely accepted with one user-assigned
      identity (ADR 0022).
- [ ] How long the Cognitive Services OpenAI User assignment takes to propagate
      before the first `generate_image` stops returning 403 (§6b).
- [ ] Whether a hosted Claude surface — claude.ai or Cowork — actually completes
      the custom-connector login against this endpoint (#36, #48, ADR 0021).
      The server side is verified (§7b); Claude's own client-side behaviour
      against a live tenant is not.
- [ ] The whole of §6e: a real WorkOS account, the dashboard toggles as they are
      actually labelled, whether an AuthKit domain also serves
      `/.well-known/openid-configuration`, whether Microsoft social login needs
      an Entra app registration of its own, and whether a hosted client really
      does add the connector with only the URL (#56, ADR 0023).
- [ ] Whether `predown` actually runs on `azd down --purge` before the resources
      go, and deletes the registration it created (§9).
- [ ] Actual monthly cost.

