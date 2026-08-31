#!/usr/bin/env pwsh
# `azd down` removes the resources Bicep created. The Entra app registration is
# not one of them — it lives in the tenant's directory, not in the subscription
# — so it survives unless something deletes it. This is that something.
#
# Same gate as the postprovision hook: only touches a registration this
# deployment created, and never fails the teardown.

$ErrorActionPreference = 'Stop'

function Get-AzdValue([string]$Name) {
    $fromEnv = [Environment]::GetEnvironmentVariable($Name)
    if ($fromEnv) { return $fromEnv }
    $value = (azd env get-value $Name 2>$null)
    if ($LASTEXITCODE -ne 0) { return '' }
    return $value.Trim()
}

if ((Get-AzdValue 'IMAGINE_ENTRA_HOOK') -ne 'true') { exit 0 }

$appId = Get-AzdValue 'AZURE_MCP_APP_ID'
if (-not $appId) {
    Write-Host 'No AZURE_MCP_APP_ID in this environment; nothing to delete.'
    exit 0
}

Write-Host "Deleting Entra app registration $appId ..."
try {
    az ad app delete --id $appId | Out-Null
    azd env set AZURE_MCP_APP_ID '' | Out-Null
    Write-Host 'Deleted. It sits in the deleted-applications bin for 30 days.'
} catch {
    Write-Warning "Could not delete it: $($_.Exception.Message)"
    Write-Warning "Delete it by hand: az ad app delete --id $appId"
}
