// Entry point for `azd provision`. Subscription-scoped so that a clean
// subscription needs no pre-made resource group; everything inside is
// resource-group scoped and lives in `resources.bicep`.
targetScope = 'subscription'

@minLength(1)
@maxLength(48)
@description('Name of the azd environment. Every resource name derives from it.')
param environmentName string

@minLength(1)
@description('Azure region for all resources. Must support Azure Container Apps.')
param location string

@description('Resource group to deploy into. Defaults to rg-<environmentName>.')
param resourceGroupName string = ''

@description('Object id of the principal running azd. Gets Key Vault Secrets Officer so it can set the provider secrets; an RBAC vault gives no data-plane access to subscription Owner alone.')
param principalId string = ''

@description('Image the container app runs until `azd deploy` replaces it with a locally built one. See ADR 0019.')
param containerImage string = 'ghcr.io/hoeloe15/imagine:edge'

@description('Optional. Maps the vault secret onto OPENROUTER_API_KEY as a Key Vault reference. Not needed for the server to use the key — it reads the vault itself at request time (ADR 0026). Set to true only after `az keyvault secret set --name openrouter-api-key` has run: a reference to a secret that does not exist fails the revision.')
param openRouterSecretInVault bool = false

@description('Optional, and the same story as openRouterSecretInVault. Set to true only after `az keyvault secret set --name azure-openai-api-key` has run.')
param azureOpenAiSecretInVault bool = false

@description('Turn on IMAGINE_AUTH_* on the container app. Leave false until there is an authority to validate against; the server refuses to start half-configured (ADR 0017).')
param authEnabled bool = false

@description('Tenant whose tokens are accepted. Defaults to the deployment tenant in Entra mode, and is deliberately left unset in issuer mode, where there is no tid claim to check (ADR 0023).')
param authTenantId string = ''

@description('Application (client) id of the MCP app registration. Adds api://<id> as an accepted audience.')
param authClientId string = ''

@description('Extra accepted audiences, comma separated. The deployed https://<fqdn>/mcp URL is always included.')
param authExtraAudiences string = ''

@description('Scope or app role a caller must hold. Empty leaves the server default: access_as_user in Entra mode, and no scope check in issuer mode, where AuthKit publishes no custom scopes (ADR 0023).')
param authRequiredScope string = ''

@description('Accepted issuer. Setting this without a tenant id is what turns on issuer mode — the WorkOS AuthKit domain, for example https://your-project.authkit.app. Empty lets the server derive the issuer from the tenant.')
param authIssuer string = ''

@description('Discovery document to read the jwks_uri from. Empty derives it from the issuer, trying /.well-known/oauth-authorization-server and then /.well-known/openid-configuration.')
param authMetadataUrl string = ''

@description('Replaces the computed audience list outright. Empty keeps the computed one, which already starts with the deployed https://<fqdn>/mcp URL — the value WorkOS puts in aud when that URL is a registered resource indicator.')
param authAudienceOverride string = ''

@description('Comma-separated token subjects allowed to call this server, checked on top of token validation. Empty leaves the allowlist off, and every validated token is accepted.')
param authAllowedSubjects string = ''

@description('Serve the browser console at https://<fqdn>/portal, where a provider key can be pasted in without a terminal or a redeploy. Requires authentication to be on: with it off the portal paths answer 404 and the startup banner says why.')
param portalEnabled bool = false

@description('Public client id of the portal application at the issuer — the WorkOS dashboard, under Developer -> API Keys. Public by design: it identifies the application in an authorization URL a browser follows. Required when portalEnabled is true. The token exchange uses PKCE and no secret; if a client secret proves necessary it goes into Key Vault as workos-client-secret and never becomes a parameter.')
param portalClientId string = ''

@description('A config.json fragment for the container, as one JSON string. This is how the hosted server learns providers.azure.endpoint, deployments and auth, since the image has no config file. It holds no secrets: api_key_env names environment variables and never key values (ADR 0004, ADR 0022).')
param imagineConfigJson string = ''

@description('Where generated images go. "local" is the container filesystem — fine over stdio, useless to a hosted chat client, which gets a path it cannot open. "blob" adds a storage account, a container and two role assignments, and the tool result carries a link that renders (ADR 0024).')
@allowed([
  'local'
  'blob'
])
param outputSink string = 'local'

