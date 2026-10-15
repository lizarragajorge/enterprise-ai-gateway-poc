import type { EvaluationReport } from './evaluation.ts';
import { SUITE_VERSION } from './evaluation.ts';
import { modelPrices } from './model-pricing.ts';
import { workloads } from './workloads.ts';

export function evaluationFixture(): EvaluationReport {
  return {
    runId: 'synthetic-unit-test-run', suiteVersion: SUITE_VERSION,
    startedAt: '2026-10-12T00:00:00Z', completedAt: '2026-10-12T00:00:00Z',
    evaluations: workloads.filter(workload => workload.cases.length).flatMap(workload => modelPrices.map(price => ({
      workload: workload.id, publishedName: price.publishedName, reportedModel: price.reportedModel,
      reasoningEffort: price.reasoningEffort, maxOutputTokens: workload.maxOutputTokens,
      samples: workload.cases.map(test => ({
        caseId: test.id, source: 'gateway-response' as const, status: 200, reportedModel: price.reportedModel,
        modelResponse: true, response: JSON.stringify(test.expected), latencyMs: 1, tokens: null
      }))
    })))
  };
}
