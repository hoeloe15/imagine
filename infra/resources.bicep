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
param authMetadataUrl string = ''
param authAudienceOverride string = ''

@description('Comma-separated list of token subjects allowed to call this server, on top of token validation. Empty leaves the allowlist off.')
param authAllowedSubjects string = ''

@description('Serve the browser console at https://<fqdn>/portal. It only exists when authentication is also on; with auth off the server warns and its paths answer 404.')
param portalEnabled bool = false

@description('Public client id of the portal application at the issuer (WorkOS dashboard, Developer -> API Keys). Not a secret: it is the identifier a browser sends in the authorization URL.')
param portalClientId string = ''

@description('A config.json fragment carried in IMAGINE_CONFIG_JSON. Holds no secrets: api_key_env names variables, it never holds key values (ADR 0004, ADR 0022).')
param imagineConfigJson string = ''

@description('Resource id of the Azure AI Foundry / Azure OpenAI account the container identity gets Cognitive Services OpenAI User on. Empty skips the role assignment.')
param foundryResourceId string = ''

@description('Where generated images are stored. "local" writes to the container filesystem, which is ephemeral and unreachable for a chat client; "blob" provisions a storage account and returns a link the client can render (ADR 0024).')
@allowed([
  'local'
  'blob'
])
param outputSink string = 'local'

@description('Lifetime in hours of the renderable image links (1-168). Empty keeps the server default.')
param outputBlobUrlTtlHours string = ''

@description('Port the container listens on. The entrypoint resolves IMAGINE_HTTP_PORT, then PORT, then 8080 (ADR 0018).')
param targetPort int = 8080

var token = toLower(uniqueString(subscription().id, environmentName, location))

var logAnalyticsName = 'log-${environmentName}-${token}'
var containerAppsEnvironmentName = 'cae-${environmentName}-${token}'
var containerAppName = 'ca-imagine-${token}'
var registryName = 'acr${token}'
var identityName = 'id-imagine-${token}'
var keyVaultName = 'kv-imagine-${token}'
var storageAccountName = 'st${token}'
var outputContainerName = 'images'

var blobSinkEnabled = outputSink == 'blob'

var openRouterSecretName = 'openrouter-api-key'
var azureOpenAiSecretName = 'azure-openai-api-key'

var acrPullRoleId = '7f951dda-4ed3-4680-a7ca-43fe172d538d'
var keyVaultSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'
var keyVaultSecretsOfficerRoleId = 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'
// `az role definition list --name "Cognitive Services OpenAI User"`.
var cognitiveServicesOpenAiUserRoleId = '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd'
// Read live, never from memory (commit 911edea shipped an invented GUID):
//   az role definition list --name "Storage Blob Data Contributor" --query "[].name" -o tsv
//   az role definition list --name "Storage Blob Delegator" --query "[].name" -o tsv
var storageBlobDataContributorRoleId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
var storageBlobDelegatorRoleId = 'db58b8e5-c6ad-4a2a-8342-4190687cbf4a'

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

// The server reads provider secrets from the vault at request time, and the
// portal writes them there (ADR 0026). Azure has no write-only secret role, so
// Officer is the narrowest built-in role that can write: read, write and delete
// over this vault. The vault holds only this application's secrets, the write
// path sits behind the login, and every write leaves an audit line.
resource keyVaultSecretsOfficerForIdentity 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, identity.id, keyVaultSecretsOfficerRoleId)
  scope: keyVault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsOfficerRoleId)
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

