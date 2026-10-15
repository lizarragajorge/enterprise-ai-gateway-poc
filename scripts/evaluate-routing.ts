import { randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { callGateway, validateInput } from '../server/gateway.ts';
import { loadProfile, validateGatewayId } from '../server/profiles.ts';
import { evaluationFile, evaluationBinding, SUITE_VERSION } from '../server/evaluation.ts';
import type { EvaluationReport, ModelEvaluation } from '../server/evaluation.ts';
import { modelPrices } from '../server/model-pricing.ts';
import { checkOutput, workloads, workloadPrompt } from '../server/workloads.ts';

async function main() {
  process.loadEnvFile('.env');
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--gateway')) throw new Error('Usage: npm run evaluate:routing -- --gateway ai-gateway|apim-v2');
  const gatewayId = validateGatewayId(args[1] || 'ai-gateway');
  const config = loadProfile(process.env, gatewayId);
  const file = evaluationFile(gatewayId);
  if (!config.origin || !config.keys.A) throw new Error('Configure the real gateway and application A key before evaluating.');
  const candidates = modelPrices.map(price => {
    const model = config.models.find(model => model.name === price.publishedName && model.cloud === 'azure'
      && model.format === 'openai-chat' && model.provider === 'foundry' && model.reasoningEffort === price.reasoningEffort);
    if (!model) throw new Error(`Configure ${price.label} and its verified generation settings before evaluating.`);
    return { price, model };
  });
  const report: EvaluationReport = {
    gatewayId, gatewayType: config.gatewayType, configBinding: evaluationBinding(config),
    runId: randomUUID(), suiteVersion: SUITE_VERSION, startedAt: new Date().toISOString(), completedAt: '', evaluations: []
  };
  // Fixed spacing protects this small demo's capacity; never retry or replace a failed sample.
  let nextCallAt = 0;
  for (const workload of workloads.filter(workload => workload.cases.length)) {
    const evaluations: ModelEvaluation[] = candidates.map(({ price }) => ({
      workload: workload.id, publishedName: price.publishedName, reportedModel: price.reportedModel,
      reasoningEffort: price.reasoningEffort, maxOutputTokens: workload.maxOutputTokens, samples: []
    }));
    for (const test of workload.cases) {
      for (const [index, { price, model }] of candidates.entries()) {
        const wait = nextCallAt - Date.now();
        if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
        const input = validateInput({ app: 'A', modelId: model.id, prompt: workloadPrompt(workload, test.input) }, config);
        const result = await callGateway(config, input, fetch, { maxCompletionTokens: workload.maxOutputTokens });
        nextCallAt = Date.now() + 31_000;
        evaluations[index].samples.push({
          caseId: test.id, source: result.source, status: result.status, reportedModel: result.returnedModel,
          modelResponse: result.modelResponse, response: result.response, latencyMs: result.latencyMs, tokens: result.tokens
        });
        const passed = result.source === 'gateway-response' && result.status === 200 && result.modelResponse
          && result.returnedModel === price.reportedModel && checkOutput(result.response, test.expected).passed;
        console.log(JSON.stringify({ workload: workload.id, case: test.id, model: price.label, HTTP: result.status, passed }));
      }
    }
    report.evaluations.push(...evaluations);
  }
  report.completedAt = new Date().toISOString();
  await mkdir('.local', { recursive: true });
  await writeFile(`${file}.tmp`, JSON.stringify(report, null, 2), { mode: 0o600 });
  await rename(`${file}.tmp`, file);
  console.log(`Saved ${gatewayId} real evaluation ${report.runId} to ${file}. Use Reload evidence in the local demo to load it. Approvals last 24 hours; no outcomes were forced.`);
}
main().catch(error => {
  console.error('Evaluation failed:', error instanceof Error ? error.message : 'Unknown evaluation error.');
  process.exitCode = 1;
});
