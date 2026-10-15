import './style.css';
import { details, docs, requirements } from './explanations.ts';
import type { Capability, CapabilityId, DetailId } from './explanations.ts';
import type { CallResult, Model, GatewayId, publicConfig } from '../server/gateway.ts';
import { hasModelResponse, observedRequestPath, modelPathNode, modelCoverage } from './request-path.ts';
import type { RequestContext, RequestObservation } from './request-path.ts';
import { apimDatabricksAuth, modelLabel, renderModelCatalog } from './model-catalog.ts';
import { estimatedCostLabel, renderCostRouting } from './cost-routing.ts';
import { renderRoutingDiagram } from './routing-diagram.ts';
import type { PolicyEvidence } from '../server/policy-evidence.ts';
import type { MonitoringEvidence } from '../server/monitoring-evidence.ts';
import type { RoutingSnapshot, RoutingRejection } from '../server/routing.ts';
import { getWorkload, isWorkloadId, workloads } from '../server/workloads.ts';
import type { WorkloadId } from '../server/workloads.ts';
import { organizationReferenceMarkup, isReferenceInstance, renderReferenceDetail } from './organization-reference.ts';
import type { ReferenceInstanceId } from './organization-reference.ts';
import { catalogScope, demoPresentation, demoTabs, demoTabFor } from './demo-presentation.ts';
import { parseRequestAudit, renderMonitoring } from './monitoring.ts';
import type { RequestAuditSnapshot } from '../server/request-audit.ts';
import { isRoutingJourney, routingRequest, renderActualJourney } from './request-journey.ts';
import type { SubmittedRequest, JourneyError, PolicySnapshot } from './request-journey.ts';
import { gatewayPortal, gatewayPolicyDocumentation, governanceCallersReady, governanceCopy, governanceVerified, parseGovernanceProof, renderGovernanceProof } from './governance-proof.ts';
import type { GovernanceProof } from './governance-proof.ts';
import { parsePublicContentSafety, renderContentSafety, safetyAssetVerified, safetySummary } from './content-safety.ts';
import type { PublicContentSafetyEvidence } from './content-safety.ts';
import { explainRoutingChoice } from './routing-explanation.ts';
import { policyVersionLabel } from './request-journey.ts';

