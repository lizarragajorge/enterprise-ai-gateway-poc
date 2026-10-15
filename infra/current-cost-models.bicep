targetScope = 'resourceGroup'

@description('Explicit existing model account name.')
param accountName string
param models array = [
  {
    deploymentName: 'ai-cost-economy-current'
    modelName: 'gpt-6-luna'
    modelVersion: '2026-09-22'
  }
  {
    deploymentName: 'ai-cost-premium-current'
    modelName: 'gpt-6.1-sol'
    modelVersion: '2026-09-29'
  }
]

resource account 'Microsoft.CognitiveServices/accounts@2026-07-01' existing = {
  name: accountName
}

@batchSize(1)
resource deployments 'Microsoft.CognitiveServices/accounts/deployments@2026-07-01' = [for model in models: {
  parent: account
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

output deploymentIds array = [for (model, index) in models: deployments[index].id]
