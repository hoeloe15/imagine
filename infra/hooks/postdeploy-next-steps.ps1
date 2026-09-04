#!/usr/bin/env pwsh
# Prints what is still open after `azd up`, read back from the azd environment
# rather than assumed: whether the endpoint is authenticated, whether a provider
# credential has reached it, and the exact command for each gap.
#
# `azd up` leaves a reachable endpoint that is open and has no key. That is a
# deliberate intermediate state (ADR 0020), and the failure mode is an operator
# who does not know it is one. Hence this block.
#
# Prints only. It never provisions, never writes to the environment, and never
# fails the deploy.

$ErrorActionPreference = 'Continue'

function Get-AzdValue([string]$Name) {
    $fromEnv = [Environment]::GetEnvironmentVariable($Name)
    if ($fromEnv) { return $fromEnv }
    $value = (azd env get-value $Name 2>$null)
    if ($LASTEXITCODE -ne 0) { return '' }
    return $value.Trim()
}

$endpoint = Get-AzdValue 'MCP_ENDPOINT_URL'
if (-not $endpoint) {
    Write-Host 'Next steps: no MCP_ENDPOINT_URL in the azd environment yet. Run `azd up` first.'
    exit 0
}

$mcpUrl = Get-AzdValue 'MCP_RESOURCE_URI'
if (-not $mcpUrl) { $mcpUrl = "${endpoint}/mcp" }

$authEnabled = (Get-AzdValue 'IMAGINE_AUTH_ENABLED') -eq 'true'
$entraHook = (Get-AzdValue 'IMAGINE_ENTRA_HOOK') -eq 'true'
$appId = Get-AzdValue 'AZURE_MCP_APP_ID'
if (-not $appId) { $appId = Get-AzdValue 'IMAGINE_AUTH_CLIENT_ID' }

$openRouterInVault = (Get-AzdValue 'IMAGINE_OPENROUTER_SECRET_IN_VAULT') -eq 'true'
$azureOpenAiInVault = (Get-AzdValue 'IMAGINE_AZURE_OPENAI_SECRET_IN_VAULT') -eq 'true'
$foundryResourceId = Get-AzdValue 'IMAGINE_FOUNDRY_RESOURCE_ID'
$configJson = Get-AzdValue 'IMAGINE_CONFIG_JSON'
$vault = Get-AzdValue 'AZURE_KEY_VAULT_NAME'
if (-not $vault) { $vault = '<vault>' }

Write-Host ''
Write-Host 'Next steps'
Write-Host '=========='
Write-Host ''
Write-Host "  Endpoint: $mcpUrl"
Write-Host "  Health:   ${endpoint}/healthz  (open with or without auth)"
Write-Host ''

$authIssuer = Get-AzdValue 'IMAGINE_AUTH_ISSUER'
$authTenant = Get-AzdValue 'IMAGINE_AUTH_TENANT_ID'
$issuerMode = $authIssuer -and -not $authTenant

if ($authEnabled -and $issuerMode) {
    Write-Host "  Authentication: ON, in issuer mode. Every POST to /mcp needs a bearer"
    Write-Host "  token from $authIssuer, which this server verifies itself."
    Write-Host ''
    Write-Host "    Login discovery: ${endpoint}/.well-known/oauth-protected-resource/mcp"
    Write-Host ''
    Write-Host '    Cowork / claude.ai / Mistral Le Chat: add a custom connector with'
    Write-Host '    this URL and nothing else - no client id, no secret:'
    Write-Host "      $mcpUrl"
    Write-Host ''
    Write-Host '    In the issuer dashboard, this exact URL must be registered as a'
    Write-Host '    resource indicator, or every token comes back with the wrong'
    Write-Host '    audience and this server answers 401. Runbook section 6e.'
} elseif ($authEnabled) {
    Write-Host '  Authentication: ON. Every POST to /mcp needs a Microsoft Entra ID'
    Write-Host '  bearer token that this server verifies itself.'
    Write-Host ''
    Write-Host "    Login discovery: ${endpoint}/.well-known/oauth-protected-resource/mcp"
    Write-Host ''
    Write-Host '    Cowork / claude.ai: add a custom connector with this URL, and'
    Write-Host '    Claude finds the tenant and shows the Microsoft login itself:'
    Write-Host "      $mcpUrl"
    Write-Host ''
    Write-Host '    Claude Code, with a token (expires in about an hour, so it is a'
    Write-Host '    proof rather than a setup):'
    if ($appId) {
        Write-Host "      `$token = az account get-access-token --resource `"api://$appId`" --query accessToken -o tsv"
    } else {
        Write-Host '      $appId = azd env get-value AZURE_MCP_APP_ID'
        Write-Host '      $token = az account get-access-token --resource "api://$appId" --query accessToken -o tsv'
    }
    Write-Host "      claude mcp add --transport http imagine `"$mcpUrl`" --header `"Authorization: Bearer `$token`""
    Write-Host ''
    Write-Host '    The registration is single-tenant: only identities in this tenant'
    Write-Host '    can sign in. Another tenant means another azd env and another azd up.'
} else {
    Write-Host '  Authentication: OFF. Anyone who can reach this URL can call it.'
    Write-Host '  Do not put a provider key in the vault while it is off - an open'
    Write-Host '  endpoint with no credentials costs a stranger nothing, an open'
    Write-Host '  endpoint with your key spends your money.'
    Write-Host ''
    Write-Host '    Turn it on:'
    if (-not $entraHook -and -not $appId) {
        Write-Host '      azd env set IMAGINE_ENTRA_HOOK true    # or register the app by hand'
    }
    Write-Host '      azd env set IMAGINE_AUTH_ENABLED true'
    Write-Host '      azd up'
    Write-Host ''
    Write-Host '    Registering the app needs a tenant permission azd cannot grant'
    Write-Host '    itself. If the hook warns about permissions, section 6c of the'
    Write-Host '    runbook has the manual route.'
}

