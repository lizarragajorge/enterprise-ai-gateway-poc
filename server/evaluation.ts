import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import type { CallResult, Config, GatewayId, GatewayType } from './gateway.ts';
import type { ModelPrice } from './model-pricing.ts';
import { modelPrices } from './model-pricing.ts';
import { checkOutput, getWorkload, workloads } from './workloads.ts';
import type { WorkloadId } from './workloads.ts';

export const EVALUATION_FILE = '.local/workload-evaluation.json';
export function evaluationFile(id: GatewayId) {
  return id === 'ai-gateway' ? EVALUATION_FILE : '.local/apim-v2-workload-evaluation.json';
}
export function evaluationBinding(config: Config): string {
  return createHash('sha256').update(JSON.stringify({
    origin: config.origin, authHeader: config.authHeader || 'api-key', models: config.models
  })).digest('hex');
}
export function profileEvaluation(config: Config, report: EvaluationReport | undefined): EvaluationReport | undefined {
  if (!report) return undefined;
  const id = config.gatewayId || 'ai-gateway';
  if (!report.gatewayId) return id === 'ai-gateway' && !report.configBinding ? report : undefined;
  return report.gatewayId === id && report.gatewayType === (config.gatewayType || 'standalone-ai-gateway')
    && report.configBinding === evaluationBinding(config) ? report : undefined;
}
export const EVALUATION_TTL_MS = 24 * 60 * 60 * 1000;
export const SUITE_VERSION = createHash('sha256').update(JSON.stringify({ workloads, modelPrices: modelPrices.map(price => ({
  publishedName: price.publishedName, reportedModel: price.reportedModel, reasoningEffort: price.reasoningEffort
})) })).digest('hex').slice(0, 16);
export interface EvaluationSample {
  caseId: string;
  source: CallResult['source'];
  status: number;
  reportedModel?: string;
  modelResponse: boolean;
  response: string;
  latencyMs: number;
  tokens: CallResult['tokens'];
}
export interface ModelEvaluation {
  workload: WorkloadId;
  publishedName: string;
  reportedModel: string;
  reasoningEffort: ModelPrice['reasoningEffort'];
  maxOutputTokens: number;
  samples: EvaluationSample[];
}
export interface EvaluationReport {
  gatewayId?: GatewayId;
  gatewayType?: GatewayType;
  configBinding?: string;
  runId: string;
  suiteVersion: string;
  startedAt: string;
  completedAt: string;
  evaluations: ModelEvaluation[];
}
export interface Approval {
  approved: boolean;
  passed: number;
  total: number;
  reason: string;
  samples: { caseId: string; passed: boolean; reason: string; observation: EvaluationSample; expected: unknown }[];
}
export function readEvaluation(path = EVALUATION_FILE): EvaluationReport | undefined {
  let text: string;
  try {
    if (statSync(path).size > 1024 * 1024) throw new Error('Evaluation report exceeds the 1 MiB limit.');
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object') throw new Error('Invalid evaluation report.');
  const report = value as Partial<EvaluationReport>;
  if (report.gatewayId !== undefined && (!['ai-gateway', 'apim-v2'].includes(report.gatewayId)
    || typeof report.configBinding !== 'string' || !/^[a-f0-9]{64}$/.test(report.configBinding)
    || report.gatewayType !== (report.gatewayId === 'apim-v2' ? 'apim-premium-v2' : 'standalone-ai-gateway'))) {
    throw new Error('Invalid evaluation profile provenance.');
  }
  if (typeof report.runId !== 'string' || !report.runId || typeof report.suiteVersion !== 'string'
    || typeof report.startedAt !== 'string' || !Number.isFinite(Date.parse(report.startedAt))
    || typeof report.completedAt !== 'string' || !Number.isFinite(Date.parse(report.completedAt))
    || Date.parse(report.startedAt) > Date.parse(report.completedAt) || !Array.isArray(report.evaluations)) {
    throw new Error('Invalid evaluation report metadata.');
  }
  for (const evaluation of report.evaluations) {
    if (!evaluation || typeof evaluation !== 'object' || typeof evaluation.workload !== 'string'
      || typeof evaluation.publishedName !== 'string' || typeof evaluation.reportedModel !== 'string'
      || !['none', 'low'].includes(evaluation.reasoningEffort) || !Number.isInteger(evaluation.maxOutputTokens)
      || !Array.isArray(evaluation.samples)) throw new Error('Invalid model evaluation.');
    for (const sample of evaluation.samples) {
      if (!sample || typeof sample !== 'object' || typeof sample.caseId !== 'string'
        || !['gateway-response', 'local-error'].includes(sample.source) || !Number.isInteger(sample.status)
        || typeof sample.response !== 'string' || typeof sample.modelResponse !== 'boolean'
        || !Number.isFinite(sample.latencyMs) || sample.latencyMs < 0
        || (sample.reportedModel !== undefined && typeof sample.reportedModel !== 'string')) {
        throw new Error('Invalid evaluation sample.');
      }
    }
  }
  return report as EvaluationReport;
}
export function evaluationCurrent(report: EvaluationReport | undefined, now: number): boolean {
  if (!report || report.suiteVersion !== SUITE_VERSION) return false;
  const completed = Date.parse(report.completedAt);
  return Number.isFinite(completed) && completed <= now && now - completed < EVALUATION_TTL_MS;
}
export function approval(report: EvaluationReport | undefined, workloadId: WorkloadId, price: ModelPrice, now: number): Approval {
  const workload = getWorkload(workloadId);
  const absent = (reason: string): Approval => ({ approved: false, passed: 0, total: workload.cases.length, reason, samples: [] });
  if (!workload.cases.length) return absent('No evaluated approval exists for this workload.');
  if (!evaluationCurrent(report, now)) return absent('Evaluation missing, changed or expired. Run the fixed suite; no model is assumed capable.');
  const matches = report!.evaluations.filter(item => item.workload === workloadId && item.publishedName === price.publishedName);
  if (matches.length !== 1) return absent('Missing or duplicate model/workload evaluation.');
  const evaluation = matches[0];
  if (evaluation.reportedModel !== price.reportedModel || evaluation.reasoningEffort !== price.reasoningEffort
    || evaluation.maxOutputTokens !== workload.maxOutputTokens) return absent('Evaluated model version or generation settings differ.');
  if (evaluation.samples.length !== workload.cases.length
    || new Set(evaluation.samples.map(sample => sample.caseId)).size !== workload.cases.length
    || evaluation.samples.some(sample => !workload.cases.some(test => test.id === sample.caseId))) {
    return absent('Evaluation does not cover exactly the fixed cases.');
  }
  const samples = workload.cases.map(test => {
    const sample = evaluation.samples.find(sample => sample.caseId === test.id)!;
    const checked = sample.source !== 'gateway-response' || sample.status !== 200 || !sample.modelResponse
      ? { passed: false, reason: `No supported model response (HTTP ${sample.status}); not a quality verdict.` }
      : sample.reportedModel !== price.reportedModel
        ? { passed: false, reason: 'Reported model does not match the pinned evaluated version.' }
        : checkOutput(sample.response, test.expected);
    return { caseId: test.id, ...checked, observation: sample, expected: test.expected };
  });
  const passed = samples.filter(sample => sample.passed).length;
  return { approved: passed === workload.cases.length, passed, total: workload.cases.length, samples,
    reason: passed === workload.cases.length ? `${passed}/${workload.cases.length} fixed checks passed with matching model/settings.`
      : `${passed}/${workload.cases.length} fixed checks passed; excluded. Inspect failures, not an invented quality score.` };
}
