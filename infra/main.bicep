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

@description('Set to true only after `az keyvault secret set --name openrouter-api-key` has run. A Key Vault reference to a secret that does not exist fails the revision. See ADR 0019.')
param openRouterSecretInVault bool = false

@description('Set to true only after `az keyvault secret set --name azure-openai-api-key` has run.')
param azureOpenAiSecretInVault bool = false

@description('Turn on IMAGINE_AUTH_* on the container app. Leave false until the Entra app registration of #44 exists; the server refuses to start half-configured (ADR 0017).')
param authEnabled bool = false

@description('Tenant whose tokens are accepted. Defaults to the deployment tenant.')
param authTenantId string = ''

@description('Application (client) id of the MCP app registration. Adds api://<id> as an accepted audience.')
param authClientId string = ''

@description('Extra accepted audiences, comma separated. The deployed https://<fqdn>/mcp URL is always included.')
param authExtraAudiences string = ''

@description('Scope or app role a caller must hold.')
param authRequiredScope string = 'access_as_user'

@description('Accepted issuer. Empty lets the server derive it from the tenant.')
param authIssuer string = ''

@description('A config.json fragment for the container, as one JSON string. This is how the hosted server learns providers.azure.endpoint, deployments and auth, since the image has no config file. It holds no secrets: api_key_env names environment variables and never key values (ADR 0004, ADR 0022).')
param imagineConfigJson string = ''

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
    imagineConfigJson: imagineConfigJson
    foundryResourceId: foundryResourceId
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

output MCP_ENDPOINT_URL string = resources.outputs.MCP_ENDPOINT_URL

// The exact string that must appear in the app registration's Application ID
// URI list, or the token request fails with AADSTS9010010 (research §3.3).
output MCP_RESOURCE_URI string = resources.outputs.MCP_RESOURCE_URI
