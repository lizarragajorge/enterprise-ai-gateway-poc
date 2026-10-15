import { readFileSync, statSync } from 'node:fs';

export interface PolicyFields {
  type: string;
  callsPerPeriod?: number;
  periodSeconds?: number;
  count?: number;
  period?: string;
  counterKey?: string[];
  scope?: string;
}
export interface PolicyEvidence {
  capturedAt: string;
  source: 'azure-control-plane';
  models: { name: string; policies: PolicyFields[] }[];
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
export function parsePolicyEvidence(value: unknown): PolicyEvidence {
  if (!isRecord(value) || typeof value.capturedAt !== 'string'
    || !Number.isFinite(Date.parse(value.capturedAt)) || !('source' in value) || value.source !== 'azure-control-plane'
    || !('models' in value) || !Array.isArray(value.models)) throw new Error('Invalid Azure policy evidence.');
  const models = value.models.map(model => {
    if (!isRecord(model) || typeof model.name !== 'string'
      || (model.policies !== null && !Array.isArray(model.policies))) {
      throw new Error('Invalid model policy evidence.');
    }
    const policies: PolicyFields[] = (model.policies === null ? [] : model.policies).map((policy: unknown) => {
      if (!isRecord(policy) || typeof policy.type !== 'string') throw new Error('Invalid policy type.');
      const fields: PolicyFields = { type: policy.type };
      for (const key of ['callsPerPeriod', 'periodSeconds', 'count'] as const) {
        if (key in policy && policy[key] !== null) {
          if (typeof policy[key] !== 'number' || !Number.isInteger(policy[key]) || policy[key] <= 0) throw new Error(`Invalid policy ${key}.`);
          fields[key] = policy[key];
        }
      }
      for (const key of ['period', 'scope'] as const) {
        if (key in policy && policy[key] !== null) {
          if (typeof policy[key] !== 'string') throw new Error(`Invalid policy ${key}.`);
          fields[key] = policy[key];
        }
      }
      if ('counterKey' in policy && policy.counterKey !== null) {
        if (!Array.isArray(policy.counterKey) || !policy.counterKey.every(key => typeof key === 'string')) throw new Error('Invalid policy counterKey.');
        fields.counterKey = policy.counterKey;
      }
      return fields;
    });
    return { name: model.name, policies };
  });
  return { capturedAt: value.capturedAt, source: value.source, models };
}
export function readPolicyEvidence(path = '.local/gateway-policies.json'): PolicyEvidence | undefined {
  try {
    if (statSync(path).size > 1024 * 1024) throw new Error('Azure policy evidence exceeds 1 MiB.');
    return parsePolicyEvidence(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}
