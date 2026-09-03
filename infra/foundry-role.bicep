// Grants the container app's identity data-plane access to an Azure AI Foundry
// (Cognitive Services) account that lives outside this template's resource
// group. A separate module because a role assignment can only be scoped to a
// resource in the deployment's own resource group. See ADR 0022.

@description('Name of the existing Cognitive Services / Azure AI Foundry account in this module\'s resource group.')
param accountName string

@description('Principal id of the identity that gets the role.')
param principalId string

@description('Role definition GUID to assign. Verified against the live tenant, not guessed.')
param roleDefinitionId string

resource account 'Microsoft.CognitiveServices/accounts@2024-10-01' existing = {
  name: accountName
}

resource assignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(account.id, principalId, roleDefinitionId)
  scope: account
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleDefinitionId)
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}
