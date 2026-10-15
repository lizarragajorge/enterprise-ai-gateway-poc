export const referenceSources = {
  agent365: 'https://learn.microsoft.com/en-us/azure/foundry/agents/concepts/agent-365-integration',
  foundry: 'https://learn.microsoft.com/en-us/azure/foundry/agents/overview',
  association: 'https://learn.microsoft.com/en-us/azure/foundry/configuration/enable-ai-api-management-gateway-portal',
  apim: 'https://learn.microsoft.com/en-us/azure/api-management/genai-gateway-capabilities',
  tools: 'https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/tools/governance',
  newTier: 'https://learn.microsoft.com/en-us/azure/api-management/ai-gateway-overview'
};
const sourceLinks = [
  { label: 'Agent 365 integration and prerequisites', url: referenceSources.agent365 },
  { label: 'Foundry Agent Service', url: referenceSources.foundry },
  { label: 'Foundry resource / APIM v2 association', url: referenceSources.association },
  { label: 'Broader APIM AI gateway capabilities', url: referenceSources.apim },
  { label: 'Foundry MCP governance (preview)', url: referenceSources.tools },
  { label: 'New AI Gateway tier (this PoC)', url: referenceSources.newTier }
];

export const referenceDetails = {
  governance: {
    title: 'Agent 365 · enterprise governance',
    role: 'What agents exist, who owns them, what identities and resources they access, and how they are governed.',
    documented: 'Agent inventory, access control, visualization, interoperability and security. Foundry integration supports registry sync; supported agent types and telemetry setup differ.',
    recommendation: 'Use an organization-wide governance plane across federated workload boundaries, rather than forcing all inference through one gateway.',
    demo: 'Agent 365 and Foundry agent registration are not enabled or demonstrated in this PoC.',
    limitation: 'The reviewed integration requires tenant licensing, Frontier enrollment and administrator enablement/terms acceptance. Hosted-agent activity export needs SDK configuration and Entra permissions. Agent 365 residency follows the tenant, not necessarily the Foundry region.',
    sources: [referenceSources.agent365]
  },
  security: {
    title: 'Entra · Defender · Purview',
    role: 'Agent identity, least-privilege access, threat detection and data protection across the organization.',
    documented: 'Agent 365 uses Entra Agent ID and integrates Microsoft Defender and Purview for agent security and compliance.',
    recommendation: 'Apply identity, access-review, data-residency and security standards consistently across runtime boundaries. Review product enablement and licensing separately.',
    demo: 'The PoC uses Entra for Azure management and managed identity for the Azure model backend. Agent ID, Defender and Purview integrations are not demonstrated.',
    limitation: 'New AI Gateway runtime keys are gateway-scoped and reach all published assets. They are not Entra Agent ID, per-model authorization or proof of enterprise least privilege.',
    sources: [referenceSources.agent365, referenceSources.newTier]
  },
  boundary: {
    title: 'Choose the isolation boundary first',
    role: 'Decide which applications can share runtime controls and which require separate infrastructure.',
    documented: 'Foundry gateway integration shares one associated APIM instance across projects in a resource. Separate Foundry resources support separate gateway associations for strict isolation.',
    recommendation: 'Share a boundary for related workloads. Separate for security/regulation, network, environment, region, ownership, blast radius, materially different policy or dedicated capacity. Neither one gateway per app nor one gateway for the whole enterprise is the default.',
    demo: 'The two boundaries shown are examples, not deployed resources or a prescribed gateway count.',
    limitation: 'This pattern is not a guarantee of isolation. Validate tier, network controls, capacity and authorization. APIM v2 applies to Foundry portal automatic resource/project association, not to importing Foundry model backends into the new AI Gateway tier.',
    sources: [referenceSources.association, referenceSources.apim]
  },
  foundry: {
    title: 'Foundry · AI engineering platform',
    role: 'Build, deploy, evaluate, observe and operate agents, models and tools.',
    documented: 'Agent runtime, toolboxes, model access, observability, identity/security and publishing. The native gateway association is at Foundry resource level; new projects are enabled by default and existing projects require enablement.',
    recommendation: 'Group projects for applications/use cases in a Foundry resource aligned to meaningful platform and isolation requirements. Share a gateway where those projects share a boundary.',
    demo: 'Azure model calls work in the PoC. These illustrated Foundry resources/projects, hosted agents, toolboxes and Agent 365 association are not deployed by this view.',
    limitation: 'Foundry portal automatic resource/project association can create Basic v2 or reuse compatible APIM v2 in the same tenant/subscription. That association is not verified for this PoC’s new AI Gateway tier; Foundry backend imports are supported without it.',
    sources: [referenceSources.foundry, referenceSources.association]
  },
  applications: {
    title: 'Projects · applications and agents',
    role: 'Own the use case, agent behavior, evaluation contracts and calls to approved models/tools.',
    documented: 'Multiple projects in a Foundry resource can share its associated gateway and have independent project token limits in the documented v2 integration.',
    recommendation: 'Organize use cases into projects and reuse their boundary gateway. Route only explicitly governed calls through it; agents outside Foundry can also be clients of supported APIs.',
    demo: 'Applications A/B are local caller-key selections, not deployed Foundry projects. Workload assessment and cost selection are our Node code.',
    limitation: 'Project-level quotas from the v2 guide are not proven by this PoC’s A/B keys. Model/tool API compatibility and actual gateway use require verification; token quotas are not dollar budgets.',
    sources: [referenceSources.association, referenceSources.foundry]
  },
  gateway: {
    title: 'AI Gateway · runtime enforcement',
    role: 'When an app or agent calls a governed model or tool, enforce the configured access and traffic policies at that boundary.',
    documented: 'Broader APIM supports AI models, remote MCP and A2A APIs; capabilities vary by tier. The new AI Gateway tier supports Foundry backend imports, runtime keys, exact model-name dispatch, native limit/safety/IP policies and MCP publishing.',
    recommendation: 'Federate gateways by isolation boundary while centralizing policy standards. Validate routing, authorization, resilience, caching and telemetry against the chosen tier before claiming them.',
    demo: 'The new-tier PoC has real Azure model calls, backend credentials and native token metric ingestion. Workload-quality assessment and cost ranking remain custom code.',
    limitation: 'This PoC’s tier is public preview with no SLA and gateway-scoped keys. Foundry v2 association, XML policies, A2A, retries/failover, caching and per-project authorization are not demonstrated or assumed here.',
    sources: [referenceSources.newTier, referenceSources.apim, referenceSources.association]
  },
  backends: {
    title: 'Models · governed tools · data estate',
    role: 'Execute model inference or approved tool operations behind the workload boundary gateway.',
    documented: 'APIM can govern supported Foundry, external and self-hosted endpoints. Foundry’s preview MCP governance applies to new portal-created tools without managed OAuth; verify the configured gateway URL.',
    recommendation: 'Keep approved read-only tools at the enterprise data boundary. Databricks can be a model provider or data/tool estate; it is not automatically another gateway.',
    demo: 'Foundry gateway calls and historical direct Databricks evidence are separate. APIM → Databricks is selectable when its published alias is configured; only current-session supported gateway responses prove it. No AWS/GCP, MCP or Unity Catalog tool/data execution is claimed.',
    limitation: 'Verify each endpoint’s authentication and API format. Databricks built-in Foundation Model API access is workspace-level, not per-model authorization. Foundry MCP governance uses the associated APIM setup; new-tier MCP publishing is a separate documented path. No universal translation or full agent-to-tool audit claim.',
    sources: [referenceSources.apim, referenceSources.tools, referenceSources.newTier]
  }
};

