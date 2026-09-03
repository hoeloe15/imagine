// Everything imagine runs on, at resource-group scope. See ADR 0020 for the
// registry choice, the two-pass secret bootstrap and the audience derivation.

param environmentName string
param location string
param tags object
param principalId string
param containerImage string
param openRouterSecretInVault bool
param azureOpenAiSecretInVault bool
param authEnabled bool
param authTenantId string
param authClientId string
param authExtraAudiences string
param authRequiredScope string
param authIssuer string

@description('A config.json fragment carried in IMAGINE_CONFIG_JSON. Holds no secrets: api_key_env names variables, it never holds key values (ADR 0004, ADR 0022).')
param imagineConfigJson string = ''

@description('Resource id of the Azure AI Foundry / Azure OpenAI account the container identity gets Cognitive Services OpenAI User on. Empty skips the role assignment.')
param foundryResourceId string = ''

@description('Port the container listens on. The entrypoint resolves IMAGINE_HTTP_PORT, then PORT, then 8080 (ADR 0018).')
param targetPort int = 8080

var token = toLower(uniqueString(subscription().id, environmentName, location))

var logAnalyticsName = 'log-${environmentName}-${token}'
var containerAppsEnvironmentName = 'cae-${environmentName}-${token}'
var containerAppName = 'ca-imagine-${token}'
var registryName = 'acr${token}'
var identityName = 'id-imagine-${token}'
var keyVaultName = 'kv-imagine-${token}'

var openRouterSecretName = 'openrouter-api-key'
var azureOpenAiSecretName = 'azure-openai-api-key'

var acrPullRoleId = '7f951dda-4ed3-4680-a7ca-43fe172d538d'
var keyVaultSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'
var keyVaultSecretsOfficerRoleId = 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'
// `az role definition list --name "Cognitive Services OpenAI User"`.
var cognitiveServicesOpenAiUserRoleId = '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd'

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: identityName
  location: location
  tags: tags
}

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2022-10-01' = {
  name: logAnalyticsName
  location: location
  tags: tags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
  }
}

resource containerAppsEnvironment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: containerAppsEnvironmentName
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
  }
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: registryName
  location: location
  tags: tags
  sku: {
    name: 'Basic'
  }
  properties: {
    // The container app pulls with the managed identity; nothing needs the
    // admin credential, and leaving it on is a password nobody rotates.
    adminUserEnabled: false
  }
}

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  tags: tags
  properties: {
    sku: {
      family: 'A'
      name: 'standard'
    }
    tenantId: subscription().tenantId
    // RBAC, not access policies (#41). Purge protection is deliberately left
    // off so that `azd down --purge` can reclaim the name.
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
    publicNetworkAccess: 'Enabled'
  }
}

resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, identity.id, acrPullRoleId)
  scope: registry
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleId)
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource keyVaultSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, identity.id, keyVaultSecretsUserRoleId)
  scope: keyVault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRoleId)
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// Without this the operator cannot run `az keyvault secret set` on their own
// vault: an RBAC vault grants no data-plane access to subscription Owner.
resource keyVaultSecretsOfficer 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(principalId)) {
  name: guid(keyVault.id, principalId, keyVaultSecretsOfficerRoleId)
  scope: keyVault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsOfficerRoleId)
    principalId: principalId
  }
}

// The Foundry account may live in another resource group, or another
// subscription, so its id is taken apart rather than assumed to be local:
// /subscriptions/<id>/resourceGroups/<rg>/providers/<ns>/<type>/<name>.
var foundryParts = split(foundryResourceId, '/')
var foundryIsResolvable = length(foundryParts) >= 9
var foundrySubscriptionId = foundryIsResolvable ? foundryParts[2] : subscription().subscriptionId
var foundryResourceGroupName = foundryIsResolvable ? foundryParts[4] : resourceGroup().name
var foundryAccountName = foundryIsResolvable ? last(foundryParts) : ''

module foundryRole 'foundry-role.bicep' = if (!empty(foundryResourceId)) {
  name: 'imagine-foundry-openai-user'
  scope: resourceGroup(foundrySubscriptionId, foundryResourceGroupName)
  params: {
    accountName: foundryAccountName
    principalId: identity.properties.principalId
    roleDefinitionId: cognitiveServicesOpenAiUserRoleId
  }
}

var mcpEndpointUrl = 'https://${containerAppName}.${containerAppsEnvironment.properties.defaultDomain}'
var mcpResourceUri = '${mcpEndpointUrl}/mcp'

// Claude sends the full MCP URL as the RFC 8707 `resource`, so that URL is
// always an accepted audience; api://<client-id> is what `az account
// get-access-token` asks for (research §3.3).
// Entra v2 access tokens carry the bare client id as `aud`, whichever
// identifier URI the scope was requested through - found on the first
// authenticated run, when a token minted for api://<id>/access_as_user
// arrived with aud=<id>. The bare id is the audience that actually matches.
var apiAudience = empty(authClientId) ? '' : ',api://${authClientId},${authClientId}'
var extraAudience = empty(authExtraAudiences) ? '' : ',${authExtraAudiences}'
var authAudiences = '${mcpResourceUri}${apiAudience}${extraAudience}'

