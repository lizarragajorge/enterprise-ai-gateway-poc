import type { RoutingSnapshot } from '../server/routing.ts';
import type { PolicyEvidence } from '../server/policy-evidence.ts';
import type { GatewayId } from '../server/gateway.ts';
import { gatewayPolicyDocumentation, gatewayPortal } from './governance-proof.ts';
import { routingGateFacts } from './routing-explanation.ts';
import { workloads } from '../server/workloads.ts';

type Selection = 'app' | 'approval' | 'rules' | 'cost' | 'gateway';
export function renderRoutingDiagram(target: HTMLElement, state: {
  snapshot?: RoutingSnapshot; evidence?: PolicyEvidence; error?: string; gatewayId?: GatewayId;
}) {
  const gatewayId = state.gatewayId || state.snapshot?.gatewayId || 'ai-gateway';
  const facts = routingGateFacts(state.snapshot);
  const selections: { id: Selection; title: string; owner: string }[] = [
    { id: 'app', title: '1. Workload', owner: facts.workload },
    { id: 'approval', title: '2. Approval', owner: facts.approval },
    { id: 'rules', title: '3. Business rules', owner: facts.business },
    { id: 'cost', title: '4. Cost selection', owner: 'Lowest eligible planned cost' },
    { id: 'gateway', title: '5. Gateway dispatch', owner: 'Native auth · exact model alias' }
  ];
  const selected = selections.find(item => item.id === target.dataset.selection)?.id || 'rules';
  target.replaceChildren();
  const caption = document.createElement('p');
  caption.className = 'routing-map-caption';
  caption.textContent = 'Custom PoC routing gates → native gateway dispatch · Click a step to explain';
  const flow = document.createElement('div');
  flow.className = 'routing-map-flow';
  flow.setAttribute('role', 'group');
  flow.setAttribute('aria-label', 'Workload approval, business eligibility, cost selection and gateway dispatch');
  for (const item of selections) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.step = item.id;
    button.dataset.owner = item.id === 'gateway' ? 'azure' : 'custom';
    button.setAttribute('aria-pressed', String(Boolean(target.dataset.selection) && selected === item.id));
    button.setAttribute('aria-expanded', String(Boolean(target.dataset.selection) && selected === item.id));
    button.setAttribute('aria-controls', 'routing-map-detail');
    const name = document.createElement('strong');
    name.textContent = item.title;
    const owner = document.createElement('span');
    owner.textContent = item.owner;
    if (item.id === 'gateway') {
      const icon = document.createElement('img');
      icon.src = '/icons/ai-gateway.svg';
      icon.alt = '';
      button.append(icon);
    }
    button.append(name, owner);
    button.addEventListener('click', () => {
      if (target.dataset.selection === item.id) delete target.dataset.selection;
      else target.dataset.selection = item.id;
      renderRoutingDiagram(target, state);
      target.querySelector<HTMLButtonElement>(`button[data-step="${item.id}"]`)!.focus();
    });
    flow.append(button);
  }
  const panel = document.createElement('section');
  panel.className = 'routing-map-panel';
  panel.id = 'routing-map-detail';
  panel.hidden = !target.dataset.selection;
  panel.setAttribute('aria-label', 'Selected rule configuration');
  const heading = document.createElement('h3');
  const text = document.createElement('p');
  const raw = document.createElement('details');
  const summary = document.createElement('summary');
  const pre = document.createElement('pre');
  const workload = state.snapshot?.workload;
  if (selected === 'app') {
    heading.textContent = 'App contract · defined by the application team';
    text.textContent = 'The app submits a workload ID and synthetic input. It does not choose a model. Workloads are defined in local code, not an APIM policy.';
    summary.textContent = 'Request shape';
    pre.textContent = JSON.stringify({ gatewayId, app: state.snapshot?.application, workload: workload?.id,
      prompt: '<synthetic input>', plannedInputTokens: 1000,
      priceVersion: state.snapshot?.priceVersion, evaluationId: state.snapshot?.evaluation?.runId,
      policyVersion: state.snapshot?.policy?.version }, null, 2);
    const definitions = document.createElement('dl');
    definitions.className = 'routing-workloads';
    for (const definition of workloads) {
      const name = document.createElement('dt'), requirement = document.createElement('dd');
      name.textContent = definition.label;
      requirement.textContent = definition.requirement;
      definitions.append(name, requirement);
    }
    panel.append(definitions);
  } else if (selected === 'approval') {
    heading.textContent = 'Approved for this workload, not approved for everything';
    text.textContent = `${facts.approval}. Each model must pass all 3 fixed synthetic JSON checks for the declared workload. Saved approval expires after 24 hours and is bound to this gateway/model configuration. Checks run in advance, not on each request; they are not general quality certification. External publication has no evaluation and is refused locally.`;
    summary.textContent = 'Current saved approval evidence';
    pre.textContent = JSON.stringify({ evaluation: state.snapshot?.evaluation,
      workload: workload?.id, candidates: state.snapshot?.candidates.map(candidate => ({
        model: candidate.price.label, approval: candidate.approval
      })) }, null, 2);
  } else if (selected === 'rules') {
    heading.textContent = 'Business eligibility before price · custom PoC';
    text.textContent = `${facts.businessDetail} Policy changes are server-wide, versioned and independent of gateway profile. They never grant workload approval. The fixed automatic pool contains only the two Azure Foundry cost models; Databricks and other providers are not evaluated candidates, not dynamically rejected third-party models.`;
    const boundary = document.createElement('p');
    boundary.textContent = 'For the enterprise example below, “third-party” means an endpoint outside an approved hosting boundary—not the model publisher. Azure-hosted Databricks is not automatically external. A workload-specific provider allowlist would need explicit configuration and enforcement; it is not implemented here. The separate manual API does not apply these custom routing gates.';
    panel.append(boundary);
    summary.textContent = 'Actual workload definition and routing rule';
    pre.textContent = JSON.stringify({ workload: workload || 'Active workload snapshot unavailable.',
      policy: state.snapshot?.policy, strategy: 'lowest-cost-approved-workload', evaluationTTLHours: 24,
      priceVersion: state.snapshot?.priceVersion, noEligibleCandidate: 'refuse; no gateway call' }, null, 2);
  } else if (selected === 'gateway') {
    heading.textContent = 'Native gateway · authentication & model dispatch';
    text.textContent = 'The custom router sends the selected published alias in the model field; the gateway authenticates and dispatches by exact match. It does not make this workload/cost decision. ' + (gatewayId === 'apim-v2'
      ? 'Inspect API/operation policies in Azure API Management. APIM uses XML policy statements and API-scoped subscriptions, not standalone policy cards. Only the separate attributable native proof establishes enforcement; configuration alone does not.'
      : 'In the standalone portal: Policies → Add policy → Type → Assets → Configure → Create. This tier uses structured policy cards/JSON, not APIM XML. Native controls do not perform the custom workload/cost decision.');
    const cards = document.createElement('dl');
    cards.className = 'native-policy-types';
    for (const [name, fields] of [
      ['Request rate limit', 'Assets · calls/window · caller identity or IP'],
      ['Token rate limit', 'Models · token allowance/period · caller identity or IP'],
      ['IP filter', 'Assets · allow/deny · network ranges'],
      ['Content safety', 'Assets · Content Safety backend · thresholds/shields/blocklists']
    ]) {
      const term = document.createElement('dt'), definition = document.createElement('dd');
      term.textContent = name; definition.textContent = fields;
      cards.append(term, definition);
    }
    if (gatewayId === 'ai-gateway') panel.append(cards);
    summary.textContent = gatewayId === 'apim-v2' ? 'Saved APIM policy evidence · if available' : 'Saved standalone policy JSON from Azure';
    const note = document.createElement('p');
    note.className = 'policy-evidence-note';
    note.setAttribute('role', state.error ? 'alert' : 'status');
    if (state.error) note.textContent = state.error;
    else if (!state.evidence) note.textContent = 'Saved native configuration unavailable; no enforcement inferred.';
    else {
      const names = state.snapshot?.candidates.map(candidate => candidate.price.publishedName) || [];
      const pair = state.evidence.models.filter(model => names.includes(model.name));
      note.textContent = `Azure snapshot ${state.evidence.capturedAt}. ${pair.length === 2 && pair.every(model => !model.policies.length)
        ? 'No native policies attached to the current cost pair. Limits below are on a legacy model, not this route.'
        : 'Inspect selected asset policies below.'} Configuration is not enforcement proof.`;
      pre.textContent = JSON.stringify(state.evidence, null, 2);
    }
    panel.append(note);
    const portal = document.createElement('a');
    portal.href = gatewayPortal(gatewayId);
    portal.target = '_blank'; portal.rel = 'noreferrer';
    portal.textContent = gatewayId === 'apim-v2' ? 'Open APIM in Azure portal · sign-in required' : 'Open standalone AI Gateway portal · sign-in required';
    panel.append(portal);
  } else {
    heading.textContent = 'Cheapest eligible model, not cheapest model overall';
    text.textContent = 'After configuration, current workload approval and business restrictions, compare planned input tokens plus the workload output cap at reviewed token prices. Lowest eligible cost wins; model-ID order breaks ties. No eligible model means a local refusal, with no gateway call. Latency, geography and live capacity do not select the winner here; latency is measured after the call. There is no automatic fallback.';
    summary.textContent = 'Candidate eligibility and planned cost evidence';
    pre.textContent = JSON.stringify(state.snapshot?.candidates.map(candidate => ({
      model: candidate.price.publishedName, reportedVersion: candidate.price.reportedModel,
      eligible: candidate.eligible, reason: candidate.reason, exclusions: candidate.exclusions
    })) || [], null, 2);
  }
  raw.append(summary, pre);
  panel.prepend(heading, text);
  panel.append(raw);
  const docs = document.createElement('a');
  docs.href = gatewayId === 'apim-v2' ? gatewayPolicyDocumentation(gatewayId) : selected === 'gateway'
    ? 'https://learn.microsoft.com/en-us/azure/api-management/ai-gateway-govern-secure-assets'
    : 'https://learn.microsoft.com/en-us/azure/api-management/ai-gateway-manage-models-tools';
  docs.target = '_blank'; docs.rel = 'noreferrer';
  docs.textContent = gatewayId === 'apim-v2' ? 'APIM policy documentation' : 'Standalone new-tier documentation';
  panel.append(docs);
  const example = document.createElement('p');
  example.className = 'routing-enterprise-example';
  const exampleLabel = document.createElement('strong');
  exampleLabel.textContent = 'Enterprise example · not implemented: ';
  example.append(exampleLabel, 'Business-critical workload → approved-hosting allowlist → exclude external third-party endpoints → compare remaining costs.');
  target.append(caption, flow, example, panel);
}