export type ReferenceDetailId = keyof typeof referenceDetails;
type ReferenceDetail = (typeof referenceDetails)[ReferenceDetailId];
type ReferenceInstance = { detail: ReferenceDetailId } & Partial<ReferenceDetail>;

export const referenceInstances = {
  governance: { detail: 'governance' },
  security: { detail: 'security' },
  'boundary-shared': {
    detail: 'boundary', title: 'Shared internal workloads',
    role: 'A shared runtime boundary for related internal applications with compatible trust, networking and policy requirements.',
    recommendation: 'A platform team operates one Foundry resource and gateway for Projects A/B. Share ownership, common policies and approved capacity; use project-level limits where the selected integration supports them.',
    demo: 'Illustrative grouping only. Projects A/B are not the local Application A/B keys, and this shared enterprise boundary is not deployed.'
  },
  'boundary-isolated': {
    detail: 'boundary', title: 'Regulated production workload',
    role: 'A separate runtime boundary when sensitive production traffic has materially different security, residency or operational requirements.',
    recommendation: 'Use a separate Foundry resource and gateway when regulation, network isolation, policy ownership or blast radius justifies it. Validate access, region and capacity controls; a separate box alone does not create compliance.',
    demo: 'Illustrative isolation decision only. No regulated production environment, compliance control or additional gateway is deployed.'
  },
  'foundry-shared': {
    detail: 'foundry', title: 'Foundry resource 1 · shared',
    recommendation: 'Group Projects A/B within the same resource because they share an internal platform boundary. The platform team manages engineering services and the documented v2 gateway association.',
    demo: 'This illustrated resource and its projects are not deployed. Existing Azure model calls are demonstrated separately in Live PoC.'
  },
  'foundry-isolated': {
    detail: 'foundry', title: 'Foundry resource 2 · isolated',
    recommendation: 'Place Project C in a separate resource when production requirements need an independent boundary and gateway association.',
    demo: 'This illustrated resource, project and agent runtime are not deployed.'
  },
  'projects-shared': {
    detail: 'applications', title: 'Projects A + B · shared resource',
    recommendation: 'Application teams own their use cases and evaluations in Projects A/B, while reusing platform controls. Their governed model/tool calls use the shared gateway; external applications can also be gateway clients.',
    demo: 'These projects are reference examples, not Application A/B in the PoC. Our local workload selector is still custom Node code.'
  },
  'projects-isolated': {
    detail: 'applications', title: 'Project C · isolated resource',
    recommendation: 'The production team owns the use case and evaluation contract in Project C. Govern its model/tool calls through the isolated gateway rather than sharing another workload’s trust boundary.',
    demo: 'Project C and a production agent are not deployed. No production data is used.'
  },
  'gateway-shared': {
    detail: 'gateway', title: 'APIM AI Gateway · shared',
    recommendation: 'The platform team defines common runtime access and traffic policies for related workloads. Share approved backends and capacity; verify each application’s controls on the chosen APIM tier.',
    demo: 'This is a reference gateway, not our deployed instance. The separate Live PoC proves new-tier Azure calls and native token metrics, not this v2 resource association.'
  },
  'gateway-isolated': {
    detail: 'gateway', title: 'APIM AI Gateway · isolated',
    recommendation: 'Operate an independent gateway when production trust, networking, policy ownership or blast radius requires separation. Tier-check all proposed authorization, routing and resilience controls.',
    demo: 'No additional production gateway or isolation control is deployed. The separate PoC runs the new preview tier.'
  },
  'backends-shared': {
    detail: 'backends', title: 'Shared models + governed tools',
    recommendation: 'The platform team publishes approved model endpoints and read-only tools for the shared internal workloads. Keep provider credentials and data permissions at the appropriate boundaries.'
  },
  'backends-isolated': {
    detail: 'backends', title: 'Isolated models + governed tools',
    recommendation: 'Approve providers, regions and tool/data access for this production boundary independently. Backends can be shared only if their own access, residency and capacity controls meet the isolation requirement.'
  },
  'registry-shared': {
    detail: 'governance', title: 'Agent 365 ↔ Foundry resource 1',
    role: 'A governance connection for published-agent registry and supported activity collection, not model request traffic.',
    recommendation: 'Register supported published agents from the shared Foundry resource in the enterprise inventory. Configure activity export, licensing and tenant enablement before expecting governance data.',
    demo: 'No registry sync or activity export is configured for these illustrated agents.'
  },
  'registry-isolated': {
    detail: 'governance', title: 'Agent 365 ↔ Foundry resource 2',
    role: 'A governance connection for agent inventory and supported activity collection across the isolated boundary, not an inference hop.',
    recommendation: 'Keep enterprise inventory consistent while separately reviewing residency and activity-export permissions for the regulated resource.',
    demo: 'No Agent 365 connection or cross-region activity export is demonstrated.'
  },
  'identity-shared': {
    detail: 'security', title: 'Entra → shared workload identities',
    role: 'Identity and access controls for agents and backend resources in the shared boundary; this is not a model request path.',
    recommendation: 'Apply least-privilege agent/backend identities and access reviews to the shared workloads. Runtime authentication depends on the selected gateway tier, not on this diagram connection alone.'
  },
  'identity-isolated': {
    detail: 'security', title: 'Entra → isolated workload identities',
    role: 'Identity and access controls for the isolated production agents and resources, separate from inference traffic.',
    recommendation: 'Scope production identities and resource permissions independently. Validate conditional access, backend permissions and gateway authentication for the chosen architecture.'
  },
  'association-shared': {
    detail: 'foundry', title: 'Resource 1 ↔ shared gateway',
    role: 'Foundry resource-level gateway association, not an extra inference hop or a parent-child Azure resource relationship.',
    recommendation: 'Use the documented APIM v2 association for the shared Foundry resource. Add existing projects explicitly and verify governed traffic and supported project limits.',
    demo: 'Native Foundry association is not configured or verified on this PoC’s new AI Gateway tier.'
  },
  'association-isolated': {
    detail: 'foundry', title: 'Resource 2 ↔ isolated gateway',
    role: 'A separate Foundry resource-level gateway association for a workload requiring an independent runtime boundary.',
    recommendation: 'Associate the isolated resource with an appropriate compatible APIM v2 instance and validate the actual network, authorization and policy requirements.',
    demo: 'This association and the illustrated isolated gateway are not deployed.'
  }
} satisfies Record<string, ReferenceInstance>;

