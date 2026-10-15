targetScope = 'resourceGroup'

param location string = 'eastus2'
param workspaceName string = 'dbx-demo-${uniqueString(resourceGroup().id)}'
param reviewOn string = '2026-10-20'

resource workspace 'Microsoft.Databricks/workspaces@2026-01-01' = {
  name: workspaceName
  location: location
  tags: {
    purpose: 'enterprise-ai-gateway-demo'
    environment: 'demo'
    reviewOn: reviewOn
    usageScope: 'pay-per-token-model-access-only'
  }
  sku: {
    name: 'premium'
  }
  properties: {
    computeMode: 'Serverless'
    publicNetworkAccess: 'Enabled'
  }
}

output workspaceResourceId string = workspace.id
output workspaceUrl string = workspace.properties.workspaceUrl
