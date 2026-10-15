import type { ModelPrice } from './model-pricing.ts';
import type { WorkloadId } from './workloads.ts';

export type RoutingPresetId = 'economy-first' | 'premium-required-reconciliation';
export interface RoutingPolicy {
  readonly id: RoutingPresetId;
  readonly label: string;
  readonly version: string;
  readonly owner: 'custom-poc';
}
export const routingPresets: readonly RoutingPolicy[] = [
  { id: 'economy-first', label: 'Economy-first', version: '1', owner: 'custom-poc' },
  { id: 'premium-required-reconciliation', label: 'Premium required for reconciliation', version: '1', owner: 'custom-poc' }
];
export class PolicyConflict extends Error {}
export class RoutingPolicyStore {
  private revision = 0;
  private selected: RoutingPresetId = 'economy-first';
  current(): RoutingPolicy {
    const preset = routingPresets.find(item => item.id === this.selected)!;
    return Object.freeze({ ...preset, version: `${preset.id}:v${preset.version}:r${this.revision}` });
  }
  snapshot() {
    return { active: this.current(), presets: routingPresets };
  }
  select(value: unknown): RoutingPolicy {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a routing policy selection.');
    const input = value as Record<string, unknown>;
    if (Object.keys(input).some(key => !['presetId', 'expectedVersion'].includes(key))
      || !routingPresets.some(preset => preset.id === input.presetId)) throw new Error('Select one of the two server-defined routing presets.');
    if (input.expectedVersion !== this.current().version) throw new PolicyConflict('Routing policy changed. Reload the current policy before selecting it.');
    if (input.presetId !== this.selected) {
      this.selected = input.presetId as RoutingPresetId;
      this.revision++;
    }
    return this.current();
  }
}
export interface CandidateExclusion {
  boundary: 'custom-poc';
  kind: 'configuration' | 'workload-approval' | 'business-policy';
  reason: string;
}
export function businessExclusion(policy: RoutingPolicy, workload: WorkloadId, price: ModelPrice): CandidateExclusion | undefined {
  if (policy.id === 'premium-required-reconciliation' && workload === 'reconcile-records' && price.role !== 'premium') {
    return { boundary: 'custom-poc', kind: 'business-policy',
      reason: 'Premium required for reconciliation: the business policy excludes economy, independently of its quality results.' };
  }
  return undefined;
}
