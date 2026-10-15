import { readFileSync, statSync } from 'node:fs';
import type { Config } from './gateway.ts';
import { parsePolicyEvidence, readPolicyEvidence } from './policy-evidence.ts';
import { parseMonitoringEvidence, readMonitoringEvidence } from './monitoring-evidence.ts';

export function parseProfileEvidence<T>(config: Config, value: unknown, parse: (value: unknown) => T): T | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const wrapper = value as Record<string, unknown>;
  if (!config.origin || wrapper.gatewayId !== config.gatewayId || wrapper.gatewayOrigin !== config.origin) return undefined;
  return parse(wrapper.evidence);
}
export function readProfileEvidence(config: Config) {
  if (config.gatewayId !== 'apim-v2') return { policy: readPolicyEvidence(), monitoring: readMonitoringEvidence() };
  function read<T>(kind: string, parse: (value: unknown) => T): T | undefined {
    const path = `.local/apim-v2-gateway-${kind}.json`;
    try {
      if (statSync(path).size > 1024 * 1024) throw new Error('Profile evidence exceeds 1 MiB.');
      const wrapper = JSON.parse(readFileSync(path, 'utf8'));
      return parseProfileEvidence(config, wrapper, parse);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
      console.warn(`APIM ${kind} evidence unavailable: invalid or unsupported snapshot.`);
      return undefined;
    }
  }
  return { policy: read('policies', parsePolicyEvidence), monitoring: read('monitoring', parseMonitoringEvidence) };
}