Write-Host ''

Write-Host '  OpenRouter: the server reads the key from Key Vault itself, at the'
Write-Host '  moment a call needs it. One command, no redeploy, live within a minute:'
Write-Host ''
Write-Host "      az keyvault secret set --vault-name $vault --name openrouter-api-key --value `"<key>`""
Write-Host ''
if (-not $authEnabled) {
    Write-Host '  Turn authentication on BEFORE you run it. An open endpoint with no'
    Write-Host '  credentials costs a stranger nothing; an open endpoint with your key'
    Write-Host '  spends your money.'
    Write-Host ''
}
Write-Host '  Check it landed by calling list_capabilities: openrouter should read'
Write-Host '  "status": "ready" with "key_source": "vault".'
if ($openRouterInVault) {
    Write-Host ''
    Write-Host '  IMAGINE_OPENROUTER_SECRET_IN_VAULT is also on, so the same secret is'
    Write-Host '  mapped onto OPENROUTER_API_KEY as a Key Vault reference. That is'
    Write-Host '  optional now and only refreshes on a revision restart; the vault read'
    Write-Host '  above is what actually keeps the key current.'
}

Write-Host ''

if ($foundryResourceId) {
    Write-Host '  Azure OpenAI: keyless. The container identity has Cognitive Services'
    Write-Host "  OpenAI User on $foundryResourceId"
    if (-not $configJson) {
        Write-Host '  But IMAGINE_CONFIG_JSON is empty, so no azure provider is configured.'
        Write-Host '  See section 6b of the runbook for the fragment.'
    }
} elseif ($azureOpenAiInVault) {
    Write-Host '  Azure OpenAI: key in Key Vault, mapped to AZURE_OPENAI_API_KEY.'
} else {
    Write-Host '  Azure OpenAI: not configured. Optional. Keyless is the recommended'
    Write-Host '  shape - the container identity gets the token, no key exists:'
    Write-Host '      $config = ''{"providers":{"azure":{"enabled":true,"auth":"entra","endpoint":"https://<resource>.openai.azure.com","deployments":{"gpt-image-2":"<deployment>"}}}}'''
    Write-Host '      azd env set IMAGINE_CONFIG_JSON ($config -replace ''"'', ''\"'')   # quotes must be escaped: the value is spliced into main.parameters.json'
    Write-Host '      azd env set IMAGINE_FOUNDRY_RESOURCE_ID "/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.CognitiveServices/accounts/<account>"'
    Write-Host '      azd up'
}

Write-Host ''

$blobContainerUrl = Get-AzdValue 'MCP_OUTPUT_BLOB_URL'
if ($blobContainerUrl) {
    Write-Host '  Images: stored in Blob Storage. Every generate_image result carries a'
    Write-Host '  url alongside path - a link that expires, which a chat client can render.'
    Write-Host "      $blobContainerUrl"
} else {
    Write-Host '  Images: written to the container filesystem, which no chat client can'
    Write-Host '  reach and which is emptied on every revision. Over stdio that is right;'
    Write-Host '  hosted it means a broken image. Switch to Blob Storage:'
    Write-Host '      azd env set IMAGINE_OUTPUT_SINK blob'
    Write-Host '      azd up'
    Write-Host '  Runbook section 6f.'
}

Write-Host ''
Write-Host '  Full runbook, including verification and teardown:'
Write-Host '    docs/deploy/azure-wizard.md'
Write-Host ''
