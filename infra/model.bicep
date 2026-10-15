targetScope = 'resourceGroup'

param location string = 'eastus2'
param accountName string = 'model-demo-${uniqueString(resourceGroup().id)}'
@description('Explicit existing AI Gateway name.')
param gatewayName string

resource gateway 'Microsoft.ApiManagement/aigateways@2026-05-01' existing = {
  name: gatewayName
}

resource account 'Microsoft.CognitiveServices/accounts@2024-10-01' = {
  name: accountName
  location: location
  kind: 'OpenAI'
  sku: {
    name: 'S0'
  }
  tags: {
    purpose: 'enterprise-ai-gateway-demo'
    environment: 'demo'
  }
  properties: {
    customSubDomainName: accountName
    publicNetworkAccess: 'Enabled'
    disableLocalAuth: true
  }
}

resource model 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = {
  parent: account
  name: 'demo-chat-mini'
  sku: {
    name: 'GlobalStandard'
    capacity: 1
  }
  properties: {
    model: {
      format: 'OpenAI'
      name: 'gpt-4o-mini'
      version: '2024-07-18'
    }
    versionUpgradeOption: 'NoAutoUpgrade'
  }
}

var foundryUserRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '53ca6127-db72-4b80-b1b0-d745d6d5456d')
resource gatewayModelAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(account.id, gateway.id, foundryUserRoleId)
  scope: account
  properties: {
    roleDefinitionId: foundryUserRoleId
    principalId: gateway.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

output accountResourceId string = account.id
output deploymentResourceId string = model.id
output endpoint string = account.properties.endpoint
output publishedModelName string = model.name
