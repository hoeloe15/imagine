# Deploying imagine to Azure — operator runbook

Windows, PowerShell 7. This is a runbook to execute later, step by step, by a
human at a keyboard. It covers only the parts a human must do: the sign-ins, the
subscription choice, the one secret, and the client connection. Everything else
is `azd`'s job.

The container image (#39), the `azd` template (#40), Key Vault credentials (#41)
and the Entra registration hook (#44) are in the repo. Nothing here has been run
against a live subscription yet, so follow it and correct it where reality
disagrees — a runbook that was never executed is a wish list. Steps that still
depend on unmerged work say so by issue number rather than pretending.

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
pushes it to the registry. A stopped Docker daemon produces an `azd up` failure
several minutes in.

The image is built from [`Containerfile`](../../Containerfile), not a
`Dockerfile`, which is why `azure.yaml` names it explicitly
(`docker: { path: ./Containerfile }`). Prove the build before you provision
anything — it is a minute here versus ten minutes into `azd up`:

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
registry and deploys the container app. Expect the first run to take on the order
of ten minutes. It prints the endpoint FQDN at the end; keep it.

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
Re-run `azd up`. See #43.

**The app registration step cannot fail this run**: it is off by default and is
section 6c's business, not `azd up`'s.

---

## 6. Set the OpenRouter key

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
up on the next container start. Verify that on the first run and correct this
paragraph if it turns out to be wrong.

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
scope, pre-authorizes VS Code
(`aebc6443-996d-45c2-90f0-388ff96faa56`), creates the service principal, and
writes `AZURE_MCP_APP_ID` and `IMAGINE_AUTH_CLIENT_ID` back into the `azd`
environment.

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
   multi-tenant apps, not for single-tenant ones.
3. **Expose an API → Add a scope.** Name it `access_as_user`, consentable by
   **Admins and users**, and fill the four display strings. This is the value
   `IMAGINE_AUTH_REQUIRED_SCOPE` expects.
4. **Add a client application**, if VS Code or Copilot is a target:
   `aebc6443-996d-45c2-90f0-388ff96faa56`, ticking `access_as_user`.
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

The template sets all four variables for you. `IMAGINE_AUTH_AUDIENCE` gets **two
audiences**, because two clients ask for two different resources: Claude sends
the **full MCP URL including `/mcp`** as the RFC 8707 `resource`, while
`az account get-access-token --resource "api://<app-id>"` gets you the default
one. The first is computed by the template from the container app's FQDN and is
always present; the second comes from `IMAGINE_AUTH_CLIENT_ID`. Both must be
Application ID URIs on the app registration or the token request fails with
`AADSTS9010010`. This is the single most likely thing to break the demo.

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
audience and scope underneath it. If it still shows the block-capital
UNAUTHENTICATED warning, the variables did not reach the running revision.

---

## 7. Verify the deployed endpoint

Three checks, in order. Do not skip to the client until all three pass — the
client-side error messages are far worse than the HTTP ones.

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
curl.exe -i "$fqdn/.well-known/oauth-protected-resource"
```

Expect `401` plus the header on the first, and `200` with JSON on the second,
whose `resource` field equals the endpoint URL **exactly**, path included, no
trailing slash.

> **Blocked on #36 and #38.** The template configures no platform ("Easy Auth")
> authentication at all — that is deliberate, and ADR 0020 says why: #38 is the
> spike that would settle whether Easy Auth can serve protected-resource
> metadata, and it has not run. So this route can only answer once #36 ships it
> in our own code. If it still fails after #36 has merged, that is the finding,
> not a mistake.

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

Look for `openrouter` with status `ready`. If it says `not_configured` and names
`OPENROUTER_API_KEY`, the secret did not reach the container — go back to step 6
and restart the revision.

If instead you get `AADSTS9010010` when acquiring the token, the endpoint URL is
not registered as an Application ID URI on the app registration. Add it under
**Expose an API → Application ID URI**, exactly, including the `/mcp` path and
with no trailing slash. See §6c.

**7d. It refuses what it should refuse.** The rejection paths are unit-tested
with locally minted keys, but only a live tenant proves the deployed
configuration. Three tokens, all of which must fail:

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
registration in the shape Claude wants, so the working route is a
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

> **Blocked on #36 and #48.** The registration side (#44) is section 6c.

---

## 9. Tear it down

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

## Open items to correct on first real run

Fill these in the first time this is executed against a live subscription; each
one is a guess until then.

Nothing below this line has been executed against a live subscription. The
template's Bicep compiles and the hooks parse; that catches syntax and type
errors and nothing else.

- [ ] Whether `azd` accepts the boolean parameters as `"${VAR=false}"` strings in
      `main.parameters.json`, or whether they have to become string parameters.
- [ ] Whether the Key Vault reference really is picked up by a plain revision
      restart after `az keyvault secret set`, with no redeploy (§6).
- [ ] Whether Entra accepts `https://<fqdn>/mcp` as an Application ID URI on an
      unverified `azurecontainerapps.io` domain for a single-tenant app (§6c).
      This is the assumption the whole auth story rests on.
- [ ] Whether the Graph PATCH in the postprovision hook is accepted as written,
      including `requestedAccessTokenVersion: 2`.
- [ ] Whether the AcrPull / Key Vault Secrets User role assignments propagate
      before the container app is created, or whether the first `azd up` needs
      a re-run (#43).
- [ ] Whether the `/.well-known/*` route answers (#36, #38).
- [ ] Whether `predown` actually runs on `azd down` before the resources go.
- [ ] Actual `azd up` wall-clock time and actual monthly cost.
- [ ] Whether admin consent was required in this tenant, and who granted it.

