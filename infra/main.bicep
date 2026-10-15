targetScope = 'resourceGroup'

@description('Use a documented new-tier preview region; verify subscription availability.')
param location string = 'eastus2'

@minLength(3)
@maxLength(24)
param gatewayName string = 'ai-demo-${uniqueString(resourceGroup().id)}'

resource gateway 'Microsoft.ApiManagement/aigateways@2026-05-01' = {
  name: gatewayName
  location: location
  sku: {
    name: 'AIGateway'
  }
  identity: {
    type: 'SystemAssigned'
  }
  tags: {
    purpose: 'enterprise-ai-gateway-demo'
    environment: 'demo'
  }
  properties: {}
}

output gatewayResourceId string = gateway.id
output gatewayName string = gateway.name