type PublicConfig = ReturnType<typeof publicConfig>;
let selectedGateway: GatewayId = 'ai-gateway';
let availableProfiles: PublicConfig[] = [];
let profileGeneration = 0;
const root = document.querySelector<HTMLDivElement>('#app')!;
const successes = new Set<string>();
const observedNodes = new Set<string>();
let lastResult: CallResult | undefined;
let lastRequestFailed = false;
let pending = false;
type ViewId = 'architecture' | CapabilityId;
let activeTab: ViewId = 'architecture';
let architectureView: 'live' | 'reference' = 'live';
let selectedReference: ReferenceInstanceId = 'boundary-shared';
let lastCapability: CapabilityId | undefined;
let inspectorMode: 'capability' | 'component' = 'component';
let inspectorOpen = false;
let inspectorTrigger: Element | null = null;
let requestObservation: RequestObservation = { phase: 'idle' };
let config: PublicConfig | undefined;
let catalogSelection: string | undefined;
let catalogConfigurationStatus = 'Loading local configuration…';
let routingSnapshot: RoutingSnapshot | undefined;
let routingLoading = false;
let routingError: string | undefined;
let policyEvidence: PolicyEvidence | undefined;
let policyError: string | undefined;
let policyReadStarted = false;
let monitoringEvidence: MonitoringEvidence | undefined;
let monitoringError: string | undefined;
let monitoringAudit: RequestAuditSnapshot | undefined;
let monitoringAuditError: string | undefined;
let monitoringEvaluations: RoutingSnapshot[] = [];
let monitoringEvaluationError: string | undefined;
let monitoringContextLoading = false;
let monitoringContextGeneration = 0;
let snapshotGeneration = 0;
let workloadId: WorkloadId = 'extract-record';
const routingInputs = new Map(workloads.map(workload => [workload.id, workload.exampleInput]));
let manualPrompt: string | undefined;
let lastRoutingRefusal: RoutingRejection | undefined;
let plannedInputTokens = 1000;
let livePolicy: PolicySnapshot | undefined;
let policyUpdating = false;
let livePolicyError: string | undefined;
let reloadPending = false;
let reloadStatus: string | undefined;
let governanceProof: GovernanceProof | undefined;
let governanceError: string | undefined;
let governanceLoading = false;
let governanceGeneration = 0;
let safetyEvidence: PublicContentSafetyEvidence | undefined;
let safetyError: string | undefined;
let safetyLoading = false;
let safetyGeneration = 0;
let requestIsAutomatic = false;
function automaticJourney() { return isRoutingJourney(activeTab, architectureView); }
root.innerHTML = `
  <header><div class="project-title"><span class="project-mark" aria-label="AI architecture evaluation">AI</span><div><h1>AI Gateway demo</h1></div></div>
    <label class="gateway-selector">Gateway <select id="gateway-select" aria-label="Gateway" disabled><option>Loading…</option></select></label>
    <span class="preview"><strong id="gateway-title">APIM Premium v2</strong><span id="gateway-lifecycle">Loading profile configuration…</span><span id="gateway-association">Foundry association unverified</span></span></header>
  <div class="capability-tabs" role="tablist" aria-label="AI Gateway capabilities">
    <button type="button" role="tab" id="tab-architecture" aria-selected="true" aria-controls="capability-panel" tabindex="0" data-tab="architecture">Architecture</button>
    ${demoTabs.map(item => `<button type="button" role="tab" id="tab-${item.id}" aria-selected="false" aria-controls="capability-panel" tabindex="-1" data-tab="${item.id}">${item.label}</button>`).join('')}
  </div>
  <div class="workspace">
    <main>
      <div id="capability-panel" role="tabpanel" aria-labelledby="tab-architecture" tabindex="0">
      <div class="diagram-heading"><h2 id="evaluation-question"></h2><span id="view-scope"></span></div>
      <div id="architecture-subtabs" class="architecture-subtabs" role="tablist" aria-label="Architecture views">
        <button type="button" role="tab" id="architecture-tab-live" data-architecture="live" aria-selected="true" aria-controls="architecture-live" tabindex="0">Live PoC</button>
        <button type="button" role="tab" id="architecture-tab-reference" data-architecture="reference" aria-selected="false" aria-controls="architecture-reference" tabindex="-1">Organization reference</button>
      </div>
      <section id="gateway-value" class="gateway-value" aria-label="AI Gateway responsibility and demo scope" hidden>
        <p><strong>AI Gateway</strong> <span id="gateway-role"></span></p>
        <p class="demo-boundary"><strong>This demo</strong> <span id="demo-scope"></span></p>
      </section>
      <div id="architecture-workbench" class="architecture-workbench">
      <section id="architecture-live" role="tabpanel" aria-labelledby="architecture-tab-live">
      <div id="architecture-visual">
      <div class="diagram">
        <svg viewBox="0 0 1000 358" role="group" aria-label="Interactive conceptual enterprise AI architecture; groups are not deployment boundaries">
          <defs>
            <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z"/></marker>
            <symbol id="app-icon" viewBox="0 0 32 32"><rect x="3" y="4" width="26" height="22" rx="2"/><path d="M3 11H29M11 30H21M16 26V30M8 8H9M12 8H13M12 15L8 18L12 21M20 15L24 18L20 21"/></symbol>
            <symbol id="identity-icon" viewBox="0 0 32 32"><path d="M16 2L28 7V15C28 23 22 28 16 30C10 28 4 23 4 15V7Z"/><circle cx="16" cy="13" r="4"/><path d="M9 23C9 16 23 16 23 23"/></symbol>
            <symbol id="cloud-icon" viewBox="0 0 32 32"><path d="M8 26H25C33 26 32 14 25 14C25 3 8 3 8 15C0 14 0 26 8 26Z"/></symbol>
            <symbol id="tool-icon" viewBox="0 0 32 32"><path d="M4 8L16 3L28 8L16 13ZM4 8V23L16 29L28 23V8M16 13V29M4 16L16 22L28 16"/></symbol>
          </defs>
          <g class="architecture-groups" aria-hidden="true">
            <rect x="12" y="4" width="248" height="262" class="caller-group"/>
            <rect x="300" y="4" width="326" height="262" class="gateway-group"/>
            <rect x="666" y="4" width="322" height="262"/>
            <rect x="12" y="298" width="976" height="56" class="support-group"/>
            <rect x="12" y="4" width="248" height="24" class="group-title-band"/>
            <rect x="300" y="4" width="326" height="24" class="group-title-band"/>
            <rect x="666" y="4" width="322" height="24" class="group-title-band"/>
            <path d="M12 5H260M300 5H626M666 5H988" class="group-accent"/>
            <text x="28" y="21" class="group-label">Applications choose</text>
            <text x="316" y="21" class="group-label">Gateway governs</text>
            <text x="682" y="21" class="group-label">Providers execute</text>
            <text x="28" y="288" class="support-label">Supporting services · inspect evidence</text>
          </g>
          <g class="edge app-connection" data-detail="apps" id="edge-apps" role="button" tabindex="0" aria-label="Application to gateway connection"><path class="hit" d="M256 167H348"/><path class="line" d="M256 167H348"/></g>
          <g class="edge planned" data-detail="azure" id="edge-azure" role="button" tabindex="0" aria-label="Gateway to Azure Foundry model connection"><path class="hit" d="M580 153H612V56H700"/><path class="line" d="M580 153H612V56H700"/></g>
          <g class="edge planned" data-detail="databricks" id="edge-databricks" role="button" tabindex="0" aria-label="Gateway to Azure-hosted Databricks model connection"><path class="hit" d="M580 161H628V114H700"/><path class="line" d="M580 161H628V114H700"/></g>
          <g class="edge planned" data-detail="aws" id="edge-aws" role="button" tabindex="0" aria-label="Gateway to AWS model connection"><path class="hit" d="M580 169H644V172H700"/><path class="line" d="M580 169H644V172H700"/></g>
          <g class="edge planned" data-detail="gcp" id="edge-gcp" role="button" tabindex="0" aria-label="Gateway to GCP model connection"><path class="hit" d="M580 177H660V230H700"/><path class="line" d="M580 177H660V230H700"/></g>
          <g class="edge support" data-detail="identity" role="button" tabindex="0" aria-label="Identity and credentials connection"><path class="hit" d="M464 98V122"/><path class="line" d="M464 98V122"/></g>
          <g class="edge support" data-detail="telemetry" role="button" tabindex="0" aria-label="Gateway telemetry connection"><path class="hit" d="M410 212V268H178V302"/><path class="line" d="M410 212V268H178V302"/></g>
          <g class="edge support" data-detail="cost" role="button" tabindex="0" aria-label="Usage reporting connection"><path class="hit" d="M464 212V302"/><path class="line" d="M464 212V302"/></g>
          <g class="edge support" data-detail="tools" role="button" tabindex="0" aria-label="Synthetic enterprise tools connection"><path class="hit" d="M518 212V286H826V302"/><path class="line" d="M518 212V286H826V302"/></g>
          <g class="node" data-detail="apps" role="button" tabindex="0" aria-label="Applications and agents">
            <rect x="34" y="122" width="222" height="90"/><use href="#app-icon" x="47" y="140" width="30" height="30" class="concept-icon"/>
            <text x="87" y="149" class="label">Applications / agents</text><text x="87" y="171">Azure / AWS workloads</text><text x="47" y="196" class="badge">Local caller / Node router</text>
          </g>
          <g class="node gateway" id="node-gateway" data-detail="gateway" role="button" tabindex="0" aria-label="APIM Premium v2">
            <rect x="348" y="122" width="232" height="90"/><image href="/icons/ai-gateway.svg" x="362" y="136" width="34" height="34"/>
            <text x="406" y="149" class="label" id="gateway-node-title">APIM Premium v2</text><text x="406" y="171">Keys · policies · dispatch</text><text x="362" y="196" id="gateway-badge" class="badge">Not configured</text>
          </g>
          <g class="node" data-detail="identity" role="button" tabindex="0" aria-label="Identity and credentials">
            <rect x="330" y="40" width="268" height="58"/><use href="#identity-icon" x="344" y="52" width="27" height="27" class="concept-icon"/>
            <text x="384" y="64" class="label">Identity & credentials</text><text x="384" y="86">Entra management · runtime keys</text>
          </g>
          <g class="node provider azure" data-detail="azure" role="button" tabindex="0" aria-label="Azure model providers">
            <rect x="700" y="34" width="272" height="44"/><image href="/icons/azure-openai.svg" x="714" y="44" width="24" height="24"/>
            <text x="748" y="51" class="label">Azure · Foundry</text><text x="748" y="68" id="azure-badge" class="badge">Not configured</text>
          </g>
          <g class="node provider databricks" id="node-databricks" data-detail="databricks" role="button" tabindex="0" aria-label="Databricks model provider on Azure">
            <rect x="700" y="92" width="272" height="44"/><use href="#cloud-icon" x="714" y="102" width="24" height="24" class="concept-icon"/>
            <text x="748" y="109" class="label">Azure · Databricks</text><text x="748" y="126" id="databricks-badge" class="badge">Not configured</text>
          </g>
          <g class="node provider aws" data-detail="aws" role="button" tabindex="0" aria-label="AWS model providers">
            <rect x="700" y="150" width="272" height="44"/><use href="#cloud-icon" x="714" y="160" width="24" height="24" class="concept-icon"/>
            <text x="748" y="167" class="label">AWS · Bedrock</text><text x="748" y="184" id="aws-badge" class="badge">Not configured</text>
          </g>
          <g class="node provider gcp" data-detail="gcp" role="button" tabindex="0" aria-label="GCP model providers">
            <rect x="700" y="208" width="272" height="44"/><use href="#cloud-icon" x="714" y="218" width="24" height="24" class="concept-icon"/>
            <text x="748" y="225" class="label">GCP · Vertex / Gemini</text><text x="748" y="242" id="gcp-badge" class="badge">Not configured</text>
          </g>
          <g class="node supporting" data-detail="telemetry" role="button" tabindex="0" aria-label="Observability supporting service">
            <rect x="28" y="302" width="286" height="48"/><image href="/icons/azure-monitor.svg" x="38" y="312" width="27" height="27"/>
            <text x="75" y="322" class="label">Observability</text><text x="75" y="340" id="telemetry-badge">Checking native monitoring</text>
          </g>
          <g class="node supporting" data-detail="cost" role="button" tabindex="0" aria-label="Usage and cost supporting service">
            <rect x="342" y="302" width="282" height="48"/><image href="/icons/cost-management.svg" x="352" y="312" width="27" height="27"/>
            <text x="389" y="322" class="label">Usage / cost reporting</text><text x="389" y="340">Cost Management · not connected</text>
          </g>
          <g class="node supporting" data-detail="tools" role="button" tabindex="0" aria-label="Synthetic tools and enterprise data">
            <rect x="652" y="302" width="320" height="48"/><use href="#tool-icon" x="662" y="312" width="27" height="27" class="concept-icon"/>
            <text x="699" y="322" class="label">Read-only synthetic tools</text><text x="699" y="340">Enterprise data · not integrated</text>
          </g>
        </svg>
      </div>
      <p class="legend"><span class="key live"></span> Observed response <span class="key configured"></span> Configured connection <span class="key dashed"></span> Unverified connection
        <span class="key rejected"></span> Error / rejection response</p>
      </div>
      <p id="path-status" class="path-status" role="status">No request sent. Nodes are not integration claims.</p>
      <section id="architecture-intro" class="architecture-intro">
        <p id="architecture-coverage">Custom PoC selects below; gateway authenticates and dispatches.</p>
        <button type="button" id="explore-selector">Focus request</button>
        <button type="button" id="explore-models">Models & API · manual</button>
      </section>
      </section>
      <section id="architecture-request" class="architecture-request" aria-label="Run a workload">
        <h3>Run a workload</h3>
        <p class="request-owner">Custom PoC selection · real gateway call</p>
        <p id="architecture-expected" class="architecture-expected" role="status">Loading eligibility…</p>
      </section>
      </div>
      <section id="architecture-outcome" class="architecture-outcome" aria-label="Current request outcome" hidden></section>
      <section id="architecture-reference" role="tabpanel" aria-labelledby="architecture-tab-reference" hidden>${organizationReferenceMarkup}</section>
      <details id="observed-path" class="observed-path" aria-label="Observed request path" hidden>
        <summary>Request path · client evidence, not a gateway trace</summary>
        <ol id="path-steps"></ol>
      </details>
      <section id="capability-story" class="capability-story" aria-label="Capability evaluation" hidden>
        <section id="monitoring-experience" class="monitoring-experience" aria-label="Gateway telemetry, local audit and measured model behavior" hidden></section>
        <section id="multi-cloud-experience" class="multi-cloud-experience" aria-label="Model access experience" hidden></section>
        <section id="routing-experience" class="routing-experience" aria-label="Working cost-aware routing" hidden></section>
        <section id="readiness-experience" class="readiness-experience" hidden></section>
        <section id="routing-options" class="routing-options" aria-label="Cost routing request settings" hidden>
          <label>Workload<select id="workload" form="request-form">${workloads.map(workload => `<option value="${workload.id}">${workload.label}</option>`).join('')}</select></label>
          <label>Routing policy · custom PoC<select id="routing-policy" disabled><option value="">Loading server policy…</option></select></label>
          <p id="routing-policy-status" role="status">Server-wide policy; independent of gateway profile.</p>
          <p id="workload-requirement">${getWorkload(workloadId).requirement}</p>
          <details id="routing-settings"><summary>Request settings</summary><div class="routing-settings-fields">
            <label>Planned input tokens<input id="planned-input" type="number" form="request-form" min="1" max="128000" step="1" value="1000" required></label>
            <label>Evaluated output cap<input id="output-cap" type="number" value="256" readonly aria-describedby="routing-status"></label>
          </div></details>
        </section>
        <details id="evaluation-notes" class="scenario"><summary>How to evaluate this capability</summary><p id="capability-experience"></p><div id="scenario-design"><div class="scenario-heading"><h3>Design example</h3><span>Illustrative · not executed</span></div><pre id="scenario-example"></pre></div><h3>Verification steps</h3><p id="scenario-test"></p></details>
      </section>
      <details id="live-test" class="live-test" hidden><summary><span id="live-test-title">Try a model call</span> <span id="live-test-scope"></span></summary>
      <section id="panel-request" class="capability-panel">
        <div id="control-instructions" class="control-instructions" hidden>
          <p id="control-test-boundary" class="test-boundary"></p>
          <details class="control-presets"><summary>Control-test prerequisites</summary><div class="prompt-examples"><button type="button" id="normal-prompt">Use normal prompt</button><button type="button" id="block-prompt" disabled>Use fixed safety proof buttons</button></div><p id="control-prerequisites">Different A/B keys do not prove caller isolation. Native safety tests require matching profile and verified asset evidence in Gateway controls. Never infer policy provenance from an error alone.</p></details>
        </div>
        <div class="request-result">
          <div class="request-input">
            <form id="request-form">
              <label class="application-label"><span>Application</span><select id="application"><option value="A">App A</option><option value="B">App B</option></select></label>
              <label class="model-label"><span>Model</span><select id="model" title="Neutral display labels. The exact published model name is available in raw request details."><option value="">No models configured</option></select></label>
              <div id="automatic-model" class="automatic-model" hidden>Custom PoC: declaration → approval + business policy → cost. Gateway: authentication, dispatch and separately verified controls.</div>
              <label class="prompt-label"><span>Prompt</span><textarea id="prompt" rows="2" maxlength="8000" required>Summarize this synthetic note: DEMO-01 maintenance is scheduled for Saturday.</textarea></label>
              <button id="send" type="submit" disabled>Send</button>
            </form>
            <p id="setup" class="setup" role="status">Loading server configuration…</p>
            <div id="model-instructions" class="test-instructions">
              <details class="prompt-presets"><summary>Synthetic prompt examples</summary><div class="prompt-examples" aria-label="Synthetic prompt presets"><button type="button" data-preset="maintenance">Maintenance summary</button><button type="button" data-preset="handover">Shift handover</button><button type="button" data-preset="classification">Work-order classification</button><span>Fill only · never sends</span></div><p id="provider-coverage">Loading configured provider coverage…</p></details>
            </div>
          </div>
          <div class="observed-result"><h3 id="result-heading">Response</h3><p id="result-empty">Send a request to see the response.</p><section id="result" class="result" aria-live="polite" hidden></section></div>
        </div>
        <p id="request-conclusion" class="conclusion" hidden><span class="evidence-label">Evaluation gap</span> No request observed in this session; cross-provider access is not demonstrated.</p>
      </section>
      <details id="panel-signals" class="capability-panel signals-panel" aria-label="Client-visible signals" hidden>
        <summary>Client response fields · separate from native telemetry</summary>
        <div><h3>Observed result</h3><div id="signals-content" aria-live="polite"><p>No response observed yet. Expand the live model test and send a request.</p></div></div>
        <div><h3>Signal boundaries</h3><p>Returned tokens, headers and local timing are client observations. Use the separately loaded Azure Monitor snapshot to verify native gateway token metrics. Neither source proves policy spans or end-to-end agent/tool traces. Enterprise tools remain unconnected.</p></div>
      </details>
      </details>
      </div>
    </main>
    <aside id="detail" aria-label="Capability and component evidence"></aside>
  </div>
  <footer><span>Synthetic data · Real calls incur charges · Client paths are not gateway traces</span><a href="https://learn.microsoft.com/en-us/azure/architecture/icons/" target="_blank" rel="noreferrer">Azure icons © Microsoft ↗</a></footer>
`;

