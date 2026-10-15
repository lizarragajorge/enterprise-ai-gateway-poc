targetScope = 'resourceGroup'

@description('Explicit existing APIM service name; no shared deployment destination is assumed.')
param gatewayName string
@description('Explicit existing Foundry account name.')
param foundryName string
@description('HTTPS origin of the operator-owned Databricks workspace, without a trailing slash.')
param databricksOrigin string

resource gateway 'Microsoft.ApiManagement/service@2024-05-01' existing = {
  name: gatewayName
}

resource api 'Microsoft.ApiManagement/service/apis@2024-05-01' = {
  parent: gateway
  name: 'gateway-comparison'
  properties: {
    displayName: 'Gateway comparison models'
    description: 'Synthetic requests to the new Foundry deployments and reused Databricks endpoint.'
    path: 'default/models'
    protocols: ['https']
    subscriptionRequired: true
    apiType: 'http'
  }
}

resource chat 'Microsoft.ApiManagement/service/apis/operations@2024-05-01' = {
  parent: api
  name: 'openai-chat'
  properties: {
    displayName: 'Foundry chat completions'
    method: 'POST'
    urlTemplate: '/openai/v1/chat/completions'
    responses: []
  }
}

resource chatPolicy 'Microsoft.ApiManagement/service/apis/operations/policies@2024-05-01' = {
  parent: chat
  name: 'policy'
  properties: {
    format: 'rawxml'
    value: replace('''
      <policies>
        <inbound>
          <base />
          <choose>
            <when condition='@(!new [] { "ai-cost-economy-current", "demo-chat-secondary", "ai-cost-premium-current" }.Contains((string)context.Request.Body.As&lt;JObject&gt;(preserveContent: true)["model"]))'>
              <return-response>
                <set-status code="400" reason="Unknown published model" />
                <set-header name="Content-Type" exists-action="override"><value>application/json</value></set-header>
                <set-body>{"error":{"message":"Select a configured comparison model."}}</set-body>
              </return-response>
            </when>
          </choose>
          <set-header name="Ocp-Apim-Subscription-Key" exists-action="delete" />
          <authentication-managed-identity resource="https://cognitiveservices.azure.com" />
          <set-backend-service base-url="__FOUNDRY_ENDPOINT__" />
          <rewrite-uri template="/openai/v1/chat/completions" copy-unmatched-params="false" />
        </inbound>
        <backend><base /></backend>
        <outbound><base /></outbound>
        <on-error><base /></on-error>
      </policies>
      ''', '__FOUNDRY_ENDPOINT__', 'https://${foundryName}.openai.azure.com')
  }
}

resource databricks 'Microsoft.ApiManagement/service/apis/operations@2024-05-01' = {
  parent: api
  name: 'databricks-invocations'
  properties: {
    displayName: 'Reused Databricks GPT OSS 20B'
    method: 'POST'
    urlTemplate: '/databricks-gpt-oss-20b/invocations'
    responses: []
  }
}

resource databricksPolicy 'Microsoft.ApiManagement/service/apis/operations/policies@2024-05-01' = {
  parent: databricks
  name: 'policy'
  properties: {
    format: 'rawxml'
    value: replace('''
      <policies>
        <inbound>
          <base />
          <set-header name="Ocp-Apim-Subscription-Key" exists-action="delete" />
          <authentication-managed-identity resource="2ff814a6-3304-4ab8-85cb-cd0e6f879c1d" />
          <set-backend-service base-url="__DATABRICKS_ORIGIN__" />
          <rewrite-uri template="/serving-endpoints/databricks-gpt-oss-20b/invocations" copy-unmatched-params="false" />
        </inbound>
        <backend><base /></backend>
        <outbound><base /></outbound>
        <on-error><base /></on-error>
      </policies>
      ''', '__DATABRICKS_ORIGIN__', databricksOrigin)
  }
}

resource subscriptions 'Microsoft.ApiManagement/service/subscriptions@2024-05-01' = [for caller in ['a', 'b']: {
  parent: gateway
  name: 'comparison-app-${caller}'
  properties: {
    displayName: 'Comparison application ${toUpper(caller)}'
    scope: '/apis/${api.name}'
    state: 'active'
    allowTracing: false
  }
}]

output apiResourceId string = api.id
output chatPath string = '/default/models/openai/v1/chat/completions'
output databricksPath string = '/default/models/databricks-gpt-oss-20b/invocations'
output subscriptionNames array = [for (caller, index) in ['a', 'b']: subscriptions[index].name]
