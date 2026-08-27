# Deploying imagine to Azure — operator runbook

Windows, PowerShell 7. This is a runbook to execute later, step by step, by a
human at a keyboard. It covers only the parts a human must do: the sign-ins, the
subscription choice, the one secret, and the client connection. Everything else
is `azd`'s job.

**Nothing in Phase 3 is implemented yet.** Steps that depend on unmerged work say
so, by issue number, rather than pretending. Do not follow this end to end
today; follow it as those issues land, and correct it where reality disagrees —
a runbook that was never executed is a wish list.

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

If you do not have the app-registration permission, stop and read the manual
fallback in #44 before provisioning: the registration is created by hand and its
ids are fed to `azd` as environment values. In a corporate tenant this is the
normal case, not the exception.

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

**Cost.** A Container Apps environment with min replicas 1 (which the template
sets deliberately — scale-to-zero cold starts are visible inside a tool call and
read to the user as a broken connector), a Key Vault, a storage account and a
Log Analytics workspace. Small, but not zero, and it runs whether or not anyone
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

> **Blocked on #40** — there is no `azure.yaml` or `infra/` in the repo yet. Once
> that lands, from the repo root:

```powershell
cd C:\Users\mark9\Shippable\imagine
azd env new imagine-dev
azd env set AZURE_SUBSCRIPTION_ID <subscription-id>
azd env set AZURE_LOCATION westeurope
```

Pick a region that supports Container Apps and is near you; `westeurope` is the
obvious choice from the Netherlands.

Check what the environment holds before provisioning:

```powershell
azd env get-values
```

---

## 5. Provision and deploy

> **Blocked on #40** (and, for a complete deployment, #41, #43 and #44).

```powershell
azd up
```

This provisions the infrastructure, builds the container image, pushes it to the
registry and deploys the container app. Expect the first run to take on the order
of ten minutes. It prints the endpoint FQDN at the end; keep it.

Retrieve it again at any time:

```powershell
azd env get-value MCP_ENDPOINT_URL
```

**If the first run fails on a role assignment with a 403**, that is Entra
propagation delay, not a broken template — a role assignment made in the same
deployment as the identity it grants can land before the identity is visible.
Re-run `azd up`. See #43.

**If the app registration step fails**, you almost certainly lack the tenant
permission from step 0. Take the manual fallback in #44.

---

## 6. Set the OpenRouter key

The template deliberately does not contain the key. It provisions the vault and
grants the container's managed identity read access; you put the value in, once,
by hand.

> **Blocked on #41.**

```powershell
$vault = azd env get-value AZURE_KEY_VAULT_NAME
az keyvault secret set --vault-name $vault --name openrouter-api-key --value "<paste the key>"
```

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

Rotation later is this same pair of commands and nothing else.

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

> **Blocked on #36 and #38.** Whether the platform's built-in auth lets our own
> `/.well-known/*` route answer is the open question #38 exists to settle. If
> this check fails after #36 has merged, that is the finding, not a mistake.

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
with no trailing slash. See #44.

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

> **Blocked on #36, #37, #44 and #48.**

---

## 9. Tear it down

```powershell
azd down --purge
```

`--purge` also purges the soft-deleted Key Vault; without it, redeploying with
the same name fails on a name still held by the deleted vault.

Then check that the app registration is gone too — `azd down` removes the
resources it provisioned, and whether it removes the Entra registration depends
on how #44 creates it:

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

- [ ] Exact `azd env` output variable names (§5, §6, §7) — they are whatever #40
      names them, not necessarily what is written here.
- [ ] Whether the `/.well-known/*` route answers with built-in auth enabled
      (#38).
- [ ] Whether `azd down` removes the app registration (#44).
- [ ] Actual `azd up` wall-clock time and actual monthly cost.
- [ ] Whether admin consent was required in this tenant, and who granted it.
