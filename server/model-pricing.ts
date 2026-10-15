import type { CallResult } from './gateway.ts';
import { hasModelResponse } from './model-response.ts';

export interface ModelPrice {
  role: 'economy' | 'premium';
  modelName: string;
  modelVersion: string;
  reasoningEffort: 'none' | 'low';
  publishedName: string;
  reportedModel: string;
  label: string;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  inputMeterId: string;
  outputMeterId: string;
}
export const PRICE_SOURCE = "https://prices.azure.com/api/retail/prices?$filter=productName%20eq%20'Azure%20OpenAI%20GPT6'%20and%20armRegionName%20eq%20'eastus2'&currencyCode=USD";
export const PRICE_REVIEWED_AT = '2026-10-12';
export const PRICE_VALID_UNTIL = '2026-11-11T00:00:00Z';
export const PRICE_VERSION = 'azure-gpt6-eastus2-global-short-usd-2026-10-12';
export const modelPrices: readonly ModelPrice[] = [
  {
    role: 'economy', modelName: 'gpt-6-luna', modelVersion: '2026-09-22', reasoningEffort: 'none',
    publishedName: 'ai-cost-economy-current', reportedModel: 'gpt-6-luna-2026-09-22', label: 'GPT-6 Luna',
    inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.5,
    inputMeterId: '80f11337-cd24-59ba-9ab0-cbab03513224',
    outputMeterId: '7735b966-17da-5761-b529-5803b647e4bd'
  },
  {
    role: 'premium', modelName: 'gpt-6.1-sol', modelVersion: '2026-09-29', reasoningEffort: 'low',
    publishedName: 'ai-cost-premium-current', reportedModel: 'gpt-6.1-sol-2026-09-29', label: 'GPT-6.1 Sol',
    inputUsdPerMillion: 2, outputUsdPerMillion: 10,
    inputMeterId: '146da5d0-1643-56df-ac51-9dbadafb7ba4',
    outputMeterId: '1a0d434b-1dba-5668-bc5e-2b033414246f'
  }
];
export function tokenCost(price: ModelPrice, input: number, output: number): number {
  if (![input, output].every(value => Number.isInteger(value) && value >= 0)) {
    throw new Error('Token counts must be nonnegative integers.');
  }
  return (input * price.inputUsdPerMillion + output * price.outputUsdPerMillion) / 1_000_000;
}
export function pricedUsage(result: CallResult, price: ModelPrice): { costUsd: number | null; unavailableReason?: string } {
  if (!hasModelResponse(result)) return { costUsd: null, unavailableReason: 'No supported successful model response. No zero-cost or savings claim.' };
  if (result.returnedModel !== price.reportedModel) return { costUsd: null, unavailableReason: 'Returned model missing or different from the priced version; cost unavailable.' };
  if (result.tokens?.input === undefined || result.tokens.output === undefined
    || ![result.tokens.input, result.tokens.output].every(value => Number.isInteger(value) && value >= 0)) {
    return { costUsd: null, unavailableReason: 'Valid input/output usage unavailable; cost is not zero.' };
  }
  if (result.tokens.input > 128000) return { costUsd: null, unavailableReason: 'Returned input exceeds this PoC short-context price scope; cost unavailable.' };
  return { costUsd: tokenCost(price, result.tokens.input, result.tokens.output) };
}
