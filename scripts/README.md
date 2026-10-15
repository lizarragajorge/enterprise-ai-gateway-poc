# Operator tooling

The UI/server runtime continues to use its existing local `.env` and gateway
profiles. Deployment configuration is separate: it supplies **non-secret,
operator-owned resource bindings** to the Azure configuration, readback,
governance and safety scripts. Starting the local app and running offline tests
do not require deployment configuration.

From the repository root:

```sh
mkdir -p .local
cp scripts/deployment-config.example.json .local/deployment-config.json
```

Replace **every** placeholder with the resources you own before running an
operator script. Keep this file local and ignored; never put keys, tokens,
passwords or connection strings in it. All fields below are required strings.
Missing/invalid configuration stops these scripts before their Azure operations;
they never infer a destination from the currently selected Azure CLI account.
The helper resolves the file relative to the repository, not a machine-specific
absolute path.

| Field | Required binding |
| --- | --- |
| `subscriptionId` | Azure subscription GUID containing all configured resources. |
| `resourceGroup` | Resource group for the standalone AI Gateway, models, monitoring and Content Safety. |
| `gatewayName` | Standalone AI Gateway resource name. |
| `modelAccountName` | Existing Azure model account name in that group. |
| `gatewayOrigin` | Exact HTTPS standalone runtime origin, whose host starts with `gatewayName` and ends in `.ai.gateway.azure.com`. |
| `comparisonResourceGroup` | Resource group containing the comparison APIM service and Foundry account. |
| `comparisonGatewayName` | Existing comparison APIM service name. |
| `comparisonFoundryName` | Comparison Foundry account name. |
| `comparisonProjectName` | Existing Foundry project name within that account. |
| `comparisonGatewayOrigin` | `https://<comparisonGatewayName>.azure-api.net`. |
| `databricksResourceGroup` | Resource group containing the existing Databricks workspace. |
| `databricksWorkspaceName` | Existing Databricks workspace resource name. |
| `databricksOrigin` | Exact HTTPS workspace origin: `https://adb-<workspace-id>.<number>.azuredatabricks.net`. |
| `monitoringInsightsName` | Application Insights resource in `resourceGroup`. Managed collection rules/workspaces must still match its Azure-generated names. |
| `monitoringWorkspaceName` | Expected Log Analytics workspace in `resourceGroup`; a different destination remains an error. |
| `contentSafetyAccountName` | Content Safety account in `resourceGroup`. The explicit safety configure mode can create it if absent. |
| `contentSafetyLocation` | Azure region identifier for that Content Safety account, such as `eastus2`. |

Origins must not include credentials, custom ports, paths, queries or fragments.
These scripts currently target Azure public-cloud service endpoints.
Ownership tags, managed identity checks, model aliases, fixed synthetic fixtures,
evaluation/expiry requirements and evidence validation remain independent gates.

**Configuration is not authorization to deploy or call models.** Review each
script before invoking it: `configure:*` commands can modify Azure, some
verification/check scripts perform paid inference, and readback commands acquire
Azure CLI access tokens and contact Azure. Filling this JSON or running the
offline config tests does none of those things. Authenticate only to your own
subscription and follow your own change-approval process.

Bicep templates no longer contain a shared deployment destination. Templates
that refer to existing resources require explicit resource-name parameters.
Templates that create resources use deterministic names derived from the target
resource group's ID, not an existing operator's names. When managing an existing
deployment, pass its names explicitly; in particular, pass `accountName` for
`routing-model.bicep`, `cost-model.bicep` and `current-cost-models.bicep`;
`gatewayName` for `model.bicep`; and all three resource bindings for
`comparison-api.bicep`. The routing and cost operator scripts supply their
existing account binding automatically. Bicep does not read the JSON directly.
Region/SKU/API/model availability must be verified for the target subscription;
defaults are demo choices, not claims of GA availability.

Offline validation (no Azure access or model calls):

```sh
node --test server/deployment-config.test.ts
npm run check
```
