import type { CapabilityId } from './explanations.ts';
import type { MonitoringEvidence } from '../server/monitoring-evidence.ts';
import type { Model } from '../server/gateway.ts';
import { modelCoverage } from './request-path.ts';

interface DemoTab {
  id: CapabilityId;
  label: string;
  title: string;
  capabilities: readonly CapabilityId[];
  gatewayRole?: string;
  demoScope?: string;
}

export const demoTabs: readonly DemoTab[] = [
  { id: 'multi-cloud', label: 'Models & API', title: 'Call models through the gateway',
    capabilities: ['multi-cloud', 'performance', 'developer-experience'] },
  { id: 'routing', label: 'Selection & cost', title: 'Intelligent routing: approval first, then cost',
    capabilities: ['routing', 'finops'],
    demoScope: 'Custom PoC: declared workload → evaluated approval → business eligibility → lowest eligible cost. Gateway authenticates and dispatches; no automatic classification or native AI routing is claimed.' },
  { id: 'reliability', label: 'Gateway controls', title: 'Traffic protection & safety',
    capabilities: ['reliability', 'safety'],
    gatewayRole: 'Centralize caller limits, traffic protection and content policies.',
    demoScope: 'Profile-specific native controls and Content Safety evidence are separate from custom routing. Saved verification is not a current request; unverified assets cannot run proof actions.' },
  { id: 'observability', label: 'Monitoring', title: 'Understand your AI traffic',
    capabilities: ['observability'] }
];

export function demoTabFor(capability: CapabilityId): DemoTab {
  const tab = demoTabs.find(item => item.capabilities.includes(capability));
  if (!tab) throw new Error(`No demo tab for capability: ${capability}`);
  return tab;
}

export const demoPresentation: Record<CapabilityId, {
  badge: string;
  request: 'manual' | 'selector' | 'none';
}> = {
  'multi-cloud': { badge: 'Live model calls', request: 'manual' },
  routing: { badge: 'Custom selector', request: 'selector' },
  reliability: { badge: 'Native proof required', request: 'none' },
  observability: { badge: 'Source-labeled evidence', request: 'none' },
  finops: { badge: 'Usage-based estimates', request: 'none' },
  safety: { badge: 'Profile-specific proof', request: 'none' },
  performance: { badge: 'App timing only', request: 'manual' },
  'developer-experience': { badge: 'Live HTTP API', request: 'manual' }
};

export function catalogScope(models: readonly Model[]): string {
  const coverage = modelCoverage(models);
  const cloud = coverage.clouds === 1
    ? { azure: 'Azure', aws: 'AWS', gcp: 'GCP' }[models[0].cloud]
    : `${coverage.clouds} clouds`;
  return `${coverage.models} models · ${coverage.providers} providers · ${cloud}. Select a model, then Send.`;
}

export function monitoringRows(samples: NonNullable<MonitoringEvidence['metrics']>['samples']) {
  return [...new Set(samples.map(sample => sample.model))].map(model => {
    const value = (tokenType: string): number | string => {
      const matching = samples.filter(sample => sample.model === model && sample.tokenType === tokenType);
      return matching.length === 1 ? matching[0].value : matching.length ? 'Multiple series' : 'Not reported';
    };
    return { model, input: value('prompt_tokens'), output: value('completion_tokens'), total: value('total_tokens'),
      reasoning: value('completion_tokens_details.reasoning_tokens'), cachedInput: value('prompt_tokens_details.cached_tokens') };
  });
}
