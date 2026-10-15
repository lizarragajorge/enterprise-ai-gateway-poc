export type DetailId = 'apps' | 'gateway' | 'azure' | 'databricks' | 'aws' | 'gcp' | 'identity' | 'telemetry' | 'cost' | 'tools';
export type CapabilityId = 'multi-cloud' | 'routing' | 'reliability' | 'observability' | 'finops' | 'safety' | 'performance' | 'developer-experience';
export interface Capability {
  id: CapabilityId;
  label: string;
  title: string;
  nodes: DetailId[];
  gatewayRole: string;
  demoScope: string;
  experience: string;
  example: string;
  test: string;
  demonstrated: string;
  documented: string;
  external: string;
  gap: string;
}
export const docs = {
  overview: 'https://learn.microsoft.com/en-us/azure/api-management/ai-gateway-overview',
  governance: 'https://learn.microsoft.com/en-us/azure/api-management/ai-gateway-govern-secure-assets',
  assets: 'https://learn.microsoft.com/en-us/azure/api-management/ai-gateway-manage-models-tools'
};
export const details: Record<DetailId, { title: string; requirement: string; responsibility: string; proof: string; limitation: string; source: string }> = {
  apps: {
    title: 'Applications / agents', requirement: 'Developer experience; application attribution.',
    responsibility: 'Call one gateway endpoint. The local backend holds caller keys and, for workload requests, runs a separate model selector.',
    proof: 'A successful call proves this client can consume the configured API. Automatic results include the actual local selection record. A/B select server-side demo keys.',
    limitation: 'Identity selection is a demo control, not user authentication. No agents or accounts are deployed. The selector is application code, not APIM adaptive routing.',
    source: docs.overview
  },
  gateway: {
    title: 'APIM AI Gateway | new tier', requirement: 'Routing, reliability, safety, performance, centralized controls.',
    responsibility: 'Authenticate callers, protect backend credentials, dispatch published model names and export token usage. Apply configured native policies.',
    proof: 'Real Azure calls traverse this gateway. The local router checks measured workload eligibility and prices; the gateway dispatches that published name. An approval refusal happens locally before a gateway call.',
    limitation: 'Public preview, no SLA. Workload assessment and cost selection are custom code. Native policy enforcement, retry, failover, caching and streaming are not demonstrated here.',
    source: docs.governance
  },
  azure: {
    title: 'Azure models', requirement: 'Access to Azure-hosted models without distributing provider credentials.',
    responsibility: 'Foundry / Azure OpenAI backend, imported into the gateway.',
    proof: 'A successful request to a configured Azure model is client-visible evidence, not a backend trace.',
    limitation: 'Inspect configured models and actual responses for coverage. Other providers need deployment, import, permissions and verified API compatibility; multiple Azure models do not prove multi-cloud support.',
    source: docs.assets
  },
  databricks: {
    title: 'Databricks models · Azure-hosted', requirement: 'A second backend provider behind the same gateway, not a second cloud.',
    responsibility: 'The same gateway/local app API dispatches to native Databricks invocations with an OpenAI-style payload. Native Other endpoint support is not universal endpoint normalization.',
    proof: 'The published alias is selectable only when configured. A supported gateway response in the current session is live proof; the saved direct-call snapshot is historical direct evidence only.',
    limitation: 'Configuration is not a credential-health check; the gateway-held inference-scoped PAT expires and requires rotation. No Unity Catalog tool/data access, multicloud, intelligent routing, failover or telemetry is demonstrated by this call. Built-in Foundation Model API access is workspace-level; no per-model authorization is claimed.',
    source: docs.assets
  },
  aws: {
    title: 'AWS models', requirement: 'Include AWS workloads in a multi-cloud evaluation.',
    responsibility: 'A configured provider endpoint supplies a supported model API.',
    proof: 'Only an actual successful request proves this integration. An architectural node proves nothing.',
    limitation: 'Verify the specific Bedrock endpoint, authentication and API compatibility. Do not assume native Bedrock APIs are translated.',
    source: docs.assets
  },
  gcp: {
    title: 'GCP / Gemini models', requirement: 'Include Gemini / GCP alongside Azure and AWS.',
    responsibility: 'A configured Google Vertex endpoint supplies a supported model API.',
    proof: 'Only an actual successful request proves this integration.',
    limitation: 'Verify the specific Vertex/Gemini endpoint and API support. This client supports OpenAI chat or native Anthropic Messages, not arbitrary provider APIs.',
    source: docs.assets
  },
  identity: {
    title: 'Identity & credentials', requirement: 'Central credentials, isolation and least privilege.',
    responsibility: 'Entra ID for management; gateway runtime keys for callers; managed identity or supported credentials for backends.',
    proof: 'Distinct A/B runtime keys are configured server-side. Caller-identity policy objects persist, but live A/A/A/B tests have not produced a rate rejection.',
    limitation: 'Runtime keys are gateway-scoped: every published model/tool is reachable. Different keys do not prove per-asset authorization, independent limit enforcement or different policy allowances.',
    source: docs.governance
  },
  telemetry: {
    title: 'Observability | supporting service', requirement: 'OTel, traces, tokens, latency, errors, attribution and audit.',
    responsibility: 'Application Insights / an OTLP destination collects available gateway signals.',
    proof: 'A validated native exporter and a read-only Azure Monitor snapshot establish token metric ingestion separately from returned usage and local round-trip timing. Absent evidence does not prove a connection.',
    limitation: 'Specific governance docs: OTLP exports only model token usage in preview, not logs/traces or MCP traffic. Portal monitoring differs. Neither timing nor a trace ID proves full agent-to-tool tracing.',
    source: docs.governance
  },
  cost: {
    title: 'Usage / cost | supporting service', requirement: 'Accounting, quotas, dollar budgets, anomalies and showback.',
    responsibility: 'Combine attributed usage with provider billing / Azure Cost Management and reporting controls.',
    proof: 'Cost-routed responses can estimate model token cost from actual returned usage and verified public prices. Missing or mismatched usage/model leaves cost unavailable.',
    limitation: 'A list-price estimate is not a bill. No budget enforcement, anomaly detection or showback is implemented. Token limits are not dollar budgets. Gateway preview pricing is not announced in the reviewed docs.',
    source: docs.governance
  },
  tools: {
    title: 'Synthetic data / enterprise tools', requirement: 'A governed, read-only enterprise data boundary.',
    responsibility: 'Publish an approved read-only API as MCP alongside the existing enterprise data estate. A data-platform integration is not assumed.',
    proof: 'The panel contains only a synthetic example. No MCP call or enterprise data connection is made.',
    limitation: 'MCP is documented on this tier; requires a gateway-reachable hosted backend, selected read-only operations and a verified MCP exchange. Localhost is not reachable from Azure.',
    source: docs.assets
  }
};
export const requirements: Capability[] = [
  {
    id: 'multi-cloud', label: 'Model access',
    title: 'Choose a model', nodes: ['gateway', 'azure', 'databricks', 'aws', 'gcp'],
    gatewayRole: 'Publish models behind one endpoint and keep provider credentials out of applications.',
    demoScope: 'Foundry and Databricks on Azure. A response verifies access in this session, not multicloud support.',
    experience: 'Choose a configured model and send a real request through the same gateway.',
    example: 'Application A -> gateway -> published Azure model\nApplication B -> same gateway -> approved AWS or GCP model\nProvider/model choices are architectural examples, not live integrations.',
    test: 'Send a synthetic prompt. Repeat with a second actual provider using the same application and prompt; require real responses from both. One Azure call does not prove multi-cloud support.',
    demonstrated: 'Only models with a successful live result in this session; inspect the observed path or Architecture badges.',
    documented: 'Foundry imports and custom providers; format-specific endpoints.',
    external: 'Provider deployment, credentials, endpoint/API compatibility validation.',
    gap: 'No universal API translation claim; uncalled providers remain unverified.'
  },
  {
    id: 'routing', label: 'Selection & dispatch',
    title: 'Custom selection, gateway dispatch', nodes: ['gateway'],
    gatewayRole: 'Dispatch the model selected by our separate router.',
    demoScope: 'Our code checks workload approval and cost. AI Gateway dispatches; it does not assess model quality.',
    experience: 'The app declares a workload. Our selector chooses an approved model; AI Gateway authenticates and dispatches the call.',
    example: 'Extraction: exact labeled fields\nReconciliation: source, revision, void and tie rules\n3/3 fixed checks required per model/workload\nBoth pass → cheapest wins. Neither passes → no call.\nExternal publication has no evaluated approval.',
    test: 'Inspect actual evaluation responses. Submit extraction and reconciliation workloads; compare measured eligibility, the backend decision and returned model. Submit the unevaluated workload to observe a local refusal with no gateway call.',
    demonstrated: 'Real fixed-case evaluations, custom eligibility-based cost selection, and actual responses/refusals when observed. No premium model choice is forced.',
    documented: 'Exact-match dispatch using the model field.',
    external: 'The selector and evaluation file are local application code. Production needs representative holdout evaluations, approval governance, sustained capacity and price refresh.',
    gap: 'Three synthetic cases are not a general quality guarantee or live health check. Refusal is not gateway enforcement; the manual API does not apply this approval gate. No native adaptive routing, budget, retry, latency or residency optimization claim.'
  },
  {
    id: 'reliability', label: 'Reliability',
    title: 'Protect shared capacity', nodes: ['gateway', 'identity'],
    gatewayRole: 'Set request and token limits at the gateway.',
    demoScope: 'Legacy-model limits are configured. Enforcement, caller isolation and failover are not demonstrated.',
    experience: 'A shared policy boundary lets platform teams manage traffic controls instead of duplicating them in each application.',
    example: 'Native limit configuration on the legacy model:\n2 requests / 30 seconds\n1,000 tokens / minute\nCounter: caller identity\n\nCurrent selectable models do not have these policies. A provider 429 does not prove gateway enforcement.',
    test: 'To prove isolation, test the policy-attached legacy model with repeated A calls, then B. Require a correlated gateway-policy 429 for A and success for B. Do not use the current cost pair as proof.',
    demonstrated: 'Actual HTTP failures are surfaced; no automatic application retries. A/A/A/B rate tests remained 200 despite persisted limit policies.',
    documented: 'Request/token limits and Retry-After on rate-limit blocks.',
    external: 'Provider capacity planning and separately validated balancing, retries and failover.',
    gap: 'No SLA in preview. Rate enforcement is unverified in this deployment; balancing, retry and failover are not confirmed or demonstrated.'
  },
  {
    id: 'observability', label: 'Monitoring',
    title: 'Gateway token usage', nodes: ['telemetry', 'apps'],
    gatewayRole: 'Export model token usage from the gateway to a central monitoring destination.',
    demoScope: 'Saved Azure Monitor token metrics. Not live charts or per-request traces.',
    experience: 'Open the native token dashboard or inspect the saved Azure snapshot. This is gateway telemetry, separate from browser timing.',
    example: 'Native metric observed in this runtime:\nazure.ai_gateway.client.token.usage\nLabels: gen_ai.request.model | gen_ai.token.type\n\nRead-only snapshot comes from Azure Monitor PromQL, not the local response. Prompt/response capture stays off.',
    test: 'Send a synthetic model call, then refresh the native snapshot with npm run read:monitoring and restart the demo. Compare Azure Monitor series with returned usage; do not treat aggregate metrics as a per-request trace.',
    demonstrated: 'Native gateway token metric ingestion when the Azure Monitor snapshot is available. Local response status, round-trip timing and returned usage remain separate client observations.',
    documented: 'OTLP model token metric; Application Insights portal model/tool monitoring.',
    external: 'Application Insights and its managed collection/metrics resources. Full application/user attribution, audit logs, policy-decision evidence and client/agent/tool instrumentation require separate validation or implementation.',
    gap: 'OTLP logs, traces and MCP traffic export are not available per specific preview monitoring docs. No end-to-end tracing proof.'
  },
  {
    id: 'finops', label: 'Usage & cost',
    title: 'Tokens and model cost', nodes: ['cost', 'identity'],
    gatewayRole: 'Centralize token consumption signals and configure token allowances by caller identity.',
    demoScope: 'Our selector estimates model token cost. No dollar budgets, billing or showback.',
    experience: 'Gateway usage is an input to FinOps. Ownership mapping and provider billing turn that input into financial reporting.',
    example: 'Gateway: token usage + configured token allowances\nOur selector: model-token cost estimate\nFinance/reporting: provider billing + ownership mapping\n\nToken limits are not dollar budgets.',
    test: 'Run a workload in Selection & dispatch to see a usage-based estimate. Compare it with native token metrics; use provider billing for actual charges.',
    demonstrated: 'Returned token usage and, for cost-routed responses with a verified model version, public list-price estimates.',
    documented: 'Caller-identity token/request limits; usage signals.',
    external: 'App/team ownership mapping, provider billing / Cost Management, dollar budgets, anomaly detection and showback/chargeback pipeline.',
    gap: 'No bill reconciliation, dollar budget enforcement, anomaly detection or showback. The cost selector is custom application code; preview gateway pricing pending.'
  },
  {
    id: 'safety', label: 'Safety & guardrails',
    title: 'Central guardrails', nodes: ['gateway', 'tools'],
    gatewayRole: 'Apply supported Content Safety, Prompt Shields, blocklists and IP restrictions before forwarding.',
    demoScope: 'Gateway controls loads profile-specific native Content Safety evidence. Only assets with attributable blocked and allowed observations can run fixed live tests.',
    experience: 'One policy boundary can govern multiple model and tool assets, with an Azure AI Content Safety backend where required.',
    example: 'Verified native path only:\nCaller -> gateway Content Safety policy -> allow or reject -> model\nSaved configuration and runtime verification are separate; uncovered assets remain unverified.',
    test: 'Use the fixed harmless block/allow buttons in Gateway controls. Each click makes one real request; require an exact native-specific signature and verified asset binding, never status alone.',
    demonstrated: 'No local content filter; a policy block needs a real gateway rejection and correlated policy evidence.',
    documented: 'Content Safety, Prompt Shields, blocklists, IP filters; policy applicability varies by asset.',
    external: 'Azure AI Content Safety resource, blocking policy configuration and data governance.',
    gap: 'No configured policy is inferred from a 400/403/429 alone. Synthetic tools do not prove enterprise governance.'
  },
  {
    id: 'performance', label: 'Performance',
    title: 'Measure a model call', nodes: ['gateway', 'azure', 'aws', 'gcp'],
    gatewayRole: 'Provide a shared runtime path with central request and token controls.',
    demoScope: 'App-measured round trip. Caching, streaming and throughput improvements are not demonstrated.',
    experience: 'Measure the model call through the gateway. This client sends non-streaming requests; a single timing is not a benchmark.',
    example: 'Benchmark separately:\nDirect-provider vs gateway latency\nTime to first token and streaming support\nThroughput, concurrency and error rate\n\nCaching and latency-aware selection require separate tier validation or custom components.',
    test: 'Send a request to establish a local round-trip baseline. No streaming, semantic cache, token optimization, latency-aware routing or throughput benchmark is implemented.',
    demonstrated: 'One request local round-trip measurement; bounded response size.',
    documented: 'Supported model endpoints vary by provider; request/token controls protect capacity.',
    external: 'Provider tuning, prompt/token optimization, benchmark harness and any separately validated cache.',
    gap: 'No semantic cache, token optimization, streaming, throughput or latency SLA is demonstrated or confirmed for this client/tier.'
  },
  {
    id: 'developer-experience', label: 'Developer API',
    title: 'Keep provider setup out of app code', nodes: ['apps', 'identity', 'tools'],
    gatewayRole: 'Publish discoverable models and tools with runtime access keys and format-specific endpoints.',
    demoScope: 'Live OpenAI-compatible HTTP calls. SDK compatibility and MCP execution are not tested.',
    experience: 'Apps use a published model name and a gateway key. The gateway manages backend credentials and central configuration.',
    example: 'Illustrative HTTP shape, not an SDK test:\nPOST <gateway>/default/models/openai/v1/chat/completions\napi-key: <gateway runtime key>\n{ "model": "<published model>", "messages": [...] }\nAnthropic uses native Messages passthrough, not universal translation.',
    test: 'Send through the shared form, then inspect the redacted request shape. Validate the specific OpenAI SDK, api-key header, model and endpoint separately before claiming SDK compatibility.',
    demonstrated: 'One local request form; server-side keys; same API format for compatible configured models.',
    documented: 'Central model/tool catalog, structured policy cards and runtime keys.',
    external: 'Secret management, organizational onboarding and per-asset authorization if required.',
    gap: 'Not one universal API: Anthropic is native Messages passthrough. No per-model/tool runtime key scope.'
  }
];