document.querySelector('#request-form')!.prepend(document.querySelector('#routing-options')!);
document.querySelector('.observed-result')!.prepend(document.querySelector('#routing-experience')!);
const routingMap = document.createElement('section');
routingMap.id = 'routing-rule-map';
routingMap.hidden = true;
document.querySelector('#capability-panel')!.insertBefore(routingMap, document.querySelector('#live-test'));
const detail = document.querySelector<HTMLElement>('#detail')!;
detail.hidden = true;
detail.tabIndex = -1;
const liveTest = document.querySelector<HTMLDetailsElement>('#live-test')!;
const observedResult = document.querySelector<HTMLElement>('.observed-result')!;
const liveTestHome = document.createComment('Shared request form position');
const observedResultHome = document.createComment('Shared result position');
liveTest.before(liveTestHome);
observedResult.before(observedResultHome);
function layoutArchitecture(live: boolean) {
  const workbench = document.querySelector<HTMLElement>('#architecture-workbench')!;
  const outcome = document.querySelector<HTMLElement>('#architecture-outcome')!;
  workbench.hidden = !live;
  outcome.hidden = !live;
  if (live) {
    document.querySelector('#architecture-request')!.append(liveTest);
    outcome.append(observedResult);
  } else {
    liveTestHome.after(liveTest);
    observedResultHome.after(observedResult);
  }
}
function closeInspector(restoreFocus = true) {
  inspectorOpen = false;
  detail.hidden = activeTab === 'architecture';
  document.querySelectorAll('.node.selected, [data-reference][aria-pressed="true"]').forEach(node => {
    node.classList.remove('selected');
    node.setAttribute('aria-pressed', 'false');
  });
  if (restoreFocus && (inspectorTrigger instanceof HTMLElement || inspectorTrigger instanceof SVGElement)) inspectorTrigger.focus();
}
function presentInspector(open: boolean) {
  if (activeTab !== 'architecture') { detail.hidden = false; detail.removeAttribute('role'); detail.removeAttribute('aria-modal'); detail.removeAttribute('aria-label'); return; }
  if (open) {
    inspectorTrigger = document.activeElement;
    inspectorOpen = true;
  }
  detail.hidden = !inspectorOpen;
  detail.setAttribute('role', 'dialog');
  detail.setAttribute('aria-modal', 'false');
  detail.setAttribute('aria-label', detail.querySelector('h2')?.textContent || 'Component details');
  const close = document.createElement('button');
  close.id = 'close-detail';
  close.className = 'inspector-close';
  close.type = 'button';
  close.textContent = 'Close';
  close.setAttribute('aria-label', 'Close component details');
  close.addEventListener('click', () => closeInspector());
  detail.prepend(close);
  if (open) close.focus();
}
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && inspectorOpen && activeTab === 'architecture') closeInspector();
});
const capabilityDetails = document.createElement('details');
capabilityDetails.id = 'capability-details';
capabilityDetails.hidden = true;
const capabilityDetailsSummary = document.createElement('summary');
capabilityDetailsSummary.textContent = 'What this demo proves & what remains';
capabilityDetails.append(capabilityDetailsSummary);
document.querySelector('#capability-panel')!.append(capabilityDetails);
let selectedDetail: DetailId = 'gateway';
function paragraph(label: string, text: string): HTMLElement {
  const section = document.createElement('div');
  const heading = document.createElement('h3');
  heading.textContent = label;
  const p = document.createElement('p');
  p.textContent = text;
  section.append(heading, p);
  return section;
}
function showDetail(id: DetailId, open = true) {
  inspectorMode = 'component';
  selectedDetail = id;
  for (const node of document.querySelectorAll<SVGElement>('.node[data-detail]')) {
    const selected = node.dataset.detail === id && (activeTab !== 'architecture' || open || inspectorOpen);
    node.classList.toggle('selected', selected);
    node.setAttribute('aria-pressed', String(selected));
  }
  const item = details[id];
  detail.replaceChildren();
  const title = document.createElement('h2');
  title.textContent = item.title;
  if (id === 'gateway') title.textContent = config?.label || 'Gateway';
  const proofText = sessionProof(id);
  const proof = paragraph('This demo', proofText);
  proof.className = 'proof-card';
  proof.dataset.state = proofText.startsWith('Response observed') ? 'observed' : 'gap';
  detail.append(title, paragraph('Role', item.responsibility), proof);
  if (id === 'gateway') detail.append(paragraph('Selected profile', `${config?.label || selectedGateway} · ${config?.lifecycle || 'Configuration unavailable'}. Foundry attachment ${config?.foundryAssociated ? 'verified by server configuration' : 'unverified'}; model execution is separate evidence.`));
  if (id === 'telemetry') appendMonitoringEvidence(detail);
  const context = document.createElement('details');
  context.className = 'component-context';
  const contextSummary = document.createElement('summary');
  contextSummary.textContent = 'Requirement & dependencies';
  context.append(contextSummary, paragraph('Enterprise requirement', item.requirement),
    paragraph('What this PoC proves / scope', selectedGateway === 'apim-v2' && id === 'identity'
      ? 'A/B use distinct API-scoped APIM subscription keys, not standalone gateway-scoped keys. Caller identity policies, limits and isolation require separate APIM-specific verification.'
      : item.proof),
    paragraph('Limitation / dependency', id === 'gateway' && selectedGateway === 'apim-v2'
      ? 'Premium v2 infrastructure is GA; Foundry integration is preview. Verified account GatewayAssociation with the project enabled is configuration evidence only. Hosted-agent proxy APIs/products and token-management setup are not verified; no agent/tool interception is claimed. Policies, telemetry and approvals require profile-specific evidence.'
      : selectedGateway === 'apim-v2' && id === 'identity'
        ? 'Distinct subscription keys do not prove independent policy counters or authorization boundaries. No policy capability or scope is inferred from standalone.'
        : selectedGateway === 'apim-v2' && id === 'databricks'
          ? apimDatabricksAuth
          : item.limitation));
  detail.append(context);
  const source = document.createElement('a');
  source.href = selectedGateway === 'apim-v2' ? gatewayPolicyDocumentation(selectedGateway) : item.source;
  source.target = '_blank';
  source.rel = 'noreferrer';
  source.textContent = selectedGateway === 'apim-v2' ? 'APIM policy documentation ↗' : 'Standalone new-tier documentation ↗';
  detail.append(source);
  const relatedDetails = document.createElement('details');
  const relatedSummary = document.createElement('summary');
  relatedSummary.textContent = 'Related enterprise requirements';
  relatedDetails.append(relatedSummary);
  if (id === 'tools') detail.append(paragraph('Synthetic example only — not a tool call', 'Site DEMO-01 · maintenance window: Saturday · status: scheduled. No enterprise data access.'));
  const related = requirements.filter(requirement => requirement.nodes.includes(id));
  for (const requirement of related) {
    const accordion = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = requirement.title;
    accordion.append(summary,
      paragraph('PoC evidence', capabilityProof(requirement.id).text),
      paragraph('Proof scope', requirement.demonstrated),
      paragraph('Documented only', requirement.documented),
      paragraph('External dependency', requirement.external),
      paragraph('Evaluation gap', requirement.gap));
    relatedDetails.append(accordion);
  }
  detail.append(relatedDetails);
  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'inspector-back';
  const relatedCapability = related.find(capability => capability.id === lastCapability) || related[0];
  if (relatedCapability) {
    back.textContent = `${relatedCapability.id === lastCapability ? 'Back to' : 'Explore'} ${demoTabFor(relatedCapability.id).label}`;
    back.addEventListener('click', () => selectTab(relatedCapability.id));
    detail.append(back);
  }
  presentInspector(open);
}
function sessionProof(id: DetailId): string {
  if (id === 'tools') return 'Not connected. Synthetic example only.';
  if (id === 'identity') return 'Caller isolation and per-model authorization are not demonstrated.';
  if (id === 'cost') return lastResult?.source === 'gateway-response' && lastResult.tokens
    ? 'Returned token usage is available. Billing and budget controls are not demonstrated.'
    : 'Run a model call to see token usage.';
  if (id === 'telemetry') return monitoringProof();
  if ((id === 'gateway' || id === 'apps') && lastResult?.source === 'gateway-response' && !hasModelResponse(lastResult)) {
    return lastResult.outcome?.enforcementBoundary === 'native-gateway-policy'
      ? 'Current request: verified native gateway rejection. No model execution claimed.'
      : 'Gateway endpoint response observed; enforcement origin remains unknown. No successful model response claimed.';
  }
  const observed = id === 'gateway' || id === 'apps' ? successes.size > 0 : observedNodes.has(id);
  return observed
    ? 'Response observed this session. The path is inferred, not a gateway trace.'
    : automaticJourney() ? 'Not called this session. Run the selector below for workload routing; Models & API is the separate manual test.'
      : 'Not called in this session. Use Models & API for an explicit manual model test.';
}
function getCapability(id: CapabilityId): Capability {
  const capability = requirements.find(item => item.id === id);
  if (!capability) throw new Error(`Unknown capability: ${id}`);
  return capability;
}
function capabilityProof(id: CapabilityId): { observed: boolean; text: string } {
  if (id === 'observability') return { observed: Boolean(monitoringEvidence?.metrics), text: monitoringProof() };
  if (id === 'safety') return {
    observed: Boolean(safetyEvidence?.coverage.some(asset => safetyAssetVerified(safetyEvidence!, asset.assetName))),
    text: lastResult?.outcome?.nativeControl === 'content-safety'
      ? `Current correlated request: HTTP ${lastResult.status} matches the verified native Content Safety signature and asset. Gateway safety stop; no model execution claimed.`
      : safetyError || safetySummary(safetyEvidence, selectedGateway)
  };
  if (pending) return { observed: false, text: 'Request in progress. Gateway receipt and model execution are not yet verified.' };
  if (id === 'reliability') {
    if (lastResult?.outcome?.enforcementBoundary === 'native-gateway-policy') return {
      observed: true, text: `Current actual request: HTTP ${lastResult.status} attributed to a verified native gateway policy. ${lastResult.outcome.nativeControl === 'content-safety' ? 'Content Safety, not caller isolation.' : governanceProof?.kind === 'model-allowlist' ? 'Model-allowlist enforcement, not caller isolation.' : 'See the current outcome and the separate saved A/B verification.'} No automatic retry or failover.`
    };
    if (governanceProof) return {
      observed: governanceVerified(governanceProof),
      text: `${governanceCopy(governanceProof).saved} Saved at ${new Date(governanceProof.capturedAt).toLocaleString()}; not a current request or resilience proof.`
    };
  }
  if (id === 'routing' && lastRoutingRefusal) return {
    observed: true, text: `Local router refused ${getWorkload(lastRoutingRefusal.workload).label}: no approved candidate. Its decision record confirms no gateway call was made. This is application approval logic, not gateway enforcement.`
  };
  if (lastRequestFailed || lastResult?.source === 'local-error') {
    return { observed: false, text: 'Latest local request failed. No gateway or model execution is claimed; this capability is not proved.' };
  }
  const gatewayResult = lastResult?.source === 'gateway-response' ? lastResult : undefined;
  const hasSuccess = successes.size > 0;
  const coverage = modelCoverage(config?.models || [], successes);
  switch (id) {
    case 'multi-cloud':
      return { observed: hasSuccess, text: hasSuccess
        ? `${coverage.models} model(s), ${coverage.providers} provider(s), ${coverage.clouds} cloud(s) responded this session. ${coverage.clouds < 2 ? 'Multi-cloud execution is not proved. ' : ''}Backend paths are inferred from configuration, not gateway traces.`
        : 'Send a request to verify a configured alias. Databricks is another Azure-hosted provider when configured; configuration and historical direct evidence are not gateway proof.' };
    case 'routing':
      return { observed: Boolean(gatewayResult?.routing && hasModelResponse(gatewayResult)), text: gatewayResult?.routing
        ? `Local routing chose ${gatewayResult.routing.selectedPrice.label} for ${getWorkload(gatewayResult.routing.workload).label}, using measured eligibility then cost. ${hasModelResponse(gatewayResult) ? 'The chosen model responded.' : `HTTP ${gatewayResult.status}; no response success claimed.`} The decision is local code, not a gateway span.`
        : 'Our selector chooses the model; the gateway dispatches its published name. No routed response observed this session.' };
    case 'reliability':
      return { observed: false, text: gatewayResult && gatewayResult.status >= 400
        ? `HTTP ${gatewayResult.status} observed. Policy vs backend provenance is unknown; caller isolation, retry, balancing and failover remain unproved.`
        : `${selectedGateway === 'apim-v2' ? 'APIM policy configuration and enforcement require profile-specific evidence.' : 'Legacy-model limits are configured, but enforcement and A/B isolation are unverified.'} No automatic retry or failover.` };
    case 'finops':
      return { observed: Boolean(gatewayResult?.tokens), text: gatewayResult?.tokens
        ? 'Returned token usage observed. Usage-based cost estimates are custom; dollar budgets, billing and showback are not demonstrated.'
        : 'Token monitoring requires this profile’s validated snapshot. No financial controls or current response-cost estimate observed.' };
    case 'performance':
      return { observed: Boolean(gatewayResult), text: gatewayResult
        ? `${gatewayResult.latencyMs} ms client round trip observed, not gateway processing time. No cache, streaming or throughput benchmark.`
        : 'Send a request for client round-trip timing. No cache, streaming or throughput benchmark is demonstrated.' };
    case 'developer-experience':
      return { observed: hasSuccess, text: hasSuccess
        ? 'A real model call used the gateway endpoint and server-side key. SDK and MCP compatibility are not tested.'
        : 'Server-side keys and an HTTP request form are ready. Send a request to verify access; SDKs and MCP remain untested.' };
  }
}
function showCapability(capability: Capability) {
  inspectorMode = 'capability';
  document.querySelectorAll('.node.selected').forEach(node => {
    node.classList.remove('selected');
    node.setAttribute('aria-pressed', 'false');
  });
  detail.replaceChildren();
  const eyebrow = document.createElement('p');
  eyebrow.className = 'eyebrow';
  eyebrow.textContent = `Capability evidence · ${config?.label || selectedGateway}`;
  const title = document.createElement('h2');
  title.textContent = capability.title;
  const evidence = capabilityProof(capability.id);
  const proof = paragraph('Demo evidence', evidence.text);
  proof.className = 'proof-card capability-proof';
  proof.dataset.state = evidence.observed ? 'observed' : 'gap';
  const scope = document.createElement('p');
  scope.className = 'evidence-scope';
  scope.textContent = evidence.observed ? 'Observed scope only' : 'Not demonstrated';
  proof.querySelector('h3')!.after(scope);
  const proofScope = document.createElement('details');
  const proofSummary = document.createElement('summary');
  proofSummary.textContent = 'Proof scope';
  const proofText = document.createElement('p');
  proofText.textContent = capability.demonstrated;
  proofScope.append(proofSummary, proofText);
  proof.append(proofScope);
  detail.append(eyebrow, title, proof);
  if (capability.id === 'observability') appendMonitoringEvidence(detail);
  const boundaries = document.createElement('details');
  const boundariesSummary = document.createElement('summary');
  boundariesSummary.textContent = 'Capabilities & dependencies';
  boundaries.append(boundariesSummary,
    paragraph('Documented, not fully demonstrated', capability.documented),
    paragraph('Another component / custom implementation', capability.external),
    paragraph('Unconfirmed / current gap', capability.gap));
  detail.append(boundaries);
  if (capability.id === 'reliability' || capability.id === 'safety') {
    const portal = document.createElement('a');
    portal.href = gatewayPortal(selectedGateway);
    portal.target = '_blank'; portal.rel = 'noreferrer';
    portal.textContent = 'Open gateway Policies ↗';
    detail.append(portal);
  }
  const source = document.createElement('a');
  source.href = selectedGateway === 'apim-v2' ? gatewayPolicyDocumentation(selectedGateway)
    : capability.id === 'multi-cloud' || capability.id === 'routing' || capability.id === 'developer-experience' ? docs.assets : docs.governance;
  source.target = '_blank';
  source.rel = 'noreferrer';
  source.textContent = selectedGateway === 'apim-v2' ? 'APIM policy documentation ↗' : 'Standalone new-tier documentation ↗';
  const locate = document.createElement('button');
  locate.type = 'button';
  locate.className = 'inspector-back';
  locate.textContent = 'Locate in Architecture';
  locate.addEventListener('click', () => {
    architectureView = 'live';
    selectTab('architecture');
    showDetail(capability.nodes[0]);
  });
  detail.append(source, locate);
  for (const id of demoTabFor(capability.id).capabilities) {
    if (id === capability.id) continue;
    const related = getCapability(id);
    const section = document.createElement('details');
    section.dataset.capability = id;
    const summary = document.createElement('summary');
    summary.textContent = related.label;
    const proof = capabilityProof(id);
    section.append(summary,
      paragraph('Demo evidence', proof.text),
      paragraph('Proof scope', related.demonstrated),
      paragraph('Documented, not fully demonstrated', related.documented),
      paragraph('Another component / custom implementation', related.external),
      paragraph('Unconfirmed / current gap', related.gap),
      paragraph('How to evaluate', related.test));
    detail.append(section);
  }
}
function refreshInspector() {
  if (activeTab === 'architecture' && architectureView === 'reference') showReference(selectedReference, false);
  else if (activeTab === 'architecture' || inspectorMode === 'component') showDetail(selectedDetail, false);
  else showCapability(getCapability(activeTab));
}
function monitoringProof(): string {
  if (monitoringEvidence?.metrics) {
    return `Saved native token metrics · ${new Date(monitoringEvidence.metrics.queriedAt).toLocaleString()}. Not a per-request trace.`;
  }
  if (monitoringEvidence) return 'Native export configured. Token ingestion is not yet verified.';
  return monitoringError ? `Evaluation gap — ${monitoringError}` : 'Checking saved native gateway monitoring evidence.';
}
function appendMonitoringEvidence(container: HTMLElement) {
  if (!monitoringEvidence) return;
  const portal = document.createElement('a');
  portal.href = gatewayPortal(selectedGateway);
  portal.target = '_blank';
  portal.rel = 'noreferrer';
  portal.textContent = 'Open native token dashboard ↗';
  const insights = document.createElement('a');
  insights.href = `https://portal.azure.com/#resource${monitoringEvidence.insightsResourceId}/overview`;
  insights.target = '_blank';
  insights.rel = 'noreferrer';
  insights.textContent = 'Open Application Insights ↗';
  const snapshot = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = 'Native metric snapshot · not browser timing';
  const raw = document.createElement('pre');
  raw.textContent = JSON.stringify(monitoringEvidence, null, 2);
  snapshot.append(summary, paragraph('Scope', 'Actual Azure Monitor token series. Values are cumulative metric samples, not this browser request, a bill or an audit trail. Zero token subcategories are preserved; missing data is not fabricated.'), raw);
  container.append(portal, insights, snapshot);
}
function renderMonitoringSummary() {
  const target = document.querySelector<HTMLElement>('#monitoring-experience')!;
  target.hidden = activeTab !== 'observability';
  renderMonitoring(target, {
    gatewayId: selectedGateway, models: config?.models || [], native: monitoringEvidence, nativeError: monitoringError,
    audit: monitoringAudit, auditError: monitoringAuditError, evaluations: monitoringEvaluations,
    evaluationError: monitoringEvaluationError, loading: monitoringContextLoading || reloadPending, latest: lastResult,
    refreshError: reloadStatus?.startsWith('Evidence reload failed:') ? reloadStatus : undefined
  }, () => {
    if (pending || reloadPending || policyUpdating) return;
    monitoringContextLoading = true;
    renderMonitoringSummary();
    void reloadEvidence().then(() => loadMonitoringContext());
  }, gatewayPortal(selectedGateway), {
    standalone: () => {
      if (pending || reloadPending || policyUpdating) return;
      const selector = document.querySelector<HTMLSelectElement>('#gateway-select')!;
      selector.value = 'ai-gateway';
      selector.dispatchEvent(new Event('change', { bubbles: true }));
    },
    runWorkload: () => { selectTab('architecture'); prompt.focus(); }
  });
}
async function loadMonitoringContext() {
  const generation = ++monitoringContextGeneration;
  const profile = profileGeneration;
  const gateway = selectedGateway;
  const current = () => generation === monitoringContextGeneration && profile === profileGeneration;
  monitoringContextLoading = true;
  monitoringAuditError = monitoringEvaluationError = undefined;
  renderMonitoringSummary();
  await Promise.all([
    (async () => {
      try {
        const response = await fetch(`/api/request-audit?gateway=${gateway}`);
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || `Local audit HTTP ${response.status}`);
        const audit = parseRequestAudit(body, gateway);
        if (current()) monitoringAudit = audit;
      } catch (error) {
        if (current()) {
          monitoringAudit = undefined;
          monitoringAuditError = error instanceof Error ? error.message : String(error);
        }
      }
    })(),
    (async () => {
      try {
        const snapshots = await Promise.all((['extract-record', 'reconcile-records'] as const).map(async workload => {
          const response = await fetch(`/api/routing?gateway=${gateway}&app=A&workload=${workload}`);
          const body = await response.json();
          if (!response.ok) throw new Error(body.error || `Evaluation evidence HTTP ${response.status}`);
          const snapshot = body as RoutingSnapshot;
          if (snapshot.gatewayId !== gateway || snapshot.workload?.id !== workload || !Array.isArray(snapshot.candidates)) {
            throw new Error('Model evaluation profile or workload mismatch.');
          }
          return snapshot;
        }));
        if (current()) monitoringEvaluations = snapshots;
      } catch (error) {
        if (current()) {
          monitoringEvaluations = [];
          monitoringEvaluationError = error instanceof Error ? error.message : String(error);
        }
      }
    })()
  ]);
  if (current()) {
    monitoringContextLoading = false;
    renderMonitoringSummary();
  }
}
function renderTabExperience() {
  const readiness = document.querySelector<HTMLElement>('#readiness-experience')!;
  readiness.hidden = activeTab !== 'reliability' && activeTab !== 'safety';
  if (!readiness.hidden) {
    if (activeTab === 'reliability' || activeTab === 'safety') {
      document.querySelector('#view-scope')!.textContent = pending ? 'Current native test'
        : governanceProof ? 'Saved native proof' : 'Proof unavailable';
      let governance = readiness.querySelector<HTMLElement>('#governance-controls');
      let safety = readiness.querySelector<HTMLElement>('#safety-controls');
      if (!governance || !safety) {
        governance = document.createElement('section'); governance.id = 'governance-controls';
        safety = document.createElement('section'); safety.id = 'safety-controls';
        const other = document.createElement('p');
        other.textContent = 'Other controls: caller-limit isolation unverified; IP restrictions not configured. Native policies are distinct from the custom selection/cost code.';
        readiness.replaceChildren(safety, governance, other);
      }
      renderGovernanceProof(governance, {
        proof: governanceProof, error: governanceError, loading: governanceLoading,
        busy: pending || reloadPending || policyUpdating,
        ready: Boolean(config?.gatewayConfigured && governanceCallersReady(governanceProof, config.applications)),
        gatewayId: selectedGateway
      }, (app, action) => {
        if (pending || !governanceProof) return;
        const gatewayId = selectedGateway;
        void executeRequest('/api/governance/request', { gatewayId, app, action },
          { application: app }, Object.freeze({ gatewayId, application: app, workload: 'governance-proof' }), false);
      });
      renderContentSafety(safety, {
        gatewayId: selectedGateway, evidence: safetyEvidence, error: safetyError, loading: safetyLoading,
        busy: pending || reloadPending || policyUpdating, models: config?.models || [],
        applications: config?.applications || [], app: appSelect.value as 'A' | 'B', modelId: modelSelect.value
      }, (app, modelId, action) => {
        if (pending) return;
        const gatewayId = selectedGateway;
        void executeRequest('/api/content-safety/request', { gatewayId, app, modelId, action },
          { application: app, model: config?.models.find(model => model.id === modelId) },
          Object.freeze({ gatewayId, application: app, workload: 'governance-proof' }), false);
      }, () => { void loadContentSafety(); });
      return;
    }
    readiness.replaceChildren();
    const message = document.createElement('p');
    message.textContent = safetySummary(safetyEvidence, selectedGateway);
    const portal = document.createElement('a');
    portal.className = 'primary-action';
    portal.href = gatewayPortal(selectedGateway);
    portal.target = '_blank'; portal.rel = 'noreferrer';
    portal.textContent = 'Inspect gateway policies';
    readiness.append(message, portal);
  } else readiness.replaceChildren();
}
function updateMonitoringPresentation() {
  const verified = activeTab === 'observability' && Boolean(monitoringEvidence?.metrics);
  document.querySelector('#scenario-design h3')!.textContent = verified ? 'Native metric schema' : 'Design example';
  document.querySelector('#scenario-design .scenario-heading span')!.textContent = verified
    ? 'Saved Azure Monitor snapshot · not this request' : 'Illustrative · not executed';
  document.querySelector('#capability-story')!.setAttribute('aria-label', verified
    ? 'Verified native token monitoring and remaining audit requirements' : 'Capability evaluation');
  if (verified) document.querySelector('#view-scope')!.textContent = 'Native + PoC evidence';
  if (activeTab === 'observability') document.querySelector('#demo-scope')!.textContent = monitoringEvidence?.metrics
    ? 'Native token snapshots + custom request evidence + fixed-suite model checks. Sources and timestamps stay separate; private model reasoning is not exposed.'
    : `${monitoringProof()} Local audit and evaluation evidence are independent.`;
}
async function loadMonitoring() {
  const generation = profileGeneration;
  const gateway = selectedGateway;
  try {
    const response = await fetch(`/api/gateway-monitoring?gateway=${gateway}`);
    if (generation !== profileGeneration) return;
    if (!response.ok) {
      const body = await response.json();
      throw new Error(body.error || `Native monitoring snapshot HTTP ${response.status}`);
    }
    const value = await response.json() as MonitoringEvidence & { gatewayId: GatewayId };
    if (generation !== profileGeneration) return;
    if (value.gatewayId !== gateway) throw new Error('Monitoring profile mismatch.');
    monitoringEvidence = value;
    document.querySelector('#telemetry-badge')!.textContent = monitoringEvidence.metrics
      ? 'Saved token metrics · verified' : 'Saved native export · configured';
  } catch (error) {
    if (generation !== profileGeneration) return;
    monitoringEvidence = undefined;
    monitoringError = error instanceof Error ? error.message : String(error);
    document.querySelector('#telemetry-badge')!.textContent = 'Monitoring evidence unavailable';
  }
  updateMonitoringPresentation();
  renderMonitoringSummary();
  refreshInspector();
}
function updateConclusion() {
  const conclusion = document.querySelector<HTMLElement>('#request-conclusion')!;
  if (activeTab === 'architecture') {
    conclusion.textContent = 'Declare a workload and run the custom selector below; observed paths are not gateway traces.';
    return;
  }
  const evidence = capabilityProof(activeTab);
  const badge = document.createElement('span');
  badge.className = 'evidence-label';
  badge.textContent = evidence.observed ? 'Observed evidence' : 'Evaluation gap';
  conclusion.replaceChildren(badge, document.createTextNode(` ${evidence.text}`));
}
function renderObservedPath() {
  const steps = observedRequestPath(requestObservation);
  const architecture = activeTab === 'architecture';
  const noRequest = activeTab !== 'architecture' && demoPresentation[activeTab].request === 'none';
  const unconfiguredSelection = activeTab === 'multi-cloud' && catalogSelection
    && !config?.models.some(model => model.id === catalogSelection);
  document.querySelector<HTMLElement>('#observed-path')!.hidden = architecture || noRequest || Boolean(unconfiguredSelection) || !steps.length;
  document.querySelector<HTMLElement>('#path-status')!.hidden = !architecture || architectureView === 'reference';
  const list = document.querySelector<HTMLOListElement>('#path-steps')!;
  list.replaceChildren();
  for (const step of steps) {
    const item = document.createElement('li');
    item.dataset.kind = step.kind;
    item.dataset.state = step.state;
    const label = document.createElement('strong');
    label.textContent = step.label;
    const description = document.createElement('span');
    description.textContent = step.detail;
    item.append(label, description);
    list.append(item);
  }
}
for (const element of document.querySelectorAll<SVGElement>('[data-detail]')) {
  const activate = () => {
    const id = element.dataset.detail;
    if (id && id in details) showDetail(id as DetailId);
  };
  element.addEventListener('click', activate);
  element.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(); }
  });
}
const tabs = [...document.querySelectorAll<HTMLButtonElement>('.capability-tabs [role="tab"]')];
const views: ViewId[] = ['architecture', ...demoTabs.map(item => item.id)];
const controlInstructions = document.querySelector<HTMLElement>('#control-instructions')!;
const architectureTabs = [...document.querySelectorAll<HTMLButtonElement>('#architecture-subtabs [role="tab"]')];
function showReference(id: ReferenceInstanceId, open = true) {
  selectedReference = id;
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-reference]')) {
    button.setAttribute('aria-pressed', String(button.dataset.reference === id && (open || inspectorOpen)));
  }
  renderReferenceDetail(detail, id);
  presentInspector(open);
}
function updateArchitectureView() {
  const architecture = activeTab === 'architecture';
  document.querySelector<HTMLElement>('#architecture-subtabs')!.hidden = !architecture;
  document.querySelector<HTMLElement>('#architecture-live')!.hidden = !architecture || architectureView !== 'live';
  document.querySelector<HTMLElement>('#architecture-reference')!.hidden = !architecture || architectureView !== 'reference';
  for (const tab of architectureTabs) {
    const selected = tab.dataset.architecture === architectureView;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  if (!architecture) return;
  document.querySelector('#evaluation-question')!.textContent = architectureView === 'reference'
    ? 'Central governance. Federated enforcement.' : 'Where AI Gateway fits';
  document.querySelector('#view-scope')!.textContent = architectureView === 'reference'
    ? 'Reference only · not deployed' : 'Run a workload · inspect actual outcome';
  renderObservedPath();
  refreshInspector();
}
for (const [index, tab] of architectureTabs.entries()) {
  const activate = (next: number) => {
    if (pending || reloadPending || policyUpdating) return;
    if (automaticJourney()) routingInputs.set(workloadId, prompt.value);
    architectureView = next === 0 ? 'live' : 'reference';
    selectTab('architecture');
  };
  tab.addEventListener('click', () => activate(index));
  tab.addEventListener('keydown', event => {
    let next: number;
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') next = (index + 1) % architectureTabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = architectureTabs.length - 1;
    else return;
    event.preventDefault();
    activate(next);
    architectureTabs[next].focus();
  });
}
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-reference]')) {
  button.addEventListener('click', () => {
    const id = button.dataset.reference;
    if (id && isReferenceInstance(id)) showReference(id);
  });
}
function selectTab(requested: ViewId) {
  if (pending || reloadPending || policyUpdating) return;
  const id: ViewId = requested === 'architecture' ? requested : demoTabFor(requested).id;
  const wasAutomatic = requestIsAutomatic;
  const automatic = isRoutingJourney(id, architectureView);
  requestIsAutomatic = automatic;
  if (wasAutomatic && !automatic) {
    document.querySelector<HTMLDetailsElement>('#live-test')!.open = false;
    routingInputs.set(workloadId, prompt.value);
    if (manualPrompt !== undefined) prompt.value = manualPrompt;
  } else if (!wasAutomatic && automatic) {
    manualPrompt = prompt.value;
    prompt.value = routingInputs.get(workloadId)!;
  }
  activeTab = id;
  for (const tab of tabs) {
    const selected = tab.dataset.tab === id;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  const architecture = id === 'architecture';
  closeInspector(false);
  layoutArchitecture(automatic && architecture);
  const presentation = architecture ? undefined : demoPresentation[id];
  document.querySelector('.workspace')!.classList.toggle('capability-layout', !architecture);
  capabilityDetails.hidden = architecture;
  capabilityDetails.open = false;
  if (architecture) document.querySelector('.workspace')!.append(detail);
  else capabilityDetails.append(detail);
  routingMap.hidden = id !== 'routing';
  document.querySelector<HTMLElement>('#routing-experience')!.hidden = id !== 'routing';
  document.querySelector<HTMLElement>('#request-form')!.hidden = id === 'reliability';
  document.querySelector<HTMLElement>('.request-input')!.hidden = id === 'reliability';
  document.querySelector('#result-heading')!.textContent = 'Response';
  document.querySelector('.prompt-label > span')!.textContent = automatic ? 'Synthetic input' : 'Prompt';
  document.querySelector('#result-empty')!.textContent = automatic ? 'Run a workload to see the response.' : 'Send a request to see the response.';
  document.querySelector<HTMLElement>('#automatic-model')!.hidden = !automatic;
  document.querySelector<HTMLElement>('#routing-options')!.hidden = !automatic;
  document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('#routing-options input, #routing-options select')
    .forEach(control => { control.disabled = !automatic || pending; });
  document.querySelector<HTMLElement>('#model')!.closest('label')!.hidden = automatic || id === 'multi-cloud';
  document.querySelector('#live-test-title')!.textContent = automatic ? 'Run the selector'
    : id === 'reliability' ? 'Current native proof request result' : 'Try a model call';
  document.querySelector('#live-test-scope')!.textContent = '';
  sendLabel();
  document.querySelector<HTMLElement>('#architecture-visual')!.hidden = !architecture;
  document.querySelector<HTMLElement>('#architecture-intro')!.hidden = !architecture;
  document.querySelector<HTMLElement>('#capability-story')!.hidden = architecture;
  document.querySelector<HTMLElement>('#gateway-value')!.hidden = architecture;
  document.querySelector<HTMLElement>('#live-test')!.hidden = architecture ? !automatic : presentation?.request === 'none' && id !== 'reliability';
  document.querySelector<HTMLDetailsElement>('#live-test')!.open = automatic || id === 'reliability' || (!architecture && presentation?.request !== 'none');
  document.querySelector<HTMLElement>('#request-conclusion')!.hidden = true;
  document.querySelector<HTMLElement>('#model-instructions')!.hidden = id !== 'multi-cloud';
  document.querySelector<HTMLElement>('#panel-signals')!.hidden = id !== 'observability' && id !== 'finops';
  document.querySelector('#capability-panel')!.setAttribute('aria-labelledby', `tab-${id}`);
  updateArchitectureView();
  renderMonitoringSummary();
  root.dataset.tab = id;
  renderObservedPath();
  updateConclusion();
  if (architecture) {
    if (automatic) {
      if (manualPrompt === undefined) {
        manualPrompt = prompt.value;
        prompt.value = routingInputs.get(workloadId)!;
      }
      refreshRouting();
      if (config) void loadRoutingSnapshot();
      if (!policyReadStarted) void loadPolicyEvidence();
    }
    updateReady();
    sendLabel();
    return;
  }
  const capability = getCapability(id);
  const grouped = demoTabFor(id);
  document.querySelector('#gateway-role')!.textContent = grouped.gatewayRole || capability.gatewayRole;
  document.querySelector('#demo-scope')!.textContent = id === 'reliability'
    ? 'Native controls use fixed real requests and profile-specific saved evidence, separate from custom routing. Saved verification is not the current request.'
    : id === 'multi-cloud' && config
    ? catalogScope(config.models)
    : grouped.demoScope || capability.demoScope;
  document.querySelector<HTMLElement>('#multi-cloud-experience')!.hidden = id !== 'multi-cloud';
  document.querySelector<HTMLElement>('#routing-experience')!.hidden = id !== 'routing';
  document.querySelector<HTMLElement>('#scenario-design')!.hidden = id === 'multi-cloud' || id === 'routing';
  document.querySelector<HTMLElement>('#evaluation-notes')!.hidden = id === 'multi-cloud' || id === 'routing';
  document.querySelector<HTMLDetailsElement>('#evaluation-notes')!.open = false;
  if (id === 'multi-cloud') refreshCatalog();
  if (id === 'observability' && config) void loadMonitoringContext();
  if (id === 'routing') {
    document.querySelector<HTMLDetailsElement>('#live-test')!.open = true;
    refreshRouting();
    if (config) void loadRoutingSnapshot();
    if (!policyReadStarted) void loadPolicyEvidence();
  }
  if (id === 'reliability' || id === 'safety') { void loadGovernanceProof(); void loadContentSafety(); }
  lastCapability = id;
  document.querySelector<HTMLElement>('#panel-signals')!.hidden = id !== 'observability' && id !== 'finops';
  controlInstructions.hidden = true;
  document.querySelector('#control-test-boundary')!.textContent = id === 'safety'
    ? safetySummary(safetyEvidence, selectedGateway)
    : 'Native controls use the fixed proof buttons. Saved verification and current actual request results are separate.';
  document.querySelector<HTMLElement>('#model-instructions')!.hidden = id !== 'multi-cloud';
  document.querySelector('#evaluation-question')!.textContent = grouped.title;
  document.querySelector('#view-scope')!.textContent = demoPresentation[id].badge;
  document.querySelector('#capability-experience')!.textContent = capability.experience;
  document.querySelector('#scenario-example')!.textContent = capability.example;
  document.querySelector('#scenario-test')!.textContent = capability.test;
  updateMonitoringPresentation();
  showCapability(capability);
  renderTabExperience();
  if (config) updateReady();
}
for (const [index, tab] of tabs.entries()) {
  tab.addEventListener('click', () => selectTab(views[index]));
  tab.addEventListener('keydown', event => {
    let next: number;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else return;
    event.preventDefault();
    selectTab(views[next]);
    tabs[next].focus();
  });
}
document.querySelector<HTMLButtonElement>('#explore-models')!.addEventListener('click', () => {
  selectTab('multi-cloud');
  document.querySelector<HTMLDetailsElement>('#live-test')!.open = true;
  document.querySelector<HTMLSelectElement>('#application')!.focus();
});
document.querySelector<HTMLButtonElement>('#explore-selector')!.addEventListener('click', () => {
  if (pending || policyUpdating || reloadPending) return;
  document.querySelector<HTMLDetailsElement>('#live-test')!.open = true;
  prompt.focus();
});

const form = document.querySelector<HTMLFormElement>('#request-form')!;
const appSelect = document.querySelector<HTMLSelectElement>('#application')!;
const modelSelect = document.querySelector<HTMLSelectElement>('#model')!;
const prompt = document.querySelector<HTMLTextAreaElement>('#prompt')!;
const send = document.querySelector<HTMLButtonElement>('#send')!;
const setup = document.querySelector<HTMLElement>('#setup')!;
const pathStatus = document.querySelector<HTMLElement>('#path-status')!;
const resultPanel = document.querySelector<HTMLElement>('#result')!;
const normalPrompt = 'Summarize this synthetic maintenance note: DEMO-01 has a scheduled Saturday maintenance window.';
const presets: Record<string, string> = {
  maintenance: normalPrompt,
  handover: 'Write a two-line shift handover from this synthetic note: DEMO-02 inspection completed; fictional pump P-00 remains offline pending a scheduled review. Do not give operating instructions.',
  classification: 'Classify this synthetic work order as inspection, maintenance, or administrative: DEMO-03 requests a review of fictional equipment inspection records. Explain the label in one sentence.'
};
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-preset]')) {
  button.addEventListener('click', () => {
    if (!pending) { prompt.value = presets[button.dataset.preset!]; prompt.focus(); }
  });
}
document.querySelector<HTMLButtonElement>('#normal-prompt')!.addEventListener('click', () => {
  if (!pending) { prompt.value = normalPrompt; prompt.focus(); }
});
document.querySelector<HTMLButtonElement>('#block-prompt')!.addEventListener('click', () => {
  if (!pending) { prompt.value = `POC_CONTENT_SAFETY_BLOCK — ${normalPrompt}`; prompt.focus(); }
});
function refreshCatalog() {
  renderModelCatalog(document.querySelector<HTMLElement>('#multi-cloud-experience')!, {
    gatewayId: selectedGateway, authHeader: config?.authHeader,
    models: config?.models || [], successes, selectedId: catalogSelection,
    gatewayConfigured: Boolean(config?.gatewayConfigured), pending,
    configurationStatus: catalogConfigurationStatus
  }, id => {
    catalogSelection = id;
    refreshCatalog();
    const configured = config?.models.some(model => model.id === id);
    document.querySelector<HTMLElement>('#live-test')!.hidden = !configured;
    renderObservedPath();
    document.querySelector<HTMLButtonElement>('.model-catalog button[aria-pressed="true"]')!.focus();
  }, model => {
    modelSelect.value = model.id;
    updateReady();
    document.querySelector<HTMLDetailsElement>('#live-test')!.open = true;
  });
  if (activeTab === 'multi-cloud') {
    const selected = catalogSelection || config?.models[0]?.id;
    document.querySelector<HTMLElement>('#live-test')!.hidden = !config?.models.some(model => model.id === selected);
  }
}
function refreshRouting() {
  renderRoutingDiagram(routingMap, { gatewayId: selectedGateway, snapshot: routingSnapshot, evidence: policyEvidence, error: policyError });
  renderCostRouting(document.querySelector<HTMLElement>('#routing-experience')!, {
    snapshot: routingSnapshot, busy: pending, loading: routingLoading, error: routingError,
    plannedInputTokens, reloadPending, reloadStatus, onReload: () => { void reloadEvidence(); }
  });
  renderPolicyControls();
  const preview = document.querySelector<HTMLElement>('#architecture-expected')!;
  const snapshot = routingSnapshot;
  const selection = snapshot ? explainRoutingChoice(snapshot.candidates) : undefined;
  preview.textContent = routingError || (routingLoading ? 'Checking eligibility…'
    : !snapshot ? 'Eligibility unavailable · no model assumed'
      : selection?.selected ? `Expected: ${selection.selected.price.label} · ${snapshot.candidates.filter(candidate => candidate.eligible).length} eligible`
        : 'Expected: no eligible model · request will stop locally');
  preview.dataset.state = routingError ? 'error' : 'preview';
}
function renderPolicyControls() {
  const selector = document.querySelector<HTMLSelectElement>('#routing-policy')!;
  selector.replaceChildren();
  for (const preset of livePolicy?.presets || []) {
    const option = document.createElement('option');
    option.value = preset.id; option.textContent = preset.label;
    selector.append(option);
  }
  if (!selector.options.length) {
    const option = document.createElement('option');
    option.value = ''; option.textContent = 'Server policy unavailable';
    selector.append(option);
  }
  if (livePolicy) selector.value = livePolicy.active.id;
  selector.disabled = pending || policyUpdating || reloadPending || !livePolicy?.presets.length;
  const status = document.querySelector<HTMLElement>('#routing-policy-status')!;
  status.setAttribute('role', livePolicyError ? 'alert' : 'status');
  status.textContent = livePolicyError || (policyUpdating ? 'Updating server-wide policy…' : livePolicy
    ? `${policyVersionLabel(livePolicy.active.version)} · server-wide`
    : 'Loading server-wide policy; no policy or capability is assumed.');
}
let livePolicyGeneration = 0;
async function loadLivePolicy() {
  const generation = ++livePolicyGeneration;
  try {
    const response = await fetch('/api/routing-policy');
    const body = await response.json();
    if (generation !== livePolicyGeneration) return;
    if (!response.ok || !body.active?.version || !Array.isArray(body.presets)) throw new Error(body.error || 'Routing policy unavailable.');
    livePolicy = body as PolicySnapshot;
    livePolicyError = undefined;
  } catch (error) {
    if (generation !== livePolicyGeneration) return;
    livePolicyError = error instanceof Error ? error.message : String(error);
  }
  renderPolicyControls();
  updateReady();
}
document.querySelector<HTMLSelectElement>('#routing-policy')!.addEventListener('change', async event => {
  if (pending || policyUpdating || reloadPending || !livePolicy) return;
  const presetId = (event.currentTarget as HTMLSelectElement).value;
  const expectedVersion = livePolicy.active.version;
  ++livePolicyGeneration;
  policyUpdating = true;
  livePolicyError = undefined;
  updateReady();
  renderPolicyControls();
  try {
    const response = await fetch('/api/routing-policy', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ presetId, expectedVersion })
    });
    const body = await response.json();
    const snapshot = body.snapshot || body;
    if (snapshot.active?.version && Array.isArray(snapshot.presets)) livePolicy = snapshot as PolicySnapshot;
    if (!response.ok) throw new Error(body.error || `Policy update HTTP ${response.status}`);
  } catch (error) {
    livePolicyError = error instanceof Error ? error.message : String(error);
  } finally {
    policyUpdating = false;
    renderPolicyControls();
    await loadRoutingSnapshot();
    updateReady();
  }
});
async function reloadEvidence() {
  if (pending || reloadPending || policyUpdating) return;
  const gatewayId = selectedGateway;
  reloadPending = true;
  reloadStatus = 'Reloading genuine saved evidence…';
  updateReady();
  refreshRouting();
  try {
    const response = await fetch('/api/reload-evidence', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ gatewayId })
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || `Reload HTTP ${response.status}`);
    if (body.gatewayId !== gatewayId) throw new Error('Reload profile mismatch.');
    reloadStatus = `Genuine evidence reloaded at ${new Date(body.reloadedAt).toLocaleString()}. ${body.evaluation?.current ? 'Current assessment loaded.' : 'No current approval; obtain a genuine evaluation.'}`;
    monitoringEvidence = undefined;
    monitoringError = undefined;
    monitoringContextGeneration++;
    monitoringAudit = undefined;
    monitoringAuditError = undefined;
    monitoringEvaluations = [];
    monitoringEvaluationError = undefined;
    monitoringContextLoading = false;
    policyEvidence = undefined;
    policyError = undefined;
    await Promise.all([loadLivePolicy(), loadPolicyEvidence(), loadMonitoring(), loadRoutingSnapshot(), loadGovernanceProof(), loadContentSafety()]);
  } catch (error) {
    reloadStatus = `Evidence reload failed: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    reloadPending = false;
    updateReady();
    refreshRouting();
  }
}
async function loadContentSafety() {
  const generation = ++safetyGeneration;
  const profile = profileGeneration;
  const gateway = selectedGateway;
  safetyLoading = true; safetyError = undefined;
  renderTabExperience();
  try {
    const response = await fetch(`/api/content-safety?gateway=${gateway}`);
    const body = await response.json();
    if (generation !== safetyGeneration || profile !== profileGeneration) return;
    if (!response.ok) throw new Error(body.error || `Native Content Safety HTTP ${response.status}`);
    safetyEvidence = parsePublicContentSafety(body, gateway);
  } catch (error) {
    if (generation !== safetyGeneration || profile !== profileGeneration) return;
    safetyEvidence = undefined; safetyError = error instanceof Error ? error.message : String(error);
  } finally {
    if (generation === safetyGeneration && profile === profileGeneration) {
      safetyLoading = false; renderTabExperience(); refreshInspector();
    }
  }
}
async function loadGovernanceProof() {
  const generation = ++governanceGeneration;
  const profile = profileGeneration;
  const gateway = selectedGateway;
  governanceLoading = true;
  governanceError = undefined;
  renderTabExperience();
  try {
    const response = await fetch(`/api/governance-proof?gateway=${gateway}`);
    const body = await response.json();
    if (generation !== governanceGeneration || profile !== profileGeneration) return;
    if (!response.ok) throw new Error(body.error || `Saved native proof HTTP ${response.status}`);
    governanceProof = parseGovernanceProof(body, gateway);
  } catch (error) {
    if (generation !== governanceGeneration || profile !== profileGeneration) return;
    governanceProof = undefined;
    governanceError = error instanceof Error ? error.message : String(error);
  } finally {
    if (generation === governanceGeneration && profile === profileGeneration) {
      governanceLoading = false;
      renderTabExperience();
      refreshInspector();
    }
  }
}
async function loadPolicyEvidence() {
  policyReadStarted = true;
  const generation = profileGeneration;
  const gateway = selectedGateway;
  try {
    const response = await fetch(`/api/gateway-policies?gateway=${gateway}`);
    const value = await response.json();
    if (generation !== profileGeneration) return;
    if (!response.ok) throw new Error(value.error || `Azure policy snapshot HTTP ${response.status}`);
    if (value.gatewayId !== gateway) throw new Error('Policy profile mismatch.');
    policyEvidence = value as PolicyEvidence;
  } catch (error) {
    if (generation !== profileGeneration) return;
    policyError = `Policy configuration unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
  refreshRouting();
}
function sendLabel() {
  document.querySelector('#send')!.textContent = pending ? 'Waiting…'
    : automaticJourney() ? 'Run workload' : 'Send';
}
function storeSnapshot(snapshot: RoutingSnapshot) {
  if (snapshot.gatewayId !== selectedGateway) throw new Error('Routing profile mismatch.');
  routingSnapshot = snapshot;
  if (snapshot.policy && livePolicy && !policyUpdating) livePolicy = { ...livePolicy, active: snapshot.policy };
}
async function loadRoutingSnapshot() {
  const generation = ++snapshotGeneration;
  const app = appSelect.value;
  const submittedWorkload = workloadId;
  const gateway = selectedGateway;
  if (routingSnapshot?.application !== app || routingSnapshot.workload.id !== workloadId) routingSnapshot = undefined;
  routingLoading = true;
  routingError = undefined;
  refreshRouting();
  updateReady();
  try {
    const response = await fetch(`/api/routing?gateway=${gateway}&app=${encodeURIComponent(app)}&workload=${encodeURIComponent(submittedWorkload)}`);
    if (!response.ok) throw new Error(`Model pricing HTTP ${response.status}`);
    const snapshot = await response.json() as RoutingSnapshot;
    if (generation === snapshotGeneration && gateway === selectedGateway && app === appSelect.value && workloadId === submittedWorkload) storeSnapshot(snapshot);
  } catch (error) {
    if (generation === snapshotGeneration) {
      routingSnapshot = undefined;
      routingError = `Unable to load model prices: ${error instanceof Error ? error.message : String(error)}`;
    }
  } finally {
    if (generation === snapshotGeneration) {
      routingLoading = false;
      updateReady();
      refreshRouting();
    }
  }
}
function recordModelSuccess(model: Model) {
  successes.add(model.id);
  const node = modelPathNode(model);
  observedNodes.add(node);
  document.querySelector('#gateway-badge')!.textContent = 'Response observed';
  const verified = config?.models.filter(item => modelPathNode(item) === node && successes.has(item.id)).length || 0;
  document.querySelector(`#${node}-badge`)!.textContent = `${verified} responded this session`;
}
function updateReady() {
  const ready = config?.applications.find(app => app.id === appSelect.value)?.ready;
  const automatic = automaticJourney();
  const autoReady = routingSnapshot?.application === appSelect.value && routingSnapshot.ready;
  const busy = pending || policyUpdating || reloadPending;
  send.disabled = busy || !ready || (automatic ? routingLoading || !autoReady || !routingSnapshot?.policy
    || !livePolicy || routingSnapshot.policy.version !== livePolicy.active.version : !modelSelect.value);
  appSelect.disabled = busy;
  document.querySelector<HTMLSelectElement>('#gateway-select')!.disabled = busy || !availableProfiles.length;
  modelSelect.disabled = busy;
  tabs.forEach(tab => { tab.disabled = busy; });
  architectureTabs.forEach(tab => { tab.disabled = busy; });
  document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('#routing-options input, #routing-options select')
    .forEach(control => { control.disabled = !automatic || busy; });
  renderPolicyControls();
  prompt.disabled = pending;
  setup.textContent = !config ? 'Configuration unavailable.'
    : !config.gatewayConfigured || !config.models.length ? 'Setup required: server .env needs a real gateway origin, runtime key and exact published model name.'
    : !ready ? `Application ${appSelect.value} has no runtime key configured.`
    : config.sameKey ? 'A and B share a key: caller isolation cannot be tested. Use distinct runtime keys.'
    : 'Synthetic data only · Real model charges apply';
  setup.hidden = Boolean(ready && config?.gatewayConfigured && config.models.length && !config.sameKey);
}
appSelect.addEventListener('change', () => {
  updateReady();
  if (automaticJourney()) void loadRoutingSnapshot();
});
modelSelect.addEventListener('change', () => { updateReady(); renderTabExperience(); });
document.querySelector<HTMLSelectElement>('#workload')!.addEventListener('change', event => {
  const value = (event.currentTarget as HTMLSelectElement).value;
  if (!isWorkloadId(value)) throw new Error('Invalid workload.');
  routingInputs.set(workloadId, prompt.value);
  workloadId = value;
  prompt.value = routingInputs.get(value)!;
  document.querySelector('#workload-requirement')!.textContent = getWorkload(value).requirement;
  document.querySelector<HTMLInputElement>('#output-cap')!.value = String(getWorkload(value).maxOutputTokens);
  void loadRoutingSnapshot();
});
document.querySelector<HTMLInputElement>('#planned-input')!.addEventListener('input', event => {
  plannedInputTokens = (event.currentTarget as HTMLInputElement).valueAsNumber;
  refreshRouting();
});
document.querySelector<HTMLInputElement>('#planned-input')!.addEventListener('invalid', () => {
  document.querySelector<HTMLDetailsElement>('#routing-settings')!.open = true;
});

