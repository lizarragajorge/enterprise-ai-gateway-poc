import type { RoutingCandidate } from './routing.ts';

export function preferredCostCandidate(candidates: readonly RoutingCandidate[]): RoutingCandidate | undefined {
  return candidates.filter((candidate): candidate is RoutingCandidate & { modelId: string } =>
    Boolean(candidate.eligible && candidate.modelId))
    .sort((a, b) => a.plannedCostUsd - b.plannedCostUsd || a.modelId.localeCompare(b.modelId))[0];
}
