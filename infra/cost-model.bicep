targetScope = 'resourceGroup'

@description('Explicit existing model account name.')
param accountName string
param deploymentName string = 'ai-cost-premium'
param modelName string = 'gpt-4.1'
param modelVersion string = '2025-04-14'

resource account 'Microsoft.CognitiveServices/accounts@2026-07-01' existing = {
  name: accountName
}

// Only this pay-per-token deployment is managed; existing account, models and RBAC remain untouched.
resource model 'Microsoft.CognitiveServices/accounts/deployments@2026-07-01' = {
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
