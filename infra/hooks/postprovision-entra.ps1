#!/usr/bin/env pwsh
# Creates or updates the Entra app registration that represents the MCP server
# as a protected API (#44), and registers the deployed endpoint URL — path
# included — as an Application ID URI. Without that exact URI, Claude's token
# request fails with AADSTS9010010, because Claude sends the full MCP URL as the
# RFC 8707 `resource` (research §3.3).
#
# Runs as an azd postprovision hook and not preprovision, because the FQDN does
# not exist until the container app does.
#
# It is opt-in and never fails the provision: creating app registrations is a
# tenant permission azd cannot grant itself, and in a corporate tenant the
# operator usually does not have it. The manual fallback is in
# docs/deploy/azure-wizard.md §6c.

$ErrorActionPreference = 'Stop'

$VSCodeClientId = 'aebc6443-996d-45c2-90f0-388ff96faa56'
# Pre-authorising the Azure CLI lets the operator test the endpoint with
# `az account get-access-token --scope api://<client-id>/access_as_user`
# without a consent prompt. Claude and other OAuth clients still consent.
$AzureCliClientId = '04b07795-8ddb-461a-bbee-02f9e1bf7b46'

function Get-AzdValue([string]$Name) {
    $fromEnv = [Environment]::GetEnvironmentVariable($Name)
    if ($fromEnv) { return $fromEnv }
    $value = (azd env get-value $Name 2>$null)
    if ($LASTEXITCODE -ne 0) { return '' }
    return $value.Trim()
}

if ((Get-AzdValue 'IMAGINE_ENTRA_HOOK') -ne 'true') {
    Write-Host 'Entra app registration hook is off. Enable it with:'
    Write-Host '  azd env set IMAGINE_ENTRA_HOOK true'
    Write-Host 'or follow the manual fallback in docs/deploy/azure-wizard.md (section 6c).'
    exit 0
}

$resourceUri = Get-AzdValue 'MCP_RESOURCE_URI'
if (-not $resourceUri) {
    Write-Warning 'MCP_RESOURCE_URI is not in the azd environment; provision first.'
    exit 0
}

$displayName = Get-AzdValue 'IMAGINE_ENTRA_APP_NAME'
if (-not $displayName) { $displayName = "imagine-mcp-$(Get-AzdValue 'AZURE_ENV_NAME')" }

$scopeName = Get-AzdValue 'IMAGINE_AUTH_REQUIRED_SCOPE'
if (-not $scopeName) { $scopeName = 'access_as_user' }

Write-Host "Entra app registration: $displayName"
Write-Host "Resource URI to register: $resourceUri"

try {
    $existing = az ad app list --display-name $displayName --query "[?displayName=='$displayName'] | [0]" -o json | ConvertFrom-Json
} catch {
    Write-Warning "Could not query Entra: $($_.Exception.Message)"
    Write-Warning 'You probably lack permission to read app registrations. Use the manual fallback (azure-wizard.md 6c).'
    exit 0
}

if ($null -eq $existing) {
    Write-Host 'Creating the app registration...'
    try {
        $existing = az ad app create --display-name $displayName --sign-in-audience AzureADMyOrg -o json | ConvertFrom-Json
    } catch {
        Write-Warning "Could not create the app registration: $($_.Exception.Message)"
        Write-Warning 'You need the Application Developer role (or equivalent) in the tenant. Use the manual fallback (azure-wizard.md 6c).'
        exit 0
    }
} else {
    Write-Host "Reusing app registration $($existing.appId)."
}

$appId = $existing.appId
$objectId = $existing.id

# api:// first: Entra treats identifierUris[0] as the default, and some tooling
# assumes the api:// form is there.
$defaultUri = "api://$appId"
$identifierUris = @($defaultUri, $resourceUri) | Select-Object -Unique

$scopeId = $null
if ($existing.api -and $existing.api.oauth2PermissionScopes) {
    $scopeId = ($existing.api.oauth2PermissionScopes | Where-Object { $_.value -eq $scopeName } | Select-Object -First 1).id
}
if (-not $scopeId) { $scopeId = [guid]::NewGuid().ToString() }

$api = @{
    requestedAccessTokenVersion = 2
    oauth2PermissionScopes      = @(
        @{
            id                      = $scopeId
            value                   = $scopeName
            type                    = 'User'
            isEnabled               = $true
            adminConsentDisplayName = "Use imagine as $scopeName"
            adminConsentDescription = 'Allows the app to call the imagine MCP server on behalf of the signed-in user.'
            userConsentDisplayName  = 'Use imagine'
            userConsentDescription  = 'Allows the app to generate images through imagine on your behalf.'
        }
    )
}

# Graph refuses to pre-authorise a scope in the same request that creates it,
# and `az rest` reports failure through $LASTEXITCODE rather than an exception.
# So: two PATCHes, each checked by exit code.
function Invoke-GraphPatch([hashtable] $Body, [string] $What) {
    $patchFile = New-TemporaryFile
    try {
        Set-Content -Path $patchFile -Value ($Body | ConvertTo-Json -Depth 10 -Compress) -Encoding utf8
        az rest --method PATCH `
            --uri "https://graph.microsoft.com/v1.0/applications/$objectId" `
            --headers 'Content-Type=application/json' `
            --body "@$patchFile" | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Graph PATCH failed (exit $LASTEXITCODE)" }
        Write-Host "${What}: done"
        return $true
    } catch {
        Write-Warning "Could not update the app registration ($What): $($_.Exception.Message)"
        return $false
    } finally {
        Remove-Item $patchFile -ErrorAction SilentlyContinue
    }
}

$scopePatched = Invoke-GraphPatch -What 'Identifier URIs and access_as_user scope' -Body @{
    identifierUris = $identifierUris
    api            = $api
}
if ($scopePatched) {
    Write-Host "Application ID URIs now: $($identifierUris -join ', ')"
    Invoke-GraphPatch -What 'Pre-authorising VS Code and the Azure CLI' -Body @{
        api = @{
            preAuthorizedApplications = @(
                @{
                    appId                  = $VSCodeClientId
                    delegatedPermissionIds = @($scopeId)
                }
                @{
                    appId                  = $AzureCliClientId
                    delegatedPermissionIds = @($scopeId)
                }
            )
        }
    } | Out-Null
} else {
    Write-Warning "Add these Application ID URIs by hand under Expose an API: $($identifierUris -join ', ')"
}

# A service principal in this tenant is what makes the app assignable and
# consentable. Already existing is not an error.
az ad sp create --id $appId 2>$null | Out-Null

azd env set AZURE_MCP_APP_ID $appId | Out-Null
azd env set IMAGINE_AUTH_CLIENT_ID $appId | Out-Null
azd env set IMAGINE_AUTH_TENANT_ID (az account show --query tenantId -o tsv) | Out-Null

Write-Host ''
Write-Host 'Done. Two things this script cannot do for you:'
Write-Host '  1. Admin consent for the delegated scope, if the tenant requires it.'
Write-Host '     az ad app permission admin-consent --id ' -NoNewline; Write-Host $appId
Write-Host '  2. Turn validation on. It is off until you ask for it:'
Write-Host '     azd env set IMAGINE_AUTH_ENABLED true; azd up'