var authEnv = authEnabled
  ? concat(
      [
        {
          name: 'IMAGINE_AUTH_TENANT_ID'
          value: empty(authTenantId) ? subscription().tenantId : authTenantId
        }
        {
          name: 'IMAGINE_AUTH_AUDIENCE'
          value: authAudiences
        }
        {
          name: 'IMAGINE_AUTH_REQUIRED_SCOPE'
          value: authRequiredScope
        }
      ],
      empty(authIssuer)
        ? []
        : [
            {
              name: 'IMAGINE_AUTH_ISSUER'
              value: authIssuer
            }
          ]
    )
  : []

var providerSecrets = concat(
  openRouterSecretInVault
    ? [
        {
          name: openRouterSecretName
          keyVaultUrl: '${keyVault.properties.vaultUri}secrets/${openRouterSecretName}'
          identity: identity.id
        }
      ]
    : [],
  azureOpenAiSecretInVault
    ? [
        {
          name: azureOpenAiSecretName
          keyVaultUrl: '${keyVault.properties.vaultUri}secrets/${azureOpenAiSecretName}'
          identity: identity.id
        }
      ]
    : []
)

// api_key_env still names an environment variable (ADR 0004); a Key Vault
// reference is how that variable gets its value here.
var providerEnv = concat(
  openRouterSecretInVault
    ? [
        {
          name: 'OPENROUTER_API_KEY'
          secretRef: openRouterSecretName
        }
      ]
    : [],
  azureOpenAiSecretInVault
    ? [
        {
          name: 'AZURE_OPENAI_API_KEY'
          secretRef: azureOpenAiSecretName
        }
      ]
    : []
)

// IMAGINE_TRANSPORT and IMAGINE_HTTP_HOST are absent on purpose: the image
// already sets them and ADR 0018 forbids re-declaring them here. PORT is set
// because Container Apps does not inject it, and the entrypoint's
// IMAGINE_HTTP_PORT / PORT / 8080 bridge is only real if something sets it.
// AZURE_CLIENT_ID tells the managed identity endpoint which of the app's
// identities to mint a token for; with a user-assigned identity the request is
// ambiguous without it (ADR 0022). IMAGINE_CONFIG_JSON is the container's whole
// config.json — it carries api_key_env names, never key values.
var containerEnv = concat(
  [
    {
      name: 'PORT'
      value: string(targetPort)
    }
    {
      name: 'AZURE_CLIENT_ID'
      value: identity.properties.clientId
    }
  ],
  empty(imagineConfigJson)
    ? []
    : [
        {
          name: 'IMAGINE_CONFIG_JSON'
          value: imagineConfigJson
        }
      ],
  providerEnv,
  authEnv
)

resource containerApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: containerAppName
  location: location
  tags: union(tags, {
    'azd-service-name': 'imagine'
  })
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identity.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: containerAppsEnvironment.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: targetPort
        transport: 'auto'
        allowInsecure: false
      }
      registries: [
        {
          server: registry.properties.loginServer
          identity: identity.id
        }
      ]
      secrets: providerSecrets
    }
    template: {
      containers: [
        {
          name: 'imagine'
          image: containerImage
          resources: {
            cpu: json('0.5')
            memory: '1.0Gi'
          }
          env: containerEnv
          // /healthz, never /mcp: a GET on the MCP endpoint is a 405 by design
          // (research §5, ADR 0018).
          probes: [
            {
              type: 'Startup'
              httpGet: {
                path: '/healthz'
                port: targetPort
              }
              initialDelaySeconds: 3
              periodSeconds: 3
              failureThreshold: 20
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/healthz'
                port: targetPort
              }
              periodSeconds: 10
              failureThreshold: 3
            }
            {
              type: 'Liveness'
              httpGet: {
                path: '/healthz'
                port: targetPort
              }
              periodSeconds: 30
              failureThreshold: 3
            }
          ]
        }
      ]
      scale: {
        // Not zero: a cold start happens inside a tool call and reads to the
        // user as a broken connector (research §5).
        minReplicas: 1
        maxReplicas: 3
      }
    }
  }
  dependsOn: [
    acrPull
    keyVaultSecretsUser
    foundryRole
  ]
}

output AZURE_CONTAINER_REGISTRY_ENDPOINT string = registry.properties.loginServer
output AZURE_CONTAINER_REGISTRY_NAME string = registry.name
output AZURE_CONTAINER_APP_NAME string = containerApp.name
output AZURE_CONTAINER_APPS_ENVIRONMENT_NAME string = containerAppsEnvironment.name
output AZURE_KEY_VAULT_NAME string = keyVault.name
output AZURE_KEY_VAULT_ENDPOINT string = keyVault.properties.vaultUri
output AZURE_MANAGED_IDENTITY_NAME string = identity.name
output AZURE_MANAGED_IDENTITY_CLIENT_ID string = identity.properties.clientId
output AZURE_MANAGED_IDENTITY_PRINCIPAL_ID string = identity.properties.principalId
output MCP_ENDPOINT_URL string = 'https://${containerApp.properties.configuration.ingress.fqdn}'
output MCP_RESOURCE_URI string = '${mcpEndpointUrl}/mcp'