export type ReferenceInstanceId = keyof typeof referenceInstances;
export function isReferenceInstance(id: string): id is ReferenceInstanceId {
  return Object.hasOwn(referenceInstances, id);
}
export function getReferenceDetail(id: ReferenceInstanceId): ReferenceDetail {
  const instance: ReferenceInstance = referenceInstances[id];
  return { ...referenceDetails[instance.detail], ...instance };
}

function referenceButton(id: ReferenceInstanceId, title: string, subtitle: string, icon?: string): string {
  return `<button type="button" class="reference-node" data-reference="${id}" aria-pressed="false">
    ${icon ? `<img src="${icon}" alt="" width="26" height="26">` : ''}
    <span><strong>${title}</strong><small>${subtitle}</small></span></button>`;
}

function connection(id: ReferenceInstanceId, source: string, target: string, label: string): string {
  return `<button type="button" class="reference-connection" data-reference="${id}" aria-pressed="false" aria-label="${source} to ${target}: ${label}; not inference traffic">
    <span>${source}</span><svg viewBox="0 0 40 12" width="40" height="12" aria-hidden="true"><path class="connection-line" d="M1 6H36"/><path d="M31 2L37 6L31 10"/></svg><span>${target}</span><small>${label}</small>
  </button>`;
}

function boundary(id: 'shared' | 'isolated', resource: string, projects: string): string {
  const label = id === 'shared' ? 'Shared internal workloads' : 'Regulated production workload';
  const rationale = id === 'shared' ? 'Example · common ownership & policy' : 'Example · distinct trust & production controls';
  return `<section class="reference-boundary">
    <button type="button" class="reference-boundary-label" data-reference="boundary-${id}" aria-pressed="false">${label}<span>${rationale}</span></button>
    <div class="reference-controls" role="group" aria-label="${label} governance connections">
      ${connection(`registry-${id}`, 'Agent 365', `Foundry ${resource}`, 'Registry / activity')}
      ${connection(`identity-${id}`, 'Entra', `${id} identities`, 'Identity / access')}
    </div>
    <div class="reference-flow" role="group" aria-label="${label} proposed runtime request path">
      <section class="reference-foundry-resource" aria-label="Foundry resource ${resource} contains ${projects}">
        <span class="reference-layer">AI engineering</span>
        ${referenceButton(`foundry-${id}`, `Foundry resource ${resource}`, 'Build · evaluate · operate', '/icons/ai-foundry.svg')}
        <div class="reference-projects">${referenceButton(`projects-${id}`, projects, 'Application / agent callers')}</div>
      </section>
      <span class="reference-arrow" aria-hidden="true">→</span>
      <div class="reference-runtime"><span class="reference-layer">Runtime enforcement</span>${referenceButton(`gateway-${id}`, `APIM AI Gateway · ${id}`, 'Access · limits · policies', '/icons/ai-gateway.svg')}</div>
      <span class="reference-arrow" aria-hidden="true">→</span>
      <div class="reference-runtime"><span class="reference-layer">AI backends</span>${referenceButton(`backends-${id}`, 'Models + governed tools', 'Foundry · external · MCP / data', '/icons/azure-openai.svg')}</div>
    </div>
    <div class="reference-association">
      ${connection(`association-${id}`, `Foundry ${resource}`, `${id} gateway`, 'Resource association · APIM v2')}
    </div>
  </section>`;
}