async function load() {
  try {
    if (!availableProfiles.length) {
      const response = await fetch('/api/config');
      if (!response.ok) throw new Error(`Configuration HTTP ${response.status}`);
      const value = await response.json() as { profiles: PublicConfig[] };
      availableProfiles = value.profiles;
      const selector = document.querySelector<HTMLSelectElement>('#gateway-select')!;
      selector.replaceChildren(...availableProfiles.map(profile => {
        const option = document.createElement('option');
        option.value = profile.gatewayId;
        option.textContent = `${profile.label} · ${profile.gatewayConfigured && profile.models.length && profile.applications.some(app => app.ready) ? 'configured' : 'unconfigured'}`;
        return option;
      }));
      selector.value = selectedGateway;
    }
    config = availableProfiles.find(profile => profile.gatewayId === selectedGateway);
    if (!config) throw new Error('Selected gateway profile unavailable.');
    document.querySelector('#gateway-title')!.textContent = config.label;
    document.querySelector('#gateway-lifecycle')!.textContent = config.gatewayId === 'ai-gateway' ? 'Public preview' : config.lifecycle;
    document.querySelector('#gateway-association')!.textContent = config.foundryAssociated
      ? 'Foundry association verified by operator' : 'Foundry association unverified';
    document.querySelector('#gateway-node-title')!.textContent = config.label;
    document.querySelector('#node-gateway')!.setAttribute('aria-label', config.label);
    catalogConfigurationStatus = config.gatewayConfigured
      ? 'Local model configuration loaded.'
      : 'Gateway not configured. Cards are examples only.';
    modelSelect.replaceChildren();
    for (const model of config.models) {
      const option = document.createElement('option');
      option.value = model.id;
      option.textContent = modelLabel(model);
      modelSelect.append(option);
    }
    if (!config.models.length) {
      const option = document.createElement('option');
      option.textContent = 'No models configured';
      option.value = '';
      modelSelect.append(option);
    }
    document.querySelector('#gateway-badge')!.textContent = config.gatewayConfigured ? 'Ready to test' : 'Not configured';
    const coverage = modelCoverage(config.models);
    document.querySelector('#provider-coverage')!.textContent = `${coverage.models} model(s), ${coverage.providers} provider(s), ${coverage.clouds} cloud(s) configured; configuration is not proof of execution.`;
    if (activeTab === 'multi-cloud') document.querySelector('#demo-scope')!.textContent = catalogScope(config.models);
    document.querySelector('#architecture-coverage')!.textContent = `${coverage.models} models · custom PoC selects; gateway authenticates/dispatches. Tools remain unconnected.`;
    for (const node of ['azure', 'databricks', 'aws', 'gcp']) {
      const models = config.models.filter(model => modelPathNode(model) === node);
      document.querySelector(`#${node}-badge`)!.textContent = models.length ? `${models.length} ready to test` : 'Not connected';
      document.querySelector<SVGElement>(`.node.${node}`)?.classList.toggle('reference-only', !models.length);
      document.querySelector(`#edge-${node}`)!.classList.toggle('configured', config.gatewayConfigured && models.length > 0);
    }
    updateReady();
    refreshCatalog();
    renderMonitoringSummary();
    renderTabExperience();
    if (automaticJourney()) void loadRoutingSnapshot();
    void loadMonitoring();
    void loadContentSafety();
  } catch (error) {
    setup.textContent = `Configuration error: ${error instanceof Error ? error.message : String(error)}`;
    catalogConfigurationStatus = setup.textContent;
    refreshCatalog();
    send.disabled = true;
  }
}
selectTab('architecture');
void load();
void loadLivePolicy();
document.querySelector<HTMLSelectElement>('#gateway-select')!.addEventListener('change', event => {
  if (pending || reloadPending || policyUpdating) return;
  const id = (event.currentTarget as HTMLSelectElement).value;
  if (id !== 'ai-gateway' && id !== 'apim-v2') return;
  selectedGateway = id;
  profileGeneration++;
  snapshotGeneration++;
  config = undefined;
  successes.clear();
  observedNodes.clear();
  lastResult = undefined;
  lastRequestFailed = false;
  lastRoutingRefusal = undefined;
  requestObservation = { phase: 'idle' };
  routingSnapshot = undefined;
  routingLoading = false;
  routingError = undefined;
  policyEvidence = undefined;
  policyError = undefined;
  policyReadStarted = false;
  monitoringEvidence = undefined;
  monitoringError = undefined;
  monitoringContextGeneration++;
  monitoringAudit = undefined;
  monitoringAuditError = undefined;
  monitoringEvaluations = [];
  monitoringEvaluationError = undefined;
  monitoringContextLoading = false;
  catalogSelection = undefined;
  governanceGeneration++;
  governanceProof = undefined;
  governanceError = undefined;
  governanceLoading = false;
  safetyGeneration++;
  safetyEvidence = undefined;
  safetyError = undefined;
  safetyLoading = false;
  reloadStatus = undefined;
  resultPanel.hidden = true;
  document.querySelector<HTMLElement>('#result-empty')!.hidden = false;
  document.querySelector('#result-empty')!.textContent = 'No request for this gateway profile.';
  document.querySelector('#signals-content')!.textContent = 'No returned request signals for this gateway profile.';
  document.querySelector('#telemetry-badge')!.textContent = 'Not verified';
  document.querySelectorAll('.edge.configured').forEach(element => element.classList.remove('configured'));
  document.querySelectorAll('.observed, .failed, .pending').forEach(element => element.classList.remove('observed', 'failed', 'pending'));
  pathStatus.textContent = 'Selected profile not called this session. Paths are not gateway traces.';
  updateReady();
  refreshRouting();
  renderObservedPath();
  void load().then(() => {
    if (automaticJourney() && !policyReadStarted) void loadPolicyEvidence();
    if (activeTab === 'reliability' || activeTab === 'safety') void loadGovernanceProof();
    if (activeTab === 'observability') void loadMonitoringContext();
    refreshInspector();
    updateConclusion();
  });
});

