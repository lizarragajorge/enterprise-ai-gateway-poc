import type { RoutingCandidate, RoutingSnapshot } from '../server/routing.ts';
import { preferredCostCandidate } from '../server/model-selection.ts';

export function routingGateFacts(snapshot?: RoutingSnapshot) {
  const premiumRequired = snapshot?.policy?.id === 'premium-required-reconciliation'
    && snapshot.workload.id === 'reconcile-records';
  return {
    workload: snapshot?.workload.label || 'Declared by the application',
    approval: snapshot?.evaluation?.current
      ? `${snapshot.candidates.filter(candidate => candidate.approval.approved).length}/${snapshot.candidates.length} models approved`
      : 'Current approval unavailable',
    business: !snapshot?.policy ? 'Policy unavailable'
      : premiumRequired ? 'Economy excluded by policy' : 'No extra business exclusion',
    businessDetail: !snapshot?.policy ? 'Load the live policy before explaining business eligibility.'
      : premiumRequired
        ? 'Live rule: reconciliation requires premium. Economy is excluded even if its workload checks passed; a lower price cannot override this restriction.'
        : snapshot.policy.id === 'premium-required-reconciliation'
          ? 'Live rule: premium is required only for reconciliation. This workload has no extra business exclusion; current workload approval is still required.'
          : 'Live rule: Economy-first adds no extra business exclusion. Only configured models with current workload approval enter the cost comparison.'
  };
}

export function explainRoutingChoice(candidates: readonly RoutingCandidate[]): {
  selected?: RoutingCandidate; summary: string; condition: string;
} {
  const selected = preferredCostCandidate(candidates);
  const exclusions = candidates.flatMap(candidate => candidate.exclusions || []);
  if (!selected && exclusions.length) return {
    summary: 'No eligible callable model after configuration, workload approval and business-policy gates. Refuse locally; no gateway call.',
    condition: 'Changing the prompt or business policy does not grant quality approval.'
  };
  if (!selected) return {
    summary: 'No model has current workload approval. Refuse locally; do not call a model.',
    condition: 'Changing the prompt alone does not grant approval.'
  };
  const alternative = preferredCostCandidate(candidates.filter(candidate => candidate.modelId !== selected.modelId));
  const business = candidates.filter(candidate => !candidate.eligible)
    .flatMap(candidate => (candidate.exclusions || []).filter(exclusion => exclusion.kind === 'business-policy'));
  if (!alternative && business.length) return {
    selected, summary: `${selected.price.label} is the remaining eligible model. Custom PoC business policy: ${business.map(item => item.reason).join(' ')}`,
    condition: 'Business restrictions are independent of measured quality; this is not gateway enforcement or a quality upgrade.'
  };
  if (!alternative) return {
    selected, summary: `${selected.price.label} is the only model with current workload approval.`,
    condition: 'A lower price never overrides missing approval.'
  };
  const saving = (1 - selected.plannedCostUsd / alternative.plannedCostUsd) * 100;
  const percentage = saving < 0.01 ? 'less than 0.01%' : `${Number(saving.toFixed(2))}%`;
  return {
    selected,
    summary: saving > 0
      ? `Both models have workload approval. ${selected.price.label}'s planned token cost is ${percentage} lower than ${alternative.price.label}'s.`
      : `Both models have workload approval and equal planned costs. Model-ID order breaks the tie.`,
    condition: `The router would choose ${alternative.price.label} after a new evaluation excludes ${selected.price.label} but still approves ${alternative.price.label}.`
  };
}