export const organizationReferenceMarkup = `
  <div class="reference-governance" role="group" aria-label="Enterprise governance plane">
    <span class="reference-plane-label">Enterprise governance · organization-wide</span>
    ${referenceButton('governance', 'Microsoft Agent 365', 'Inventory · ownership · lifecycle')}
    ${referenceButton('security', 'Entra · Defender · Purview', 'Identity · security · data protection')}
  </div>
  <div class="reference-boundaries">
    ${boundary('shared', '1', 'Projects A + B')}
    ${boundary('isolated', '2', 'Project C')}
  </div>
  <p class="reference-legend"><span>→</span> Governed runtime call · reference only <span class="reference-dashed"></span> Registry / identity / association · not an inference hop</p>
  <p class="reference-tier-note"><strong>Tier boundary:</strong> Foundry’s portal automatic resource/project association guide uses <strong>APIM v2</strong>, not as a prerequisite for Foundry models. This PoC runs the <strong>new AI Gateway tier (preview)</strong>, which supports Foundry backend imports; the broader enterprise integrations shown are not deployed.</p>
  <details class="reference-sources"><summary>Microsoft sources · reviewed 2026-10-13</summary>
    ${sourceLinks.map(source => `<a href="${source.url}" target="_blank" rel="noreferrer">${source.label}</a>`).join('')}
  </details>`;

