import type { CallResult, GatewayId } from '../server/gateway.ts';
import type { RoutingRejection, RoutingSnapshot } from '../server/routing.ts';
import type { RequestEvent, RequestOutcome } from '../server/request-evidence.ts';
import type { RoutingPolicy } from '../server/routing-policy.ts';
import { getWorkload } from '../server/workloads.ts';
import type { WorkloadId } from '../server/workloads.ts';

export interface SubmittedRequest {
  readonly gatewayId: GatewayId;
  readonly application: 'A' | 'B';
  readonly workload: WorkloadId | 'manual' | 'governance-proof';
  readonly policyVersion?: string;
}
export interface JourneyError {
  error?: string;
  correlationId?: string;
  decisionId?: string;
  outcome?: RequestOutcome;
  evidence?: RequestEvent;
  rejection?: RoutingRejection;
}
export type JourneyRecord = CallResult | JourneyError;
export interface PolicySnapshot { active: RoutingPolicy; presets: RoutingPolicy[] }

export function policyVersionLabel(version: string): string {
  const match = /:v(\d+):r(\d+)$/.exec(version);
  return match ? `v${match[1]} / r${match[2]}` : version;
}
export function isRoutingJourney(tab: string, architectureView: string): boolean {
  return tab === 'routing' || (tab === 'architecture' && architectureView === 'live');
}
export function routingRequest(snapshot: RoutingSnapshot, gatewayId: GatewayId, app: 'A' | 'B',
  workload: WorkloadId, prompt: string, plannedInputTokens: number) {
  if (snapshot.gatewayId !== gatewayId || snapshot.application !== app || snapshot.workload.id !== workload
    || !snapshot.policy?.version || !snapshot.evaluation?.runId) throw new Error('Reload and review the current workload, policy and profile evidence before sending.');
  return Object.freeze({ gatewayId, app, workload, prompt, plannedInputTokens,
    policyVersion: snapshot.policy.version, priceVersion: snapshot.priceVersion, evaluationId: snapshot.evaluation.runId });
}
export function journeyFacts(record: JourneyRecord, submitted: SubmittedRequest) {
  const decision = 'routing' in record ? record.routing : undefined;
  const rejection = 'rejection' in record ? record.rejection : undefined;
  const event = record.evidence;
  const policy = decision?.policy || rejection?.policy || event?.policy;
  const outcome = record.outcome || event?.outcome;
  const candidates = decision?.candidates || rejection?.candidates || [];
  const exclusions = candidates.flatMap(candidate => (candidate.exclusions || []).map(exclusion =>
    `${candidate.price.label} · ${exclusion.kind} · custom PoC: ${exclusion.reason}`));
  if (!candidates.length) exclusions.push(...(event?.exclusions || []).flatMap(item =>
    item.reasons.map((reason, index) => `${item.model} · ${item.kinds[index] || 'exclusion'} · custom PoC: ${reason}`)));
  const success = outcome?.kind === 'model-response' && outcome.enforcementBoundary === 'none' && outcome.gatewayCallMade;
  const outcomeText = success ? 'Response received through gateway · No rejection'
    : outcome ? `${outcome.kind} · ${outcome.enforcementBoundary} · ${outcome.gatewayCallMade ? 'gateway call attempted' : 'no gateway call'}`
      : 'Outcome provenance unavailable; no native enforcement inferred.';
  return {
    workload: submitted.workload === 'manual' ? 'Manual model request (no workload approval gate)'
      : submitted.workload === 'governance-proof' ? 'Fixed native-governance test'
        : getWorkload(submitted.workload).label,
    policy: policy ? `${policy.label} · ${policy.version} · custom PoC${submitted.policyVersion && submitted.policyVersion !== policy.version
      ? `; submitted version ${submitted.policyVersion} differs—no accepted selection implied` : ''}`
      : submitted.policyVersion ? `Submitted ${submitted.policyVersion}; server policy record unavailable`
        : 'Not a workload selection',
    policyLabel: policy ? `${policy.label} · ${policyVersionLabel(policy.version)}` : 'Not a workload selection',
    exclusions: exclusions.length ? exclusions.join('\n') : candidates.length ? 'None; candidates passed the configured gates.' : 'No candidate decision record.',
    winner: decision ? `${decision.selectedPrice.label} · ${decision.decisiveReason}`
      : rejection ? `No winner · ${rejection.decisiveReason}`
        : event?.selectedModel ? `${event.selectedModel} · explicit/fixed request, not cost selection` : 'No selected model recorded.',
    winnerLabel: outcome?.nativeControl === 'content-safety' ? 'Not executed · native safety stop'
      : decision?.selectedPrice.label || event?.selectedModel || 'No winner',
    reason: decision?.decisiveReason || rejection?.decisiveReason,
    exclusionSummary: candidates.some(candidate => !candidate.eligible)
      ? candidates.filter(candidate => !candidate.eligible).map(candidate => `${candidate.price.label}: ${
        candidate.exclusions?.map(item => ({ configuration: 'not configured', 'workload-approval': 'not approved', 'business-policy': 'business restriction' })[item.kind]).join(', ') || candidate.reason}`).join('; ')
      : exclusions.length ? exclusions.join('; ') : candidates.length ? 'None' : 'No candidate decision',
    outcome: outcomeText,
    outcomeLabel: success ? outcomeText
      : outcome?.nativeControl === 'content-safety' ? 'Blocked by native Content Safety at gateway'
        : outcome?.enforcementBoundary === 'native-gateway-policy' ? 'Rejected at gateway'
        : outcome && !outcome.gatewayCallMade ? 'Stopped by PoC'
          : outcome?.kind === 'timeout' ? 'Request timed out'
            : outcome?.kind === 'cancelled' ? 'Request cancelled'
              : outcome ? 'Error · origin unconfirmed' : 'Outcome unconfirmed',
    recovery: outcome?.recovery,
    correlationId: record.correlationId || event?.correlationId,
    decisionId: decision?.decisionId || rejection?.decisionId || record.decisionId || event?.decisionId
  };
}
export function renderActualJourney(target: HTMLElement, record: JourneyRecord, submitted: SubmittedRequest) {
  const facts = journeyFacts(record, submitted);
  const section = document.createElement('section');
  section.id = 'actual-journey';
  section.className = 'actual-journey';
  section.setAttribute('aria-label', 'Actual immutable request journey');
  const title = document.createElement('h3');
  title.textContent = 'Actual result';
  const list = document.createElement('dl');
  for (const [label, value] of [
    ['Workload', facts.workload], ['Policy · custom PoC', facts.policyLabel],
    ['Selected model', facts.winnerLabel], ['Outcome', facts.outcomeLabel]
  ]) {
    const term = document.createElement('dt'), description = document.createElement('dd');
    term.textContent = label; description.textContent = value;
    list.append(term, description);
  }
  section.append(title, list);
  const exclusions = document.createElement('p');
  exclusions.className = 'journey-exclusions';
  exclusions.textContent = `Exclusions: ${facts.exclusionSummary}`;
  section.append(exclusions);
  if (facts.reason) {
    const reason = document.createElement('p');
    reason.className = 'journey-reason';
    reason.textContent = facts.reason;
    section.append(reason);
  }
  if (facts.recovery) {
    const recovery = document.createElement('p');
    recovery.className = 'outcome-recovery';
    recovery.textContent = `Recovery: ${facts.recovery}`;
    section.append(recovery);
  }
  const correlation = document.createElement('p');
  correlation.className = 'request-correlation';
  correlation.textContent = `Correlation: ${facts.correlationId || 'unavailable'} · Decision: ${facts.decisionId || 'unavailable'}. Local event/header propagation only—not distributed tracing or current-request gateway telemetry.`;
  const evidence = document.createElement('details');
  evidence.id = 'request-evidence';
  const summary = document.createElement('summary');
  summary.textContent = 'Evidence · IDs, decision & scope';
  const scope = document.createElement('p');
  scope.textContent = `Policy: ${facts.policy}\n${facts.outcome}\nExclusions: ${facts.exclusions}`;
  const raw = document.createElement('pre');
  raw.textContent = record.evidence ? JSON.stringify(record.evidence, null, 2) : 'Structured outcome event unavailable.';
  evidence.append(summary, correlation, scope, raw);
  section.append(evidence);
  target.append(section);
}
