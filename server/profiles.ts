import { loadConfig, publicConfig } from './gateway.ts';
import type { Config, GatewayId } from './gateway.ts';

export const gatewayIds = ['ai-gateway', 'apim-v2'] as const;
export function validateGatewayId(value: unknown): GatewayId {
  if (value !== 'ai-gateway' && value !== 'apim-v2') throw new Error('Select gateway ai-gateway or apim-v2 explicitly.');
  return value;
}
export function loadProfile(env: NodeJS.ProcessEnv, id: GatewayId): Config {
  if (id === 'ai-gateway') return { ...loadConfig(env), gatewayId: id, gatewayType: 'standalone-ai-gateway', authHeader: 'api-key' };
  const mapped: NodeJS.ProcessEnv = {};
  for (const key of ['GATEWAY_ORIGIN', 'APP_A_KEY', 'APP_B_KEY']) mapped[key] = env[`APIM_V2_${key}`];
  for (const i of [1, 2, 3, 4]) {
    for (const field of ['NAME', 'CLOUD', 'PROVIDER', 'FORMAT', 'REASONING_EFFORT']) {
      mapped[`MODEL_${i}_${field}`] = env[`APIM_V2_MODEL_${i}_${field}`];
    }
  }
  const config = loadConfig(mapped);
  const authHeader = env.APIM_V2_AUTH_HEADER?.trim() || 'Ocp-Apim-Subscription-Key';
  if (authHeader !== 'api-key' && authHeader !== 'Ocp-Apim-Subscription-Key') throw new Error('Invalid APIM_V2_AUTH_HEADER; use api-key or Ocp-Apim-Subscription-Key.');
  const associated = env.APIM_V2_FOUNDRY_ASSOCIATED?.trim() || 'false';
  if (associated !== 'true' && associated !== 'false') throw new Error('APIM_V2_FOUNDRY_ASSOCIATED must be true or false.');
  for (const model of config.models) {
    const i = model.id.slice('model-'.length);
    const path = env[`APIM_V2_MODEL_${i}_PATH`]?.trim();
    if (path) {
      if (path.length > 200 || !/^\/default\/models\/[a-zA-Z0-9_/-]+$/.test(path)
        || path.includes('//') || path.endsWith('/')) throw new Error(`Invalid APIM_V2_MODEL_${i}_PATH.`);
      model.path = path;
    }
  }
  return { ...config, gatewayId: id, gatewayType: 'apim-premium-v2', authHeader, foundryAssociated: associated === 'true' };
}
export function loadProfiles(env: NodeJS.ProcessEnv) {
  return Object.fromEntries(gatewayIds.map(id => [id, loadProfile(env, id)])) as Record<GatewayId, Config>;
}
export function publicProfiles(profiles: Record<GatewayId, Config>) {
  return { ...publicConfig(profiles['ai-gateway']), defaultGatewayId: 'ai-gateway' as const,
    profiles: gatewayIds.map(id => publicConfig(profiles[id])) };
}
