import type { CallResult, GatewayId, Model } from '../server/gateway.ts';
import type { MonitoringEvidence } from '../server/monitoring-evidence.ts';
import type { RequestAuditSnapshot } from '../server/request-audit.ts';
import type { RoutingSnapshot } from '../server/routing.ts';
import { monitoringRows } from './demo-presentation.ts';
import { modelLabel } from './model-catalog.ts';
import { getWorkload } from '../server/workloads.ts';
import type { RequestEvent } from '../server/request-evidence.ts';

export interface MonitoringState {
  gatewayId: GatewayId;
  models: Model[];
  native?: MonitoringEvidence;
  nativeError?: string;
  audit?: RequestAuditSnapshot;
  auditError?: string;
  evaluations: RoutingSnapshot[];
  evaluationError?: string;
  loading: boolean;
  refreshError?: string;
  latest?: CallResult;
}
export function parseRequestAudit(value: unknown, gatewayId: GatewayId): RequestAuditSnapshot {
  if (!value || typeof value !== 'object') throw new Error('Local audit response is invalid.');
  const snapshot = value as RequestAuditSnapshot;
  if (snapshot.source !== 'local-poc-memory' || snapshot.gatewayId !== gatewayId || snapshot.capacity !== 40
    || !Number.isFinite(Date.parse(snapshot.startedAt)) || !Number.isFinite(Date.parse(snapshot.capturedAt))
    || !Array.isArray(snapshot.events) || snapshot.events.length > 40
    || snapshot.events.some(event => !event || event.gatewayId !== gatewayId || event.event !== 'ai-request-outcome'
      || !event.outcome || typeof event.correlationId !== 'string' || !Number.isFinite(event.status))) {
    throw new Error('Local audit response is invalid or belongs to another gateway profile.');
  }
  return snapshot;
}
function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  return element;
}
function section(title: string, scope: string) {
  const element = node('section');
  element.className = 'monitoring-block';
  element.append(node('h3', title), node('p', scope));
  return element;
}
function table(labels: string[], rows: (string | number)[][], label: string) {
  const wrapper = node('div');
  wrapper.className = 'monitoring-table-scroll';
  wrapper.tabIndex = 0;
  wrapper.setAttribute('role', 'region');
  wrapper.setAttribute('aria-label', label);
  const result = node('table');
  result.className = 'native-metric-samples';
  const head = node('thead'), header = node('tr'), body = node('tbody');
  for (const label of labels) {
    const cell = node('th', label); cell.scope = 'col'; header.append(cell);
  }
  head.append(header);
  for (const values of rows) {
    const row = node('tr');
    for (const value of values) row.append(node('td', String(value)));
    body.append(row);
  }
  result.append(head, body); wrapper.append(result);
  return wrapper;
}
function rawDetails(title: string, value: unknown) {
  const details = node('details');
  details.append(node('summary', title), node('pre', JSON.stringify(value, null, 2)));
  return details;
}
function link(text: string, href: string) {
  const result = node('a', text);
  result.href = href; result.target = '_blank'; result.rel = 'noreferrer';
  return result;
}
function available(value: number | undefined | null, suffix = '') {
  return typeof value === 'number' && Number.isFinite(value) ? `${value}${suffix}` : 'Not reported';
}
function workloadLabel(event: RequestEvent) {
  return event.workload === 'extract-record' || event.workload === 'reconcile-records' || event.workload === 'external-publication'
    ? getWorkload(event.workload).label : event.workload === 'governance-proof' ? 'Gateway control test' : 'Manual model call';
}
export function behaviorRows(snapshots: RoutingSnapshot[]) {
  return snapshots.flatMap(snapshot => snapshot.candidates.map(candidate => {
    const samples = candidate.approval.samples.map(sample => sample.observation);
    return {
      workload: snapshot.workload.label, model: candidate.price.label,
      workloadId: snapshot.workload.id, publishedName: candidate.price.publishedName,
      checks: samples.length ? `${candidate.approval.passed}/${candidate.approval.total} fixed checks` : 'No current approval',
      reasoningEffort: candidate.price.reasoningEffort,
      meanRoundTripMs: samples.length ? Math.round(samples.reduce((total, sample) => total + sample.latencyMs, 0) / samples.length) : null,
      evaluation: snapshot.evaluation,
      reason: candidate.approval.reason,
      samples: candidate.approval.samples
    };
  }));
}
function renderMonitoringEvidence(target: HTMLElement, state: MonitoringState, portalUrl: string) {
  target.replaceChildren();
  const label = (name: string) => {
    const model = state.models.find(model => model.name === name);
    return model ? modelLabel(model) : name;
  };
  const native = section('Gateway telemetry · native export', state.native?.metrics
    ? `Azure Monitor snapshot queried ${new Date(state.native.metrics.queriedAt).toLocaleString()}. Cumulative samples, not this request or usage within a time window.`
    : state.nativeError || 'Native telemetry is not verified for this profile.');
  native.id = 'monitoring-native';
  if (state.native?.metrics) {
    native.append(table(['Model', 'Input', 'Output', 'Reasoning', 'Cached input', 'Total'],
      monitoringRows(state.native.metrics.samples).map(row => [label(row.model), row.input, row.output, row.reasoning, row.cachedInput, row.total]),
      'Native gateway token accounting'));
    native.append(node('p', 'Reasoning tokens are a subset of output; cached tokens are a subset of input. Do not add these columns together. Zero is preserved; absent data is not reported. Multiple series are not silently summed.'));
  }
  native.append(node('p', state.gatewayId === 'ai-gateway'
    ? 'This saved snapshot contains token metrics, not traces. Open Azure Monitor to query native OTelSpans and OTelLogs in the linked workspace. Payload capture is off; no prompt/completion audit is claimed.'
    : 'No standalone exporter, metric or audit evidence is inherited by APIM Premium v2.'),
    link('Open gateway monitoring', portalUrl));
  if (state.native) {
    native.append(link('Open Application Insights', `https://portal.azure.com/#resource${state.native.insightsResourceId}/overview`),
      rawDetails('Native source, refresh command & full series', { refresh: 'npm run read:monitoring, then reload saved evidence',
        note: 'The button reloads local evidence; it does not query Azure or generate model traffic.', ...state.native }));
  }
  target.append(native);

  const audit = section('Request audit · custom PoC', state.audit
    ? `Last ${state.audit.capacity} outcomes across profiles, filtered to this gateway. Process memory since ${new Date(state.audit.startedAt).toLocaleString()}; not durable or tamper-proof.`
    : state.auditError || 'Loading local request evidence…');
  audit.id = 'monitoring-audit';
  const events = state.audit?.events || [];
  if (!events.length) audit.append(node('p', state.auditError || 'No attributed requests recorded since this server started. Run a workload, then reload this view. Historical gateway traffic is not reconstructed.'));
  const latestDecision = events.find(event => event.selectionReason);
  if (latestDecision) {
    const decision = node('div');
    decision.className = 'monitoring-decision';
    decision.append(node('h4', 'Latest captured routing rationale · not model reasoning'),
      node('p', `${latestDecision.policy?.label || 'No routing preset'} · ${latestDecision.policy?.version || 'Not captured'} · ${latestDecision.selectionReason}`),
      node('p', latestDecision.exclusions.length ? latestDecision.exclusions.map(item => `${label(item.model)} excluded: ${item.reasons.join(' ')}`).join(' ')
        : 'No candidate exclusions recorded for this decision.'));
    audit.append(decision);
  }
  for (const event of events) {
    const details = node('details');
    details.className = 'monitoring-request-event';
    const workload = event.workload === 'extract-record' || event.workload === 'reconcile-records' || event.workload === 'external-publication'
      ? getWorkload(event.workload).label : event.workload || 'Unattributed';
    details.append(node('summary', `${new Date(event.recordedAt).toLocaleTimeString()} · App ${event.application || 'unknown'} · ${workload} · HTTP ${event.status} · ${event.outcome.kind}`),
      node('p', `Target selection: ${event.selectedModel ? label(event.selectedModel) : 'None'} / ${event.selectedProvider || 'unavailable'}. Boundary: ${event.outcome.enforcementBoundary}. Gateway call ${event.outcome.gatewayCallMade ? 'attempted' : 'not made'}. Selection is not proof of backend execution.`),
      node('p', `Node-to-gateway round trip: ${available(event.nodeToGatewayRoundTripMs, ' ms')}. Tokens: input ${available(event.tokens?.input)}, output ${available(event.tokens?.output)}, reasoning ${available(event.tokens?.reasoning)}, cached ${available(event.tokens?.cachedInput)}. Estimated model cost: ${event.estimatedTokenCostUsd === null ? 'Unavailable' : `$${event.estimatedTokenCostUsd.toFixed(7)}`}.`),
      node('p', `Correlation ${event.correlationId} · decision ${event.decisionId}. Header propagation and returned IDs do not prove gateway telemetry correlation.`),
      node('p', event.outcome.recovery || 'A supported model response was received; this is not a quality verdict.'),
      rawDetails('Safe structured event · no prompts, completions or keys', event));
    audit.append(details);
  }
  audit.append(node('p', 'Not a compliance audit store: no immutable retention, authenticated end-user identity or actor audit for local policy changes. A/B are demo application identities. Console JSON logging remains available; IDs are not end-to-end traces.'));
  target.append(audit);

  const behavior = section('Model behavior · measured, not inferred', 'Custom fixed-suite evaluations of synthetic extraction and reconciliation. These are narrow checks, not general quality certification or access to private reasoning.');
  behavior.id = 'monitoring-behavior';
  const rows = behaviorRows(state.evaluations);
  if (rows.length) {
    behavior.append(table(['Workload', 'Model', 'Observed checks', 'Reasoning setting', 'Mean Node RTT'],
      rows.map(row => [row.workload, row.model, row.checks, row.reasoningEffort, available(row.meanRoundTripMs, ' ms')]),
      'Measured fixed-case model behavior'));
    const cases = node('details');
    cases.append(node('summary', 'Inspect saved fixed-case outputs, checks & approval expiry'));
    for (const row of rows) {
      cases.append(node('h4', `${row.workload} · ${row.model}`),
        node('p', row.evaluation ? `Run ${row.evaluation.runId} · completed ${new Date(row.evaluation.completedAt).toLocaleString()} · expires ${new Date(row.evaluation.expiresAt).toLocaleString()} · ${row.evaluation.current ? 'current' : 'not current'}.` : 'No evaluation report.'),
        node('p', row.reason));
      for (const sample of row.samples) {
        cases.append(rawDetails(`${sample.caseId} · ${sample.passed ? 'Passed' : 'Failed'} · ${sample.reason}`, {
          expected: sample.expected, observedSyntheticOutput: sample.observation.response,
          status: sample.observation.status, reportedModel: sample.observation.reportedModel,
          tokens: sample.observation.tokens, nodeRoundTripMs: sample.observation.latencyMs
        }));
      }
    }
    behavior.append(cases);
  } else behavior.append(node('p', state.evaluationError || (state.loading ? 'Loading profile-specific evaluations…' : 'No measured evaluation evidence loaded.')));
  if (state.latest?.gatewayId === state.gatewayId) {
    behavior.append(node('p', `Latest browser response: requested ${state.latest.model}; returned ${state.latest.returnedModel || 'not reported'}; supported output ${state.latest.modelResponse ? 'received' : 'not received'}. Returned reasoning usage: ${available(state.latest.tokens?.reasoning)}. This does not explain the model’s internal reasoning.`));
  }
  behavior.append(node('p', 'Mean timing includes Node, network, gateway and backend; different reasoning settings are not a controlled benchmark. We can explain our routing choice and inspect observed outputs and test failures. Reasoning effort is a request setting; reasoning-token counts are usage metadata, not thoughts or proof of answer correctness. Private chain-of-thought is not exposed. A model-written explanation would be self-reported, not an execution trace.'));
  target.append(behavior);

  const activity = state.native?.activity;
  const management = node('details');
  management.id = 'monitoring-management-audit';
  management.append(node('summary', 'Configuration audit · Azure Activity Log'));
  if (activity) {
    management.append(node('p', `Read-only snapshot queried ${new Date(activity.queriedAt).toLocaleString()}; window starts ${new Date(activity.windowStart).toLocaleString()}. Scanned up to ${activity.scanLimit} resource-group records (${activity.scanned} returned); showing up to 20 matching gateway records. This is a bounded sample, not a complete change history.`),
      table(['Time', 'Operation', 'Status', 'Actor recorded'], activity.events.map(event =>
        [new Date(event.at).toLocaleString(), event.operation, event.status, event.actorRecorded ? 'Yes · view in Azure' : 'Not reported']), 'Azure management audit records'),
      link('Open resource activity log', `https://portal.azure.com/#resource${activity.gatewayResourceId}/eventlogs`),
      rawDetails('Management records & operation correlation IDs', activity));
    if (!activity.events.length) management.append(node('p', 'No matching gateway records in the scanned sample; this does not establish that no changes occurred.'));
  } else management.append(node('p', 'No Azure Activity Log snapshot loaded for this profile. Management audit is separate from runtime request evidence.'));
  management.append(node('p', 'Configuration/identity administration, not inference traffic. Started/Succeeded records can share an operation ID. Azure operation correlation IDs are not our runtime correlation IDs; actor identifiers and full claims are deliberately not copied here.'));
  target.append(management);
}

