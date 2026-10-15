import type { CallResult } from './gateway.ts';

export function hasModelResponse(result: Pick<CallResult, 'source' | 'status' | 'modelResponse'>): boolean {
  return result.source === 'gateway-response' && result.status >= 200
    && result.status < 300 && result.modelResponse;
}
