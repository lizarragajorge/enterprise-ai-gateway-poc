import { randomUUID } from 'node:crypto';
import { callGateway, validateInput } from './gateway.ts';
import type { AppId, CallInput, CallResult, Config, GatewayId, GatewayType } from './gateway.ts';
import { modelPrices, PRICE_REVIEWED_AT, PRICE_SOURCE, PRICE_VALID_UNTIL, PRICE_VERSION, pricedUsage, tokenCost } from './model-pricing.ts';
import type { ModelPrice } from './model-pricing.ts';
import { approval, evaluationCurrent, EVALUATION_TTL_MS, profileEvaluation } from './evaluation.ts';
import type { Approval, EvaluationReport } from './evaluation.ts';
import { getWorkload, isWorkloadId, workloadPrompt } from './workloads.ts';
import type { Workload, WorkloadId } from './workloads.ts';
import { preferredCostCandidate } from './model-selection.ts';
import { businessExclusion, RoutingPolicyStore } from './routing-policy.ts';
import type { CandidateExclusion, RoutingPolicy } from './routing-policy.ts';
import type { BoundaryContext } from './request-evidence.ts';
export { preferredCostCandidate } from './model-selection.ts';

export interface CostInput {
  app: AppId;
  prompt: string;
  workload: WorkloadId;
  plannedInputTokens: number;
  priceVersion: string;
  evaluationId: string;
  policyVersion?: string;
}
export interface RoutingCandidate {
  modelId?: string;
  price: ModelPrice;
  eligible: boolean;
  reason: string;
  plannedCostUsd: number;
  approval: Approval;
  exclusions?: CandidateExclusion[];
}
export interface RoutingSnapshot {
  gatewayId?: GatewayId;
  gatewayType?: GatewayType;
  application: AppId;
  ready: boolean;
  busy: boolean;
  priceVersion: string;
  priceReviewedAt: string;
  priceValidUntil: string;
  priceSource: string;
  pricesCurrent: boolean;
  candidates: RoutingCandidate[];
  workload: Workload;
  policy?: RoutingPolicy;
  evaluation?: { runId: string; suiteVersion: string; completedAt: string; expiresAt: string; current: boolean };
}
export interface RoutingDecision {
  correlationId?: string;
  gatewayId?: GatewayId;
  gatewayType?: GatewayType;
  owner: 'local-node-backend';
  strategy: 'lowest-cost-approved-workload';
  decisionId: string;
  application: AppId;
  selectedModelId: string;
  selectedPrice: ModelPrice;
  workload: WorkloadId;
  requirement: string;
  evaluationId: string;
  plannedInputTokens: number;
  maxOutputTokens: number;
  plannedCostUsd: number;
  decidedAt: string;
  priceVersion: string;
  priceSource: string;
  candidates: RoutingCandidate[];
  policy: RoutingPolicy;
  decisiveReason: string;
  usageCostUsd: number | null;
  usageCostUnavailableReason?: string;
}
export interface RoutingRejection {
  correlationId?: string;
  gatewayId?: GatewayId;
  gatewayType?: GatewayType;
  owner: 'local-node-backend';
  workload: WorkloadId;
  decisionId: string;
  evaluationId: string;
  decidedAt: string;
  gatewayCallMade: false;
  candidates: RoutingCandidate[];
  policy: RoutingPolicy;
  decisiveReason: string;
}
export class RoutingError extends Error {
  status: number;
  rejection?: RoutingRejection;
  result?: CallResult;
  constructor(status: number, message: string, rejection?: RoutingRejection, result?: CallResult) {
    super(message);
    this.status = status;
    this.name = 'RoutingError';
    this.rejection = rejection;
    this.result = result;
  }
}
export function validateCostInput(value: unknown, config: Config): CostInput {
  if (!value || typeof value !== 'object') throw new Error('Expected a JSON request object.');
  const input = value as Record<string, unknown>;
  if ('modelId' in input) throw new Error('Automatic cost routing does not accept a client-selected model.');
  if ('policy' in input || 'maxOutputTokens' in input) throw new Error('Submit a workload, not a premium policy or a generation override.');
  if (!isWorkloadId(input.workload)) throw new Error('Select a supported workload.');
  if (!Number.isInteger(input.plannedInputTokens) || Number(input.plannedInputTokens) < 1 || Number(input.plannedInputTokens) > 128000) {
    throw new Error('Planned input must be an integer from 1 to 128000 tokens.');
  }
  if (typeof input.priceVersion !== 'string' || !input.priceVersion || input.priceVersion.length > 100) {
    throw new Error('Include the reviewed price version.');
  }
  if (typeof input.evaluationId !== 'string' || !input.evaluationId || input.evaluationId.length > 100) throw new Error('Include the reviewed evaluation run ID.');
  if (input.policyVersion !== undefined && (typeof input.policyVersion !== 'string' || !input.policyVersion || input.policyVersion.length > 150)) {
    throw new Error('Routing policy version must be a nonempty string of at most 150 characters.');
  }
  if (typeof input.prompt !== 'string' || !input.prompt.trim()) throw new Error('Provide synthetic input data.');
  const call = validateInput({ app: input.app, prompt: workloadPrompt(getWorkload(input.workload), input.prompt), modelId: config.models[0]?.id }, config);
  return {
    app: call.app, prompt: input.prompt, workload: input.workload,
    plannedInputTokens: Number(input.plannedInputTokens), priceVersion: input.priceVersion, evaluationId: input.evaluationId,
    ...(typeof input.policyVersion === 'string' ? { policyVersion: input.policyVersion } : {})
  };
}
export function costCandidates(config: Config, workload: Workload, plannedInputTokens: number, report: EvaluationReport | undefined, now: number,
  policy: RoutingPolicy = new RoutingPolicyStore().current()): RoutingCandidate[] {
  report = profileEvaluation(config, report);
  return modelPrices.map(price => {
    const model = config.models.find(model => model.name === price.publishedName && model.format === 'openai-chat'
      && model.cloud === 'azure' && (!model.provider || model.provider === 'foundry') && model.reasoningEffort === price.reasoningEffort);
    const measured = approval(report, workload.id, price, now);
    const exclusions: CandidateExclusion[] = [];
    if (!model) exclusions.push({ boundary: 'custom-poc', kind: 'configuration',
      reason: `Current alias with OpenAI chat and verified reasoning effort ${price.reasoningEffort} is not configured; no callable target.` });
    if (!measured.approved) exclusions.push({ boundary: 'custom-poc', kind: 'workload-approval', reason: measured.reason });
    const restriction = businessExclusion(policy, workload.id, price);
    if (restriction) exclusions.push(restriction);
    return {
      modelId: model?.id, price, eligible: exclusions.length === 0, approval: measured, exclusions,
      reason: exclusions.length ? exclusions.map(item => item.reason).join(' ') : measured.reason,
      plannedCostUsd: tokenCost(price, plannedInputTokens, workload.maxOutputTokens)
    };
  });
}
type Caller = (input: CallInput, maxOutputTokens: number, signal?: AbortSignal, correlationId?: string) => Promise<CallResult>;
export class CostRouter {
  private busy = new Set<AppId>();
  private config: Config;
  private caller: Caller;
  private clock: () => number;
  private report?: EvaluationReport;
  private policies: RoutingPolicyStore;
  constructor(config: Config, caller?: Caller, clock = Date.now, report?: EvaluationReport, policies = new RoutingPolicyStore()) {
    this.config = config;
    this.clock = clock;
    this.report = profileEvaluation(config, report);
    this.policies = policies;
    this.caller = caller || ((input, maxOutputTokens, signal, correlationId) => callGateway(config, input, fetch, { maxCompletionTokens: maxOutputTokens, signal, correlationId }));
  }
  reloadEvaluation(report: EvaluationReport | undefined): void {
    this.report = profileEvaluation(this.config, report);
  }
  snapshot(app: AppId, workloadId: WorkloadId = 'extract-record', policy = this.policies.current()): RoutingSnapshot {
    const pricesCurrent = this.clock() < Date.parse(PRICE_VALID_UNTIL);
    const workload = getWorkload(workloadId);
    const candidates = costCandidates(this.config, workload, 1000, this.report, this.clock(), policy);
    return {
      gatewayId: this.config.gatewayId || 'ai-gateway', gatewayType: this.config.gatewayType || 'standalone-ai-gateway',
      application: app, ready: Boolean(this.config.origin && this.config.keys[app] && pricesCurrent
        && candidates.every(candidate => candidate.modelId) && evaluationCurrent(this.report, this.clock())),
      busy: this.busy.has(app), priceVersion: PRICE_VERSION, priceReviewedAt: PRICE_REVIEWED_AT,
      priceValidUntil: PRICE_VALID_UNTIL, priceSource: PRICE_SOURCE, pricesCurrent, candidates, workload, policy,
      ...(this.report ? { evaluation: { runId: this.report.runId, suiteVersion: this.report.suiteVersion, completedAt: this.report.completedAt,
        expiresAt: new Date(Date.parse(this.report.completedAt) + EVALUATION_TTL_MS).toISOString(),
        current: evaluationCurrent(this.report, this.clock()) } } : {})
    };
  }
  async route(input: CostInput, signal?: AbortSignal, context?: BoundaryContext): Promise<CallResult> {
    const policy = context?.policy || this.policies.current();
    const correlationId = context?.correlationId || randomUUID();
    const decisionId = context?.decisionId || randomUUID();
    const state = this.snapshot(input.app, input.workload, policy);
    const candidates = costCandidates(this.config, state.workload, input.plannedInputTokens, this.report, this.clock(), policy);
    const reject = (status: number, message: string): never => {
      throw new RoutingError(status, message, {
        gatewayId: this.config.gatewayId || 'ai-gateway', gatewayType: this.config.gatewayType || 'standalone-ai-gateway',
        owner: 'local-node-backend', workload: input.workload, decisionId, correlationId, evaluationId: input.evaluationId,
        decidedAt: new Date(this.clock()).toISOString(), gatewayCallMade: false, candidates, policy, decisiveReason: message
      });
    };
    if (input.policyVersion !== undefined && input.policyVersion !== policy.version) reject(409, 'Routing policy changed. Reload the current policy before sending; no gateway call made.');
    if (!state.pricesCurrent) reject(409, 'Price review expired. Update verified prices before routing.');
    if (input.priceVersion !== state.priceVersion) reject(409, 'Price version changed. Reload and review prices before sending.');
    if (!evaluationCurrent(this.report, this.clock())) reject(409, 'Workload evaluation missing, changed or expired. Run evaluate:routing and reload evidence; no gateway call made.');
    if (input.evaluationId !== this.report?.runId) reject(409, 'Evaluation changed. Reload and review the current run before sending; no gateway call made.');
    if (!state.ready) reject(503, 'Configure both actual cost-comparison models and this application runtime key. No model is simulated.');
    if (this.busy.has(input.app)) reject(409, 'This application already has a routed request in progress.');
    if (signal?.aborted) reject(499, 'Routed request cancelled.');
    const selected = preferredCostCandidate(candidates);
    if (!selected?.modelId) throw new RoutingError(409, 'No approved model satisfies this workload. No gateway call made.', {
      gatewayId: this.config.gatewayId || 'ai-gateway', gatewayType: this.config.gatewayType || 'standalone-ai-gateway',
      owner: 'local-node-backend', workload: input.workload, decisionId, correlationId, evaluationId: input.evaluationId,
      decidedAt: new Date(this.clock()).toISOString(), gatewayCallMade: false, candidates, policy,
      decisiveReason: 'No candidate satisfies configuration, current workload approval and the selected business policy.'
    });
    const decision: RoutingDecision = {
      gatewayId: this.config.gatewayId || 'ai-gateway', gatewayType: this.config.gatewayType || 'standalone-ai-gateway',
      owner: 'local-node-backend', strategy: 'lowest-cost-approved-workload',
      decisionId, correlationId, application: input.app, selectedModelId: selected.modelId,
      selectedPrice: selected.price, workload: input.workload, requirement: state.workload.requirement,
      evaluationId: input.evaluationId, plannedInputTokens: input.plannedInputTokens,
      maxOutputTokens: state.workload.maxOutputTokens, plannedCostUsd: selected.plannedCostUsd,
      decidedAt: new Date(this.clock()).toISOString(), priceVersion: PRICE_VERSION, priceSource: PRICE_SOURCE,
      candidates, policy, decisiveReason: `${selected.price.label} is the lowest planned token cost among ${candidates.filter(candidate => candidate.eligible).length} approved, business-policy-eligible candidate(s).${candidates.some(candidate => candidate.exclusions?.some(item => item.kind === 'business-policy')) ? ' Economy is excluded by the reconciliation business restriction, not a quality failure.' : ''}`,
      usageCostUsd: null
    };
    this.busy.add(input.app);
    try {
      const result = await this.caller({ app: input.app, modelId: selected.modelId, prompt: workloadPrompt(state.workload, input.prompt) }, state.workload.maxOutputTokens, signal, correlationId);
      const usage = pricedUsage(result, selected.price);
      decision.usageCostUsd = usage.costUsd;
      if (usage.unavailableReason) decision.usageCostUnavailableReason = usage.unavailableReason;
      if (signal?.aborted) throw new RoutingError(499, 'Routed request cancelled.', undefined, { ...result, correlationId, decisionId, routing: decision });
      return { ...result, correlationId, decisionId, routing: decision };
    } finally { this.busy.delete(input.app); }
  }
}
