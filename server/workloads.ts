export type WorkloadId = 'extract-record' | 'reconcile-records' | 'external-publication';
export interface EvaluationCase { id: string; input: string; expected: unknown }
export interface Workload {
  id: WorkloadId;
  label: string;
  requirement: string;
  instructions: string;
  maxOutputTokens: number;
  cases: EvaluationCase[];
  exampleInput: string;
}
interface Event { id: string; revision: number; source: 'authoritative' | 'replica'; status: 'queued' | 'ready' | 'cancelled'; voided: boolean }
function reconciliationCase(id: string, events: Event[]): EvaluationCase {
  const priorities = { queued: 0, ready: 1, cancelled: 2 };
  const ids = [...new Set(events.map(event => event.id))].sort();
  const records = ids.flatMap(id => {
    const valid = events.filter(event => event.id === id && !event.voided);
    const authoritative = valid.filter(event => event.source === 'authoritative');
    const eligible = authoritative.length ? authoritative : valid;
    const chosen = eligible.sort((a, b) => b.revision - a.revision || priorities[b.status] - priorities[a.status])[0];
    return chosen ? [{ id, status: chosen.status }] : [];
  });
  return { id, input: JSON.stringify({ events }), expected: { records } };
}
const reconciliationCases = [
  reconciliationCase('source-precedence', [
    { id: 'SYN-02', revision: 99, source: 'replica', status: 'cancelled', voided: false },
    { id: 'SYN-01', revision: 3, source: 'authoritative', status: 'ready', voided: false },
    { id: 'SYN-02', revision: 1, source: 'authoritative', status: 'queued', voided: false },
    { id: 'SYN-01', revision: 8, source: 'replica', status: 'queued', voided: false }
  ]),
  reconciliationCase('voided-and-fallback', [
    { id: 'SYN-03', revision: 8, source: 'authoritative', status: 'cancelled', voided: true },
    { id: 'SYN-03', revision: 2, source: 'replica', status: 'ready', voided: false },
    { id: 'SYN-01', revision: 1, source: 'authoritative', status: 'queued', voided: false },
    { id: 'SYN-01', revision: 2, source: 'authoritative', status: 'ready', voided: false },
    { id: 'SYN-02', revision: 5, source: 'replica', status: 'cancelled', voided: true }
  ]),
  reconciliationCase('ties-and-order', [
    { id: 'SYN-04', revision: 5, source: 'authoritative', status: 'queued', voided: false },
    { id: 'SYN-04', revision: 5, source: 'authoritative', status: 'ready', voided: false },
    { id: 'SYN-04', revision: 5, source: 'authoritative', status: 'cancelled', voided: false },
    { id: 'SYN-02', revision: 4, source: 'replica', status: 'queued', voided: false },
    { id: 'SYN-02', revision: 3, source: 'replica', status: 'cancelled', voided: false },
    { id: 'SYN-01', revision: 9, source: 'authoritative', status: 'cancelled', voided: true },
    { id: 'SYN-01', revision: 2, source: 'authoritative', status: 'ready', voided: false },
    { id: 'SYN-01', revision: 9, source: 'replica', status: 'cancelled', voided: false }
  ])
];
export const workloads: readonly Workload[] = [
  {
    id: 'extract-record', label: 'Extract record fields',
    requirement: 'Exact JSON fields from labeled synthetic data; all 3 fixed checks must pass.',
    instructions: 'Extract only the labeled id, team and status fields. Ignore notes. Missing fields must be null. Preserve field values exactly. Return one JSON object with exactly the keys id, team, status, without Markdown or extra text.',
    maxOutputTokens: 256,
    cases: [
      { id: 'labeled-fields', input: 'id: SYN-101\nteam: north\nstatus: queued\nnote: synthetic record only', expected: { id: 'SYN-101', team: 'north', status: 'queued' } },
      { id: 'ignore-notes', input: 'status: ready\nnote: old team was west; old status was queued\nteam: east\nid: SYN-102', expected: { id: 'SYN-102', team: 'east', status: 'ready' } },
      { id: 'missing-field', input: 'id: SYN-103\nstatus: cancelled\nnote: no team is recorded', expected: { id: 'SYN-103', team: null, status: 'cancelled' } }
    ],
    exampleInput: 'id: SYN-101\nteam: north\nstatus: queued\nnote: synthetic record only'
  },
  {
    id: 'reconcile-records', label: 'Reconcile conflicting records',
    requirement: 'Apply source precedence, voided-event exclusion, revision and tie rules; all 3 fixed checks must pass.',
    instructions: 'Reconcile the synthetic events. Ignore voided events. For each id, use non-voided authoritative events if any exist; otherwise use non-voided replica events. Select the highest revision within that eligible source. At equal revision use status precedence cancelled > ready > queued. Omit ids with no valid events. Return exactly {"records":[{"id":"...","status":"..."}]} with records sorted by id ascending, no extra keys, Markdown or text.',
    maxOutputTokens: 512,
    cases: reconciliationCases,
    exampleInput: reconciliationCases[2].input
  },
  {
    id: 'external-publication', label: 'External publication · not evaluated',
    requirement: 'No approved evaluation exists for this workload. Refuse before a model call.',
    instructions: '', maxOutputTokens: 256, cases: [],
    exampleInput: 'Draft an external report from this synthetic record: SYN-101 is queued.'
  }
];
export function isWorkloadId(value: unknown): value is WorkloadId {
  return workloads.some(workload => workload.id === value);
}
export function getWorkload(id: WorkloadId): Workload {
  const workload = workloads.find(workload => workload.id === id);
  if (!workload) throw new Error('Unknown workload.');
  return workload;
}
export function workloadPrompt(workload: Workload, input: string): string {
  return `${workload.instructions}\n\nSynthetic input data:\n${input}`;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${JSON.stringify(key)}:${canonical(value)}`).join(',')}}`;
  return JSON.stringify(value);
}
export function checkOutput(text: string, expected: unknown): { passed: boolean; reason: string } {
  let value: unknown;
  try { value = JSON.parse(text); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { passed: false, reason: 'Response is not a standalone JSON value.' };
  }
  return canonical(value) === canonical(expected)
    ? { passed: true, reason: 'Exact expected JSON values, keys and array order.' }
    : { passed: false, reason: 'JSON differs from the expected values, keys or array order.' };
}
