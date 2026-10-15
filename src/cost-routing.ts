import type { RoutingSnapshot } from '../server/routing.ts';
import { tokenCost } from '../server/model-pricing.ts';
import { explainRoutingChoice } from './routing-explanation.ts';
import { workloadAssessment } from './model-assessment.ts';

export function usd(value: number): string {
  return `$${value.toFixed(8)}`;
}
export function estimatedCostLabel(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? `${usd(value)} USD` : 'Unavailable, not zero';
}
export function renderCostRouting(target: HTMLElement, state: {
  snapshot?: RoutingSnapshot; busy: boolean; loading: boolean; error?: string;
  plannedInputTokens: number;
  reloadPending?: boolean; reloadStatus?: string; onReload?: () => void;
}) {
  const expanded = target.querySelector<HTMLDetailsElement>('.routing-evidence')?.open || false;
  const assessmentExpanded = target.querySelector<HTMLDetailsElement>('.selector-assessment')?.open || false;
  target.replaceChildren();
  const heading = document.createElement('h3');
  heading.textContent = 'Expected preview · custom PoC selection';
  const intro = document.createElement('ol');
  intro.className = 'routing-principle';
  intro.setAttribute('aria-label', 'Selection rules, not observed gateway spans');
  for (const text of ['Declare workload + versioned policy', 'Require approval + business eligibility', 'Choose lowest eligible cost → gateway dispatch']) {
    const step = document.createElement('li');
    step.textContent = text;
    intro.append(step);
  }
  const status = document.createElement('p');
  status.id = 'routing-status';
  status.setAttribute('role', state.error ? 'alert' : 'status');
  status.textContent = state.error || (state.loading ? 'Loading evaluation…'
    : state.busy ? 'Calling the selected model…'
      : !state.snapshot?.pricesCurrent ? 'Price review unavailable or expired.'
        : !state.snapshot.policy ? 'Live routing policy unavailable.'
        : !state.snapshot.evaluation?.current ? 'Evaluation needed: run evaluate:routing for this profile, then Reload evidence.'
          : !state.snapshot.ready ? 'Model or application configuration incomplete.'
            : !state.snapshot.candidates.some(candidate => candidate.eligible) ? 'No eligible model after custom PoC gates.'
              : 'Ready · model selected automatically');
  const comparison = document.createElement('table');
  comparison.className = 'routing-comparison';
  comparison.setAttribute('aria-label', 'Model eligibility and planned token costs');
  const head = document.createElement('thead');
  const headerRow = document.createElement('tr');
  for (const label of ['Model', 'Measured checks', 'Elimination / selection reason', 'Planned USD']) {
    const cell = document.createElement('th');
    cell.scope = 'col';
    cell.textContent = label;
    headerRow.append(cell);
  }
  head.append(headerRow);
  const body = document.createElement('tbody');
  const validPlan = Number.isInteger(state.plannedInputTokens) && state.plannedInputTokens > 0 && state.plannedInputTokens <= 128000;
  const cap = state.snapshot?.workload.maxOutputTokens || 256;
  const candidates = (state.snapshot?.candidates || []).map(candidate => ({
    ...candidate, plannedCostUsd: validPlan ? tokenCost(candidate.price, state.plannedInputTokens, cap) : candidate.plannedCostUsd
  }));
  const explanation = explainRoutingChoice(candidates);
  const canPreview = validPlan && !state.loading && !state.error && Boolean(state.snapshot?.ready && state.snapshot.policy);
  if (canPreview && !explanation.selected) intro.lastElementChild!.textContent = 'Refuse locally · no gateway call';
  status.hidden = !state.loading && !state.busy && !state.error && Boolean(state.snapshot?.ready && explanation.selected);
  for (const candidate of candidates) {
    const item = document.createElement('tr');
    const preferred = canPreview && explanation.selected?.price.publishedName === candidate.price.publishedName;
    item.dataset.modelId = candidate.modelId || 'unconfigured';
    item.dataset.preferred = String(preferred);
    item.dataset.approved = String(candidate.eligible);
    const model = document.createElement('th');
    model.scope = 'row';
    const name = document.createElement('strong');
    name.textContent = candidate.price.label;
    const score = document.createElement('td');
    score.textContent = !candidate.modelId ? 'Not configured'
      : !candidate.approval.samples.length ? 'No measured approval'
        : `${candidate.approval.passed}/${candidate.approval.total}${candidate.approval.approved ? ' pass' : ' · not approved'}`;
    const elimination = document.createElement('td');
    elimination.className = 'candidate-reason';
    elimination.textContent = candidate.exclusions?.length
      ? candidate.exclusions.map(exclusion => `${exclusion.kind} · custom PoC: ${exclusion.reason}`).join('\n')
      : candidate.eligible ? !canPreview ? 'Eligible candidate; preview unavailable until request readiness verified.'
        : preferred ? 'Expected winner · lowest eligible planned cost' : 'Eligible; higher cost or deterministic tie-break'
        : candidate.reason;
    const cost = document.createElement('td');
    cost.textContent = validPlan ? usd(tokenCost(candidate.price, state.plannedInputTokens, cap)) : 'Unavailable';
    const choice = document.createElement('span');
    choice.className = 'route-choice';
    choice.textContent = preferred ? 'Expected choice' : candidate.eligible ? 'Eligible candidate' : 'Excluded';
    model.append(name, choice);
    item.append(model, score, elimination, cost);
    body.append(item);
  }
  const why = document.createElement('div');
  why.className = 'routing-why';
  why.hidden = !canPreview;
  const reason = document.createElement('p');
  reason.textContent = explanation.summary;
  const condition = document.createElement('p');
  condition.className = 'routing-condition';
  condition.textContent = explanation.condition;
  why.append(reason);
  const assessmentDisclosure = document.createElement('details');
  assessmentDisclosure.className = 'selector-assessment';
  assessmentDisclosure.open = assessmentExpanded;
  const assessmentSummary = document.createElement('summary');
  assessmentSummary.textContent = 'How our selector chooses · model assessments';
  assessmentDisclosure.append(assessmentSummary);
  const assessment = document.createElement('section');
  assessment.className = 'routing-assessment';
  assessment.setAttribute('aria-label', 'Per-model workload assessment');
  const method = document.createElement('p');
  method.className = 'assessment-method';
  method.textContent = 'Saved evaluation: send the same 3 fixed test inputs to each model through the selected gateway. Compare responses with expected JSON. All 3 must pass; business restrictions then apply before comparing cost.';
  assessment.append(method);
  if (state.snapshot) {
    const cases = workloadAssessment(state.snapshot);
    const timing = document.createElement('p');
    timing.className = 'assessment-timing';
    timing.textContent = !cases.length ? 'This workload has no test suite. Neither model has approval.'
      : state.snapshot.evaluation?.current
        ? `Saved assessment: ${new Date(state.snapshot.evaluation.completedAt).toLocaleString()}. Click a check to compare the actual answers.`
        : 'No current assessment. Missing or expired results cannot approve a model.';
    assessment.append(timing);
    if (cases.length) {
      const matrix = document.createElement('table');
      matrix.className = 'assessment-matrix';
      matrix.setAttribute('aria-label', 'Same workload checks applied to each model');
      const matrixHead = document.createElement('thead');
      const matrixHeader = document.createElement('tr');
      for (const label of ['Fixed check', ...state.snapshot.candidates.map(candidate => candidate.price.label)]) {
        const cell = document.createElement('th');
        cell.scope = 'col'; cell.textContent = label;
        matrixHeader.append(cell);
      }
      matrixHead.append(matrixHeader);
      const matrixBody = document.createElement('tbody');
      const selected = cases.find(test => test.id === target.dataset.assessmentCase);
      const inspection = document.createElement('section');
      inspection.className = 'assessment-inspection';
      inspection.setAttribute('aria-label', 'Actual model assessment answers');
      inspection.hidden = !selected;
      if (selected) {
        const title = document.createElement('h4');
        title.textContent = selected.label;
        inspection.append(title);
        const input = document.createElement('details');
        const inputSummary = document.createElement('summary');
        inputSummary.textContent = 'Shared test input';
        const inputText = document.createElement('pre');
        inputText.textContent = selected.input;
        input.append(inputSummary, inputText);
        inspection.append(input);
        const expected = document.createElement('p');
        expected.textContent = `Expected: ${JSON.stringify(selected.expected)}`;
        inspection.append(expected);
        for (const model of selected.models) {
          const result = document.createElement('div');
          const label = document.createElement('strong');
          label.textContent = `${model.label}: ${model.outcome}${model.status !== undefined ? ` · HTTP ${model.status}` : ''}`;
          const response = document.createElement('pre');
          response.textContent = model.response ?? 'No current captured response.';
          const reason = document.createElement('p');
          reason.textContent = model.reason;
          const settings = document.createElement('p');
          settings.textContent = `${model.version} · reasoning: ${model.reasoningEffort}`;
          result.append(label, settings, response, reason);
          inspection.append(result);
        }
      }
      for (const test of cases) {
        const row = document.createElement('tr');
        const name = document.createElement('th');
        name.scope = 'row';
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = test.label;
        button.setAttribute('aria-expanded', String(selected?.id === test.id));
        button.addEventListener('click', () => {
          if (target.dataset.assessmentCase === test.id) delete target.dataset.assessmentCase;
          else target.dataset.assessmentCase = test.id;
          renderCostRouting(target, state);
          target.querySelector<HTMLButtonElement>(`button[data-case="${test.id}"]`)!.focus();
        });
        button.dataset.case = test.id;
        name.append(button);
        row.append(name);
        for (const model of test.models) {
          const cell = document.createElement('td');
          cell.textContent = model.outcome;
          cell.dataset.outcome = model.outcome;
          row.append(cell);
        }
        matrixBody.append(row);
      }
      matrix.append(matrixHead, matrixBody);
      assessment.append(matrix, inspection);
    }
  }
  const selectionRule = document.createElement('p');
  selectionRule.className = 'assessment-rule';
  selectionRule.textContent = 'Custom PoC: reuse current approval → apply declared business policy → choose lowest eligible planned token cost. A policy change never grants quality approval or changes the prompt. Only the winner is called; this is not a live contest.';
  assessment.append(selectionRule, condition);
  assessmentDisclosure.append(assessment);
  const evidence = document.createElement('details');
  evidence.className = 'routing-evidence';
  evidence.open = expanded;
  const summary = document.createElement('summary');
  summary.textContent = 'Evidence & limitations';
  const scope = document.createElement('p');
  scope.textContent = 'Evaluation-driven policy routing, not prompt understanding or native APIM intelligence. Checks run in advance, not on every prompt. Approval requires 3/3 fixed synthetic checks and expires after 24 hours; it is not a general quality or live-capacity guarantee. Model reasoning settings differ. Token costs are uncached, short-context list-price estimates, not bills or budgets. Input planning is an assumption; the workload output cap is enforced. Refusals happen locally; the separate manual API does not apply this approval gate.';
  const source = document.createElement('a');
  source.href = state.snapshot?.priceSource || 'https://prices.azure.com/api/retail/prices';
  source.target = '_blank';
  source.rel = 'noreferrer';
  source.textContent = `Azure prices · USD / East US 2 / GlobalStandard · reviewed ${state.snapshot?.priceReviewedAt || 'unavailable'}`;
  const raw = document.createElement('pre');
  raw.textContent = JSON.stringify({
    policy: state.snapshot?.policy,
    evaluation: state.snapshot?.evaluation, requirement: state.snapshot?.workload.requirement,
    cases: state.snapshot?.workload.cases,
    candidates: candidates.map(candidate => ({ model: candidate.price, eligible: candidate.eligible,
      reason: candidate.reason, exclusions: candidate.exclusions, checks: candidate.approval })),
    priceVersion: state.snapshot?.priceVersion, priceValidUntil: state.snapshot?.priceValidUntil,
    formula: '(input tokens × input rate + output tokens × output rate) / 1,000,000',
    excludes: 'Long-context/Flex/priority rates, caching/contract discounts, tax, APIM and infrastructure.'
  }, null, 2);
  const rawDetails = document.createElement('details');
  const rawSummary = document.createElement('summary');
  rawSummary.textContent = 'Raw routing snapshot';
  rawDetails.append(rawSummary, raw);
  evidence.append(summary, scope, source, rawDetails);
  if (state.onReload) {
    const reload = document.createElement('button');
    reload.id = 'reload-evidence'; reload.type = 'button';
    reload.textContent = state.reloadPending ? 'Reloading…' : 'Reload evidence';
    reload.disabled = state.busy || Boolean(state.reloadPending);
    reload.addEventListener('click', state.onReload);
    const note = document.createElement('p');
    note.id = 'reload-evidence-status';
    note.setAttribute('role', state.reloadStatus?.startsWith('Evidence reload failed') ? 'alert' : 'status');
    note.textContent = state.reloadStatus || 'Atomically reload genuine saved reports for this profile. Does not run evaluation or extend its 24-hour expiry.';
    evidence.append(reload, note);
  }
  comparison.append(head, body);
  target.append(heading, intro, status, comparison, why, assessmentDisclosure, evidence);
}