function showResult(result: CallResult, submitted: SubmittedRequest) {
  lastResult = result;
  lastRequestFailed = false;
  document.querySelector<HTMLElement>('#result-empty')!.hidden = true;
  resultPanel.hidden = false;
  resultPanel.replaceChildren();
  const heading = document.createElement('h3');
  const ok = hasModelResponse(result);
  heading.textContent = `${config?.label || result.gatewayId} · Application ${submitted.application} · ${result.outcome?.nativeControl === 'content-safety' ? 'Native Content Safety stop' : ok ? 'Response' : 'No supported response'} · HTTP ${result.status}`;
  const facts = document.createElement('dl');
  facts.className = 'result-facts';
  const factValues = result.routing ? [
    ['Model', result.returnedModel === result.routing.selectedPrice.reportedModel ? result.routing.selectedPrice.label : result.returnedModel || 'unavailable'],
    ['Node round trip', `${result.latencyMs} ms`],
    ['Tokens', result.tokens?.total !== undefined ? String(result.tokens.total) : 'Not reported'],
    ['Est. token cost', estimatedCostLabel(result.routing.usageCostUsd)]
  ] : [
    ['Model', result.returnedModel || 'Not reported'],
    ['Node round trip', `${result.latencyMs} ms`],
    ['Tokens', result.tokens?.total !== undefined ? String(result.tokens.total) : 'Not reported'],
    ['Est. token cost', estimatedCostLabel(result.estimatedTokenCostUsd)]
  ];
  for (const [label, value] of factValues) {
    const term = document.createElement('dt');
    const description = document.createElement('dd');
    term.textContent = label;
    description.textContent = value;
    facts.append(term, description);
  }
  const text = document.createElement('p');
  text.className = 'response-text';
  text.textContent = result.response;
  const usage = document.createElement('p');
  usage.className = 'usage';
  usage.textContent = result.tokens
    ? `${result.tokens.total ?? 'Total not reported'} tokens · ${result.tokens.input ?? 'Not reported'} input / ${result.tokens.output ?? 'Not reported'} output`
    : 'Tokens not reported.';
  const raw = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = 'Raw request / response';
  const pre = document.createElement('pre');
  pre.textContent = JSON.stringify({ request: result.request, source: result.source, status: result.status, headers: result.headers, response: result.raw }, null, 2);
  raw.append(summary, pre);
  resultPanel.append(heading);
  renderActualJourney(resultPanel, result, submitted);
  raw.append(usage);
  resultPanel.append(facts, text, raw);
  if (result.gatewayId === 'apim-v2') {
    const timingScope = document.createElement('p');
    timingScope.className = 'usage';
    timingScope.textContent = 'Application round trip includes network and backend inference. Gateway and models may be in different regions; this is not a same-region gateway benchmark.';
    raw.append(timingScope);
  }
  if (result.routing) {
    const decision = document.createElement('details');
    const decisionTitle = document.createElement('summary');
    decisionTitle.textContent = 'Why this model? · actual local decision';
    const record = document.createElement('pre');
    record.textContent = JSON.stringify(result.routing, null, 2);
    const decisionReason = document.createElement('p');
    decisionReason.textContent = result.routing.decisiveReason;
    decision.append(decisionTitle, decisionReason, record);
    if (result.routing.usageCostUnavailableReason) {
      const unavailable = document.createElement('p');
      unavailable.textContent = result.routing.usageCostUnavailableReason;
      resultPanel.insertBefore(unavailable, raw);
    }
    resultPanel.querySelector('#request-evidence')!.append(decision);
  }
  const signals = document.querySelector<HTMLElement>('#signals-content')!;
  const observation = document.createElement('p');
  observation.textContent = `${result.source} · HTTP ${result.status} · ${result.latencyMs} ms local round trip. ${usage.textContent}`;
  const headers = document.createElement('details');
  const headersTitle = document.createElement('summary');
  headersTitle.textContent = 'Returned allowlisted headers (not a gateway trace)';
  const headersText = document.createElement('pre');
  headersText.textContent = Object.keys(result.headers).length ? JSON.stringify(result.headers, null, 2) : 'No allowlisted headers returned.';
  headers.append(headersTitle, headersText);
  signals.replaceChildren(observation, headers);
  const correlation = document.createElement('p');
  correlation.textContent = `Correlation ${result.correlationId || 'unavailable'} · local header propagation, not distributed tracing.`;
  signals.prepend(correlation);
}
async function executeRequest(path: '/api/request' | '/api/routing/request' | '/api/governance/request' | '/api/content-safety/request',
  payload: object, initialContext: RequestContext, submitted: SubmittedRequest, automatic: boolean) {
  if (pending || reloadPending || policyUpdating || !config) return;
  pending = true;
  const app = submitted.application;
  const gatewayId = submitted.gatewayId;
  let requestContext: RequestContext = initialContext;
  requestObservation = { phase: 'pending', request: requestContext };
  let rejection: RoutingRejection | undefined;
  let failedRecord: JourneyError | undefined;
  lastRoutingRefusal = undefined;
  appSelect.disabled = modelSelect.disabled = prompt.disabled = true;
  send.textContent = 'Waiting…';
  updateReady();
  refreshCatalog();
  refreshRouting();
  resultPanel.hidden = true;
  document.querySelector<HTMLElement>('#result-empty')!.hidden = false;
  document.querySelector('#result-empty')!.textContent = 'Waiting for the actual gateway response…';
  document.querySelector('#request-conclusion')!.textContent = 'Test in progress — gateway receipt and model execution are not yet verified.';
  document.querySelectorAll('.observed, .failed, .pending').forEach(element => element.classList.remove('observed', 'failed', 'pending'));
  // No provider edge or policy step is animated before a result is observed.
  pathStatus.textContent = 'Local request submitted; waiting for a gateway response. Backend path is not yet verified.';
  renderObservedPath();
  refreshInspector();
  renderTabExperience();
  try {
    const response = await fetch(path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(65000)
    });
    const body = await response.json();
    if (body.gatewayId && body.gatewayId !== gatewayId) throw new Error('Response gateway profile mismatch.');
    if (automatic && body.snapshot) storeSnapshot(body.snapshot);
    if (!('source' in body)) {
      failedRecord = body as JourneyError;
      rejection = body.rejection;
      lastRoutingRefusal = rejection;
      throw new Error(body.error || `Local endpoint HTTP ${response.status}`);
    }
    const result = body as CallResult;
    if (result.gatewayId !== gatewayId) throw new Error('Response gateway profile mismatch.');
    const actualModel = config.models.find(item => item.name === result.model);
    requestContext = { ...requestContext, model: actualModel };
    requestObservation = { phase: 'result', request: requestContext, result };
    showResult(result, submitted);
    const ok = hasModelResponse(result);
    if (ok) {
      if (actualModel) recordModelSuccess(actualModel);
      document.querySelector('#edge-apps')!.classList.add('observed');
      if (actualModel) {
        const node = modelPathNode(actualModel);
        document.querySelector(`#edge-${node}`)!.classList.add('observed');
        document.querySelector(`.node[data-detail="${node}"]`)!.classList.add('observed');
      }
      document.querySelector('#node-gateway')!.classList.add('observed');
      document.querySelector('#gateway-badge')!.textContent = 'Live response observed';
      pathStatus.textContent = `Application ${app} → gateway → ${actualModel ? modelLabel(actualModel) : 'reported model'}: response observed. Path inferred from configuration, not a gateway trace.`;
    } else if (result.source === 'gateway-response') {
      document.querySelector('#edge-apps')!.classList.add('failed');
      document.querySelector('#node-gateway')!.classList.add('failed');
      pathStatus.textContent = result.status >= 200 && result.status < 300
        ? `HTTP ${result.status}, no supported model text. No successful call claimed; inspect raw response and API compatibility.`
        : result.outcome?.enforcementBoundary === 'native-gateway-policy'
          ? `HTTP ${result.status} · verified native gateway policy rejection. Path stops at gateway; no model execution claimed.`
          : `HTTP ${result.status} from gateway endpoint. Path stops here visually; policy vs backend origin is unknown.`;
    } else {
      pathStatus.textContent = 'Local transport failed; gateway receipt and backend execution are unknown. No path is claimed.';
    }
  } catch (error) {
    const localRefusal = Boolean(rejection || failedRecord?.outcome?.gatewayCallMade === false);
    requestObservation = localRefusal ? { phase: 'local-refusal', request: requestContext }
      : { phase: 'local-error', request: requestContext };
    lastResult = undefined;
    lastRequestFailed = true;
    document.querySelector<HTMLElement>('#result-empty')!.hidden = true;
    resultPanel.hidden = false;
    resultPanel.replaceChildren(paragraph(rejection ? `${getWorkload(rejection.workload).label} · local refusal`
      : 'Local request error', error instanceof Error ? error.message : String(error)));
    renderActualJourney(resultPanel, failedRecord || {}, submitted);
    if (rejection) {
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = 'Actual refusal decision · local router, not gateway enforcement';
      const record = document.createElement('pre');
      record.textContent = JSON.stringify(rejection, null, 2);
      details.append(summary, record);
      resultPanel.append(details);
    }
    document.querySelector('#signals-content')!.textContent = `Local request error · correlation ${failedRecord?.correlationId || 'unavailable'}. See the safe outcome event; no distributed trace or model success claimed.`;
    pathStatus.textContent = localRefusal ? 'Custom PoC refused this request. No gateway or model call was made; this is not gateway enforcement.'
      : 'Local request failed. No gateway or model execution claimed; check connectivity/configuration.';
  } finally {
    pending = false;
    document.querySelector('#edge-apps')!.classList.remove('pending');
    appSelect.disabled = modelSelect.disabled = prompt.disabled = false;
    sendLabel();
    updateReady();
    refreshCatalog();
    refreshRouting();
    renderObservedPath();
    updateConclusion();
    refreshInspector();
    renderTabExperience();
    if (automatic) void loadRoutingSnapshot();
  }
}
form.addEventListener('submit', event => {
  event.preventDefault();
  if (pending || reloadPending || policyUpdating || !config || send.disabled) return;
  const automatic = automaticJourney();
  const app = appSelect.value as 'A' | 'B';
  const gatewayId = selectedGateway;
  const model = config.models.find(model => model.id === modelSelect.value);
  if (!automatic && !model) return;
  try {
    const payload = automatic
      ? routingRequest(routingSnapshot!, gatewayId, app, workloadId, prompt.value, plannedInputTokens)
      : Object.freeze({ gatewayId, app, modelId: model!.id, prompt: prompt.value });
    const submitted: SubmittedRequest = Object.freeze({ gatewayId, application: app,
      workload: automatic ? workloadId : 'manual',
      ...(automatic ? { policyVersion: routingSnapshot!.policy!.version } : {}) });
    void executeRequest(automatic ? '/api/routing/request' : '/api/request', payload,
      { application: app, model: automatic ? undefined : model, automatic }, submitted, automatic);
  } catch (error) {
    routingError = error instanceof Error ? error.message : String(error);
    refreshRouting();
  }
});
