param gatewayName string
param workspaceOrigin string
param backendModelName string
param publishedName string

@secure()
param backendToken string

resource provider 'Microsoft.ApiManagement/aigateways/workspaces/modelProviders@2026-05-01' = {
  name: '${gatewayName}/default/databricks-models'
  properties: {
    kind: 'Custom'
    displayName: 'Databricks pay-per-token models'
    description: 'enterprise-ai-gateway-demo: Databricks inference-only backend'
    custom: {
      endpoint: '${workspaceOrigin}/serving-endpoints'
      authentication: {
        kind: 'ApiKey'
        apiKey: {
          headerName: 'Authorization'
          value: 'Bearer ${backendToken}'
        }
      }
    }
  }
}

resource model 'Microsoft.ApiManagement/aigateways/workspaces/modelProviders/models@2026-05-01' = {
  parent: provider
  name: 'gpt-oss-20b'
  properties: {
    displayName: 'Databricks GPT OSS 20B'
    supportedEndpoints: ['/${backendModelName}/invocations']
    deployment: {
      modelName: backendModelName
    }
  }
}

resource alias 'Microsoft.ApiManagement/aigateways/workspaces/aliases@2026-05-01' = {
  name: '${gatewayName}/default/${publishedName}'
  properties: {
    aliasName: publishedName
    description: 'Explicit Databricks model selection; not intelligent routing.'
    backendModels: [
      {
        resourceId: model.id
      }
    ]
  }
}

output publishedModel string = publishedName