const selectedRequests = new Map<GatewayId, string>();
export function learningSummary(snapshots: RoutingSnapshot[], event?: RequestEvent) {
  const rows = behaviorRows(snapshots);
  const selected = rows.find(row => row.workloadId === event?.workload && row.publishedName === event?.selectedModel);
  if (selected && event?.evaluationId && selected.evaluation?.runId !== event.evaluationId) return {
    title: 'The approval report has changed',
    text: 'The current report is not the one captured for this request. Its original evaluation ID is retained in the audit evidence.',
    sample: undefined
  };
  const peersPassed = selected && rows.filter(row => row.workloadId === selected.workloadId).length > 1
    && rows.filter(row => row.workloadId === selected.workloadId).every(row => row.samples.length && row.samples.every(sample => sample.passed));
  if (selected?.samples.length) return {
    title: `Saved tests: ${selected.checks.replace('fixed checks', 'passed')}`,
    text: peersPassed ? event?.policy?.id === 'premium-required-reconciliation' && event.workload === 'reconcile-records'
      ? 'Both models passed these checks. Premium was chosen by business policy—not a demonstrated quality win.'
      : 'Both models passed these checks. The lower-cost option met this workload’s tested requirements.'
      : `Evidence for ${selected.workload.toLowerCase()}, not a verdict on this answer.`,
    sample: selected.samples[0]
  };
  if (event && !selected) return {
    title: 'No quality verdict for this request',
    text: 'The saved tests cover extraction and reconciliation on the approved model pair—not this request’s workload or model.',
    sample: undefined
  };
  if (rows.length && rows.every(row => row.samples.length && row.samples.every(sample => sample.passed))) return {
    title: 'No quality winner in these tests',
    text: 'Both models passed the same narrow checks. Cost and business rules decide—not an assumption that premium is better.',
    sample: rows[0].samples[0]
  };
  return { title: 'Quality needs current evidence', text: 'Missing or expired checks are not model failures. Inspect the approval evidence before drawing conclusions.', sample: undefined };
}
export function renderMonitoring(target: HTMLElement, state: MonitoringState, refresh: () => void, portalUrl: string,
  actions?: { standalone: () => void; runWorkload: () => void }) {
  target.replaceChildren();
  const label = (name: string) => {
    const model = state.models.find(model => model.name === name);
    return model ? modelLabel(model) : name;
  };
  const events = state.audit?.gatewayId === state.gatewayId ? state.audit.events : [];
  const selected = events.find(event => event.correlationId === selectedRequests.get(state.gatewayId))
    || events.find(event => event.outcome.kind === 'model-response') || events[0];
  const toolbar = node('div');
  toolbar.className = 'monitoring-toolbar';
  toolbar.append(node('p', 'Follow one request. Understand the choice. Check the evidence.'));
  const refreshButton = node('button', state.loading ? 'Refreshing…' : 'Refresh evidence');
  refreshButton.id = 'monitoring-refresh'; refreshButton.type = 'button'; refreshButton.disabled = state.loading;
  refreshButton.title = 'Reloads saved snapshots and local records; makes no model calls.';
  refreshButton.addEventListener('click', refresh);
  toolbar.append(refreshButton); target.append(toolbar);
  if (state.refreshError) {
    const error = node('p', state.refreshError); error.setAttribute('role', 'alert'); target.append(error);
  }
  if (state.gatewayId === 'apim-v2' && !state.native?.metrics) {
    const notice = node('div');
    notice.className = 'monitoring-profile-notice';
    notice.append(node('span', 'You’re viewing Premium v2. The configured native telemetry is on standalone.'));
    if (actions) {
      const button = node('button', 'View standalone telemetry');
      button.id = 'monitoring-standalone'; button.type = 'button'; button.disabled = state.loading;
      button.addEventListener('click', actions.standalone); notice.append(button);
    }
    target.append(notice);
  }
  if (events.length) {
    const pickerLabel = node('label', 'Inspect a recorded request');
    pickerLabel.className = 'monitoring-request-picker';
    const picker = node('select'); picker.id = 'monitoring-request-picker';
    for (const event of events) {
      const option = node('option', `${new Date(event.recordedAt).toLocaleTimeString()} · ${workloadLabel(event)} · App ${event.application || '?'} · HTTP ${event.status}`);
      option.value = event.correlationId; picker.append(option);
    }
    picker.value = selected!.correlationId;
    picker.addEventListener('change', () => {
      selectedRequests.set(state.gatewayId, picker.value);
      renderMonitoring(target, state, refresh, portalUrl, actions);
      target.querySelector<HTMLSelectElement>('#monitoring-request-picker')?.focus();
    });
    pickerLabel.append(picker); target.append(pickerLabel);
  }
  const story = node('div');
  story.className = 'monitoring-story'; story.id = 'monitoring-story';
  const outcome = section('1 · What happened?', selected ? 'Observed by the local PoC' : 'Start with a real request');
  const outcomeTitle = state.auditError ? 'Request evidence unavailable' : !selected ? 'No request recorded yet'
    : selected.outcome.kind === 'model-response' ? 'Response received'
      : ['timeout', 'cancelled', 'transport-error'].includes(selected.outcome.kind) ? 'Gateway response not confirmed'
        : selected.outcome.kind === 'unsupported-response' ? 'No supported model answer'
      : !selected.outcome.gatewayCallMade ? 'Stopped before the gateway'
        : selected.outcome.enforcementBoundary === 'native-gateway-policy' ? 'Blocked by a verified gateway policy'
          : `Request ended with HTTP ${selected.status}`;
  outcome.append(node('h4', outcomeTitle));
  if (selected) {
    outcome.append(node('p', workloadLabel(selected)));
    outcome.append(node('p', selected.selectedModel
      ? `${label(selected.selectedModel)} · App ${selected.application || '?'}`
      : 'No model was selected.'),
    node('p', !selected.outcome.gatewayCallMade ? 'No upstream call was made.'
      : ['timeout', 'cancelled', 'transport-error'].includes(selected.outcome.kind) ? 'The local call did not complete. Upstream execution is unknown.'
      : selected.outcome.enforcementBoundary === 'unknown-upstream' ? 'The gateway responded; the enforcing component is unknown.'
        : `${available(selected.nodeToGatewayRoundTripMs === null ? null : Number((selected.nodeToGatewayRoundTripMs / 1000).toFixed(2)), ' s round trip')} · ${available(selected.tokens?.total, ' tokens')}`));
    if (selected.estimatedTokenCostUsd !== null) outcome.append(node('p', `$${selected.estimatedTokenCostUsd.toFixed(7)} estimated model cost`));
  } else {
    outcome.append(node('p', state.auditError || 'Run a workload from Architecture, then return here to see its actual outcome.'));
    if (actions) {
      const button = node('button', 'Go to the request');
      button.id = 'monitoring-run-workload'; button.type = 'button';
      button.addEventListener('click', actions.runWorkload); outcome.append(button);
    }
  }
  const why = section('2 · Why this model?', 'Our routing decision—not the model’s thoughts');
  why.append(node('h4', selected?.policy?.label || (selected ? 'Explicit model selection' : 'Approval → rules → cost')));
  const premiumRestriction = selected?.policy?.id === 'premium-required-reconciliation' && selected.workload === 'reconcile-records'
    && selected.exclusions.some(item => item.kinds.includes('business-policy'));
  why.append(node('p', selected?.selectedModel && selected.selectionReason ? premiumRestriction
    ? 'The business rule removed economy from consideration. The lowest-cost approved remaining model was selected.'
    : 'This was the lowest planned token cost among the approved models allowed by the captured policy.'
    : selected?.selectionReason || (selected
    ? 'This request did not use a recorded workload-routing decision.'
    : 'We require workload approval, remove business-ineligible models, then choose the lowest planned token cost.')));
  if (selected?.exclusions.length && !premiumRestriction) why.append(node('p', selected.exclusions.map(item =>
    `${label(item.model)} excluded by ${item.kinds.includes('business-policy') ? 'business policy' : item.kinds.includes('workload-approval') ? 'workload approval' : 'configuration'}.`).join(' ')));
  const lesson = learningSummary(state.evaluations, selected);
  const learning = section('3 · What did we learn?', 'Saved checks of actual model outputs');
  learning.append(node('h4', lesson.title), node('p', state.evaluationError || lesson.text));
  if (lesson.sample) {
    const example = node('details');
    example.className = 'monitoring-checked-example';
    example.append(node('summary', 'See one checked result'),
      node('p', `${lesson.sample.caseId} · ${lesson.sample.passed ? 'Passed' : 'Failed'}: ${lesson.sample.reason}`),
      node('h5', 'Expected'), node('pre', JSON.stringify(lesson.sample.expected, null, 2)),
      node('h5', 'Model returned'), node('pre', lesson.sample.observation.response));
    learning.append(example);
  }
  story.append(outcome, why, learning); target.append(story);
  const coverage = node('div');
  coverage.className = 'monitoring-source-summary';
  coverage.id = 'monitoring-source-summary';
  const metrics = state.native?.metrics;
  const routes = new Set(metrics?.samples.filter(sample => sample.value > 0).map(sample => sample.model));
  const usage = node('div');
  usage.append(node('strong', 'Native gateway shows usage'),
    node('p', metrics ? `Token usage observed across ${routes.size} published routes. Model and token-type breakdowns are available.`
      : 'Native token evidence is not loaded for this profile.'));
  if (metrics) usage.append(node('small', `Snapshot ${new Date(metrics.queriedAt).toLocaleString()} · not this request`));
  if (state.gatewayId === 'ai-gateway' && state.native?.logsQueryUrl) {
    const traces = node('p');
    const queryLink = link('Query gateway traces in Azure Monitor', state.native.logsQueryUrl);
    queryLink.id = 'monitoring-logs-query';
    traces.append(queryLink);
    usage.append(traces, node('small', 'Opens the linked Log Analytics workspace with a seven-day query. Azure sign-in and log access required. Gateway trace IDs are separate from local PoC correlation IDs.'));
  }
  const augmentation = node('div');
  augmentation.append(node('strong', 'This PoC adds the “why”'),
    node('p', 'Workload, policy, exclusions and outcome in one place. Check results help assess behavior; token counts do not reveal private reasoning.'));
  coverage.append(usage, augmentation); target.append(coverage);
  const evidence = node('details');
  evidence.id = 'monitoring-evidence';
  const nativeLabel = state.native?.activity ? ` · ${state.native.activity.events.length} Azure audit records` : '';
  evidence.append(node('summary', `Inspect telemetry & audit evidence${nativeLabel}`));
  const technical = node('div');
  renderMonitoringEvidence(technical, state, portalUrl);
  evidence.append(technical); target.append(evidence);
}
