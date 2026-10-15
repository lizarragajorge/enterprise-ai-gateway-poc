targetScope = 'resourceGroup'

@description('Explicit existing model account name.')
param accountName string
param deploymentName string = 'demo-chat-secondary'
param modelName string = 'gpt-4.1-mini'
param modelVersion string = '2025-04-14'

resource account 'Microsoft.CognitiveServices/accounts@2024-10-01' existing = {
  name: accountName
}

// This template touches only the second pay-per-token deployment, not account/RBAC settings.
resource model 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = {
  parent: account
  name: deploymentName
  sku: {
    name: 'GlobalStandard'
    capacity: 1
  }
  properties: {
    model: {
      format: 'OpenAI'
      name: modelName
      version: modelVersion
    }
    versionUpgradeOption: 'NoAutoUpgrade'
  }
}

output deploymentResourceId string = model.id
output physicalModel string = modelName
output physicalModelVersion string = modelVersion