// Shared key access is off, so the identity is the only way in and no
// connection string exists to leak. Public blob access is off too: a link is
// handed out as a short-lived user delegation SAS instead (ADR 0024).
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = if (blobSinkEnabled) {
  name: storageAccountName
  location: location
  tags: tags
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    publicNetworkAccess: 'Enabled'
    accessTier: 'Hot'
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = if (blobSinkEnabled) {
  parent: storage
  name: 'default'
}

resource outputContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = if (blobSinkEnabled) {
  parent: blobService
  name: outputContainerName
  properties: {
    publicAccess: 'None'
  }
}

// Write access is scoped to the one container, not the account.
resource storageBlobDataContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (blobSinkEnabled) {
  name: guid(storage.id, outputContainerName, identity.id, storageBlobDataContributorRoleId)
  scope: outputContainer
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataContributorRoleId)
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// Signing a user delegation SAS needs generateUserDelegationKey, which is an
// account-level action: scoping this to the container would make every link
// request fail with 403 (Get User Delegation Key, "Permissions").
resource storageBlobDelegator 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (blobSinkEnabled) {
  name: guid(storage.id, identity.id, storageBlobDelegatorRoleId)
  scope: storage
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDelegatorRoleId)
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
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
var computedAudiences = '${mcpResourceUri}${apiAudience}${extraAudience}'
var authAudiences = empty(authAudienceOverride) ? computedAudiences : authAudienceOverride

// An issuer without a tenant id is issuer mode (ADR 0023): the front is a
// non-Entra OIDC authorization server such as WorkOS AuthKit, there is no `tid`
// claim to check, and defaulting the tenant to the subscription's would turn a
// skipped check into a check no token can ever pass.
var issuerMode = !empty(authIssuer) && empty(authTenantId)
var effectiveTenantId = empty(authTenantId) ? subscription().tenantId : authTenantId

var authEnv = authEnabled
  ? concat(
      [
        {
          name: 'IMAGINE_AUTH_AUDIENCE'
          value: authAudiences
        }
      ],
      issuerMode
        ? []
        : [
            {
              name: 'IMAGINE_AUTH_TENANT_ID'
              value: effectiveTenantId
            }
          ],
      empty(authIssuer)
        ? []
        : [
            {
              name: 'IMAGINE_AUTH_ISSUER'
              value: authIssuer
            }
          ],
      empty(authMetadataUrl)
        ? []
        : [
            {
              name: 'IMAGINE_AUTH_METADATA_URL'
              value: authMetadataUrl
            }
          ],
      empty(authRequiredScope)
        ? []
        : [
            {
              name: 'IMAGINE_AUTH_REQUIRED_SCOPE'
              value: authRequiredScope
            }
          ]
    )
  : []

// Deliberately outside authEnv: the allowlist is a second gate the server
// applies to a validated token, and it is set whenever the operator names
// subjects — never quietly dropped because a flag elsewhere was off.
var allowedSubjectsEnv = empty(authAllowedSubjects)
  ? []
  : [
      {
        name: 'IMAGINE_ALLOWED_SUBJECTS'
        value: authAllowedSubjects
      }
    ]

// The portal is plain strings only. Its client id is public, and the one
// credential it might need — the token endpoint's client_secret, which at
// WorkOS *is* the environment API key — deliberately never becomes an azd
// variable: it is bootstrapped once with
//   az keyvault secret set --vault-name <kv> --name workos-client-secret --value <sk_...>
// and read at request time by the managed identity (ADR 0026), so an
// administrative credential never sits in a deployment parameter or a revision.
//
// IMAGINE_PORTAL_SESSION_SECRET is optional and also left out on purpose. With
// it unset the cookie signing key is random per process, which means a new
// revision or a second replica asks for a fresh login — correct and safe. An
// operator who wants sessions to survive a release can put a long random string
// in the vault under portal-session-secret and map it in as a secretRef.
var portalEnv = portalEnabled && authEnabled
  ? [
      {
        name: 'IMAGINE_PORTAL_ENABLED'
        value: 'true'
      }
      {
        name: 'IMAGINE_PORTAL_WORKOS_CLIENT_ID'
        value: portalClientId
      }
      {
        name: 'IMAGINE_PUBLIC_URL'
        value: mcpEndpointUrl
      }
    ]
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
//
// Since ADR 0026 these flags are no longer needed for the server to *see* a
// key: it reads the vault itself at request time through IMAGINE_KEY_VAULT_URL.
// They remain for operators who prefer the key to arrive as an ordinary
// environment variable, and for anything else that reads OPENROUTER_API_KEY.
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
// The account URL and container only exist once the storage account does, so
// the template fills them in rather than asking the operator to paste them into
// IMAGINE_CONFIG_JSON. An output section in IMAGINE_CONFIG_JSON still wins
// (ADR 0024).
var blobSinkEnv = blobSinkEnabled
  ? concat(
      [
        {
          name: 'IMAGINE_OUTPUT_SINK'
          value: 'blob'
        }
        {
          name: 'IMAGINE_OUTPUT_BLOB_ACCOUNT_URL'
          value: storage!.properties.primaryEndpoints.blob
        }
        {
          name: 'IMAGINE_OUTPUT_BLOB_CONTAINER'
          value: outputContainerName
        }
      ],
      empty(outputBlobUrlTtlHours)
        ? []
        : [
            {
              name: 'IMAGINE_OUTPUT_BLOB_URL_TTL_HOURS'
              value: outputBlobUrlTtlHours
            }
          ]
    )
  : []

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
    // Always set, with or without a secret in the vault: it is what lets the
    // server read a provider key at request time, so a key set with
    // `az keyvault secret set` is live within a minute and needs no redeploy
    // (ADR 0026). Like the blob variables, it is a value the deployment
    // generates rather than one a person types.
    {
      name: 'IMAGINE_KEY_VAULT_URL'
      value: keyVault.properties.vaultUri
    }
  ],
  blobSinkEnv,
  empty(imagineConfigJson)
    ? []
    : [
        {
          name: 'IMAGINE_CONFIG_JSON'
          value: imagineConfigJson
        }
      ],
  providerEnv,
  authEnv,
  allowedSubjectsEnv,
  portalEnv
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
    keyVaultSecretsOfficerForIdentity
    foundryRole
    storageBlobDataContributor
    storageBlobDelegator
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

// Blank when the portal is off. When it is on, these two are exactly what has
// to be registered at the issuer: the redirect URI matched character for
// character, and the portal's own resource indicator.
output PORTAL_URL string = portalEnabled && authEnabled ? '${mcpEndpointUrl}/portal' : ''
output PORTAL_REDIRECT_URI string = portalEnabled && authEnabled
  ? '${mcpEndpointUrl}/portal/auth/callback'
  : ''

output IMAGINE_OUTPUT_SINK string = outputSink
output AZURE_STORAGE_ACCOUNT_NAME string = blobSinkEnabled ? storage.name : ''
output AZURE_STORAGE_BLOB_CONTAINER_NAME string = blobSinkEnabled ? outputContainerName : ''
// The container images land in. Nothing in it is readable without a link the
// server signs, so this URL is a location, not an access grant.
output MCP_OUTPUT_BLOB_URL string = blobSinkEnabled
  ? '${storage!.properties.primaryEndpoints.blob}${outputContainerName}'
  : ''

