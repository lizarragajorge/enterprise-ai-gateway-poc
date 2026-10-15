targetScope = 'resourceGroup'

param location string = 'eastus2'
param insightsName string = 'appi-demo-${uniqueString(resourceGroup().id)}'
param workspaceName string = 'log-demo-${uniqueString(resourceGroup().id)}'

resource workspace 'Microsoft.OperationalInsights/workspaces@2026-03-01' = {
  name: workspaceName
  location: location
  tags: {
    purpose: 'enterprise-ai-gateway-demo'
    environment: 'demo'
  }
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
    workspaceCapping: {
      dailyQuotaGb: json('0.1')
    }
    features: {
      disableLocalAuth: true
      enableLogAccessUsingOnlyResourcePermissions: true
    }
  }
}

resource insights 'Microsoft.Insights/components@2020-02-02' = {
  name: insightsName
  location: location
  kind: 'web'
  tags: {
    purpose: 'enterprise-ai-gateway-demo'
    environment: 'demo'
  }
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: workspace.id
    DisableLocalAuth: true
    DisableIpMasking: false
    RetentionInDays: 30
    SamplingPercentage: 100
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

output insightsResourceId string = insights.id
output workspaceResourceId string = workspace.id
