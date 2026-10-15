import type { RoutingSnapshot } from '../server/routing.ts';

const caseLabels: Record<string, string> = {
  'labeled-fields': 'Extract exact fields',
  'ignore-notes': 'Ignore misleading notes',
  'missing-field': 'Missing field becomes null',
  'source-precedence': 'Authoritative source wins',
  'voided-and-fallback': 'Ignore voided; use fallback',
  'ties-and-order': 'Resolve ties; sort records'
};

export function workloadAssessment(snapshot: RoutingSnapshot) {
  return snapshot.workload.cases.map(test => ({
    id: test.id,
    label: caseLabels[test.id] || test.id,
    input: test.input,
    expected: test.expected,
    models: snapshot.candidates.map(candidate => {
      const sample = candidate.approval.samples.find(sample => sample.caseId === test.id);
      return {
        label: candidate.price.label,
        version: candidate.price.reportedModel,
        reasoningEffort: candidate.price.reasoningEffort,
        outcome: sample ? sample.passed ? 'Pass' : 'Fail' : 'Not assessed',
        reason: sample?.reason || candidate.approval.reason,
        response: sample?.observation.response,
        status: sample?.observation.status
      };
    })
  }));
}