export function renderReferenceDetail(target: HTMLElement, id: ReferenceInstanceId) {
  const item = getReferenceDetail(id);
  target.replaceChildren();
  const eyebrow = document.createElement('p');
  eyebrow.className = 'eyebrow';
  eyebrow.textContent = 'Organization reference · not a live topology';
  const title = document.createElement('h2');
  title.textContent = item.title;
  target.append(eyebrow, title);
  const documentation = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = 'Documentation & prerequisites';
  documentation.append(summary);
  for (const [label, text] of [
    ['Role', item.role],
    ['Microsoft-documented', item.documented],
    ['How the organization uses it', item.recommendation],
    ['PoC status', item.demo],
    ['Limitation / dependency', item.limitation]
  ]) {
    const section = document.createElement('div');
    const heading = document.createElement('h3');
    heading.textContent = label;
    const body = document.createElement('p');
    body.textContent = text;
    section.append(heading, body);
    if (label === 'How the organization uses it') {
      const category = document.createElement('small');
      category.className = 'reference-recommendation';
      category.textContent = 'Architecture recommendation';
      heading.after(category);
    }
    if (label === 'Microsoft-documented' || label === 'Limitation / dependency') documentation.append(section);
    else target.append(section);
  }
  for (const url of item.sources) {
    const source = document.createElement('a');
    source.href = url;
    source.target = '_blank';
    source.rel = 'noreferrer';
    source.textContent = `${sourceLinks.find(link => link.url === url)!.label} ↗`;
    documentation.append(source);
  }
  target.append(documentation);
}
