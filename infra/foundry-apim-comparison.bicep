targetScope = 'resourceGroup'

param location string = 'eastus2'
// Premium v2 new-instance capacity is unavailable in East US 2 in the current regional table.
param gatewayLocation string = 'canadacentral'
param gatewaySku string = 'PremiumV2'
param publisherEmail string
param foundryName string = 'foundry-compare-${uniqueString(resourceGroup().id)}'
param gatewayName string = 'apim-compare-${uniqueString(resourceGroup().id)}'
param projectName string = 'gateway-comparison'
param reviewOn string = '2026-10-20'
param models array = [
  {
    deploymentName: 'ai-cost-economy-current'
    modelName: 'gpt-6-luna'
    modelVersion: '2026-09-22'
  }
  {
    deploymentName: 'demo-chat-secondary'
    modelName: 'gpt-4.1-mini'
    modelVersion: '2025-04-14'
  }
  {
    deploymentName: 'ai-cost-premium-current'
    modelName: 'gpt-6.1-sol'
    modelVersion: '2026-09-29'
  }
]
var tags = {
  purpose: 'enterprise-ai-gateway-comparison'
  environment: 'demo'
  reviewOn: reviewOn
}

resource foundry 'Microsoft.CognitiveServices/accounts@2026-07-01' = {
  name: foundryName
  location: location
  kind: 'AIServices'
  sku: { name: 'S0' }
  identity: { type: 'SystemAssigned' }
  tags: tags
  properties: {
    customSubDomainName: foundryName
    allowProjectManagement: true
    disableLocalAuth: true
    publicNetworkAccess: 'Enabled'
  }
}

resource project 'Microsoft.CognitiveServices/accounts/projects@2026-07-01' = {
  parent: foundry
  name: projectName
  location: location
  identity: { type: 'SystemAssigned' }
  tags: tags
  properties: {
    displayName: 'Gateway comparison'
    description: 'Synthetic model calls comparing standalone AI Gateway with APIM v2.'
  }
}

@batchSize(1)
resource deployments 'Microsoft.CognitiveServices/accounts/deployments@2026-07-01' = [for model in models: {
  parent: foundry
  dependsOn: [project]
  name: model.deploymentName
  sku: {
    name: 'GlobalStandard'
    capacity: 1
  }
  properties: {
    model: {
      format: 'OpenAI'
      name: model.modelName
      version: model.modelVersion
    }
    versionUpgradeOption: 'NoAutoUpgrade'
  }
}]

resource gateway 'Microsoft.ApiManagement/service@2024-05-01' = {
  name: gatewayName
  location: gatewayLocation
  sku: {
    name: gatewaySku
    capacity: 1
  }
  identity: { type: 'SystemAssigned' }
  tags: tags
  properties: {
    publisherEmail: publisherEmail
    publisherName: 'Enterprise AI gateway comparison'
    publicNetworkAccess: 'Enabled'
  }
}

var modelUserRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '53ca6127-db72-4b80-b1b0-d745d6d5456d')
resource modelAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(foundry.id, gateway.id, modelUserRole)
  scope: foundry
  properties: {
    principalId: gateway.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: modelUserRole
  }
}

output foundryResourceId string = foundry.id
output foundryName string = foundry.name
output projectResourceId string = project.id
output gatewayResourceId string = gateway.id
output gatewayName string = gateway.name
output gatewayOrigin string = gateway.properties.gatewayUrl
output gatewayPrincipalId string = gateway.identity.principalId
output gatewayRegion string = gatewayLocation
output deploymentIds array = [for (model, index) in models: deployments[index].id]