@description('Lifetime in hours of the renderable image links (1-168). Empty keeps the server default.')
param outputBlobUrlTtlHours string = ''

@description('Resource id of the Azure AI Foundry / Azure OpenAI account to grant the container identity Cognitive Services OpenAI User on. It may live in another resource group or subscription. Empty skips the role assignment.')
param foundryResourceId string = ''

var tags = {
  'azd-env-name': environmentName
}

var rgName = empty(resourceGroupName) ? 'rg-${environmentName}' : resourceGroupName

resource rg 'Microsoft.Resources/resourceGroups@2021-04-01' = {
  name: rgName
  location: location
  tags: tags
}

module resources 'resources.bicep' = {
  name: 'imagine-resources'
  scope: rg
  params: {
    environmentName: environmentName
    location: location
    tags: tags
    principalId: principalId
    containerImage: containerImage
    openRouterSecretInVault: openRouterSecretInVault
    azureOpenAiSecretInVault: azureOpenAiSecretInVault
    authEnabled: authEnabled
    authTenantId: authTenantId
    authClientId: authClientId
    authExtraAudiences: authExtraAudiences
    authRequiredScope: authRequiredScope
    authIssuer: authIssuer
    authMetadataUrl: authMetadataUrl
    authAudienceOverride: authAudienceOverride
    authAllowedSubjects: authAllowedSubjects
    portalEnabled: portalEnabled
    portalClientId: portalClientId
    imagineConfigJson: imagineConfigJson
    foundryResourceId: foundryResourceId
    outputSink: outputSink
    outputBlobUrlTtlHours: outputBlobUrlTtlHours
  }
}

output AZURE_LOCATION string = location
output AZURE_TENANT_ID string = subscription().tenantId
output AZURE_RESOURCE_GROUP string = rg.name

// azd's containerapp host looks for this exact name to know where to push.
output AZURE_CONTAINER_REGISTRY_ENDPOINT string = resources.outputs.AZURE_CONTAINER_REGISTRY_ENDPOINT
output AZURE_CONTAINER_REGISTRY_NAME string = resources.outputs.AZURE_CONTAINER_REGISTRY_NAME

output AZURE_CONTAINER_APP_NAME string = resources.outputs.AZURE_CONTAINER_APP_NAME
output AZURE_CONTAINER_APPS_ENVIRONMENT_NAME string = resources.outputs.AZURE_CONTAINER_APPS_ENVIRONMENT_NAME

output AZURE_KEY_VAULT_NAME string = resources.outputs.AZURE_KEY_VAULT_NAME
output AZURE_KEY_VAULT_ENDPOINT string = resources.outputs.AZURE_KEY_VAULT_ENDPOINT

output AZURE_MANAGED_IDENTITY_NAME string = resources.outputs.AZURE_MANAGED_IDENTITY_NAME
output AZURE_MANAGED_IDENTITY_CLIENT_ID string = resources.outputs.AZURE_MANAGED_IDENTITY_CLIENT_ID
output AZURE_MANAGED_IDENTITY_PRINCIPAL_ID string = resources.outputs.AZURE_MANAGED_IDENTITY_PRINCIPAL_ID

output IMAGINE_OUTPUT_SINK string = resources.outputs.IMAGINE_OUTPUT_SINK
output AZURE_STORAGE_ACCOUNT_NAME string = resources.outputs.AZURE_STORAGE_ACCOUNT_NAME
output AZURE_STORAGE_BLOB_CONTAINER_NAME string = resources.outputs.AZURE_STORAGE_BLOB_CONTAINER_NAME
output MCP_OUTPUT_BLOB_URL string = resources.outputs.MCP_OUTPUT_BLOB_URL

output MCP_ENDPOINT_URL string = resources.outputs.MCP_ENDPOINT_URL

// The exact string that must appear in the app registration's Application ID
// URI list, or the token request fails with AADSTS9010010 (research §3.3).
output MCP_RESOURCE_URI string = resources.outputs.MCP_RESOURCE_URI

// The exact strings to register at the issuer when the portal is on: the
// redirect URI is matched character for character, and the portal URL is both
// the logout return URI and the portal's own resource indicator.
output PORTAL_URL string = resources.outputs.PORTAL_URL
output PORTAL_REDIRECT_URI string = resources.outputs.PORTAL_REDIRECT_URI
