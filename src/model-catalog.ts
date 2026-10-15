import { modelProvider } from '../server/gateway.ts';
import type { Model } from '../server/gateway.ts';
import { modelPrices } from '../server/model-pricing.ts';

export const apimDatabricksAuth = 'Backend auth: APIM managed identity registered with workspace-access only; no new personal access token or backend secret issued. Workspace-level Foundation Model API access is not per-model authorization. Successful inference, tools and data access require separate evidence.';
export interface CatalogEntry {
  id: string;
  cloud: Model['cloud'];
  label: string;
  model?: Model;
  status: 'Response observed' | 'Configured, unverified' | 'Architecture example';
}
export function modelLabel(model: Model): string {
  if (modelProvider(model) === 'databricks') return `Databricks · ${model.name === 'demo-databricks-gpt-oss-20b' ? 'GPT OSS 20B' : model.id}`;
  const name = model.cloud === 'azure' ? modelPrices.find(price => price.publishedName === model.name)?.label
    || (model.name === 'demo-chat-secondary' ? 'GPT-4.1 mini' : undefined) : undefined;
  return `${{ azure: 'Azure', aws: 'AWS', gcp: 'GCP' }[model.cloud]} · ${name || model.id}`;
}
export function catalogEntries(models: readonly Model[], successes: ReadonlySet<string>, includeDatabricksExample = true): CatalogEntry[] {
  const entries: CatalogEntry[] = models.map(model => ({
    id: model.id, cloud: model.cloud, label: modelLabel(model), model,
    status: successes.has(model.id) ? 'Response observed' : 'Configured, unverified'
  }));
  if (includeDatabricksExample && !models.some(model => modelProvider(model) === 'databricks'
    && model.name === 'demo-databricks-gpt-oss-20b')) entries.push({
    id: 'databricks-gpt-oss-20b', cloud: 'azure', label: 'Databricks · GPT OSS 20B',
    status: 'Architecture example'
  });
  for (const cloud of ['azure', 'aws', 'gcp'] as const) {
    if (!models.some(model => model.cloud === cloud)) {
      entries.push({
        id: `example-${cloud}`, cloud,
        label: { azure: 'Azure model', aws: 'AWS / Bedrock model', gcp: 'GCP / Gemini model' }[cloud],
        status: 'Architecture example'
      });
    }
  }
  return entries;
}
function modelApiPath(model: Model): string {
  if (model.path) return model.path;
  if (modelProvider(model) === 'databricks') return '/default/models/databricks-gpt-oss-20b/invocations';
  return model.format === 'anthropic-messages'
    ? '/default/models/anthropic/v1/messages'
    : '/default/models/openai/v1/chat/completions';
}
export function requestContract(entry: CatalogEntry, authHeader = 'api-key'): string {
  if (!entry.model) return 'No callable model is configured here.\nFirst verify the provider endpoint, credentials and supported API format; then publish/import a model and configure this PoC.';
  const anthropic = entry.model.format === 'anthropic-messages';
  return `POST ${modelApiPath(entry.model)}
${authHeader}: <server-side gateway runtime key>${anthropic ? '\nanthropic-version: 2023-06-01' : ''}

${JSON.stringify({
    model: `<published name for ${entry.label}>`,
    messages: [{ role: 'user', content: 'Summarize synthetic work order DEMO-01.' }],
    ...(anthropic ? { max_tokens: 256 } : { stream: false }),
    ...(modelProvider(entry.model) === 'databricks' ? { max_tokens: 256 } : {}),
    ...(entry.model.reasoningEffort ? { reasoning_effort: entry.model.reasoningEffort } : {})
  }, null, 2)}`;
}

interface CatalogState {
  gatewayId?: 'ai-gateway' | 'apim-v2';
  authHeader?: string;
  models: readonly Model[];
  successes: ReadonlySet<string>;
  selectedId?: string;
  gatewayConfigured: boolean;
  pending: boolean;
  configurationStatus: string;
}
export function renderModelCatalog(
  target: HTMLElement, state: CatalogState,
  select: (id: string) => void, useModel: (model: Model) => void
) {
  const futureExpanded = target.querySelector<HTMLDetailsElement>('.catalog-future')?.open || false;
  const connectionExpanded = target.querySelector<HTMLDetailsElement>('.catalog-preview')?.open || false;
  const previousSelection = target.dataset.selection;
  const entries = catalogEntries(state.models, state.successes, state.gatewayId !== 'apim-v2');
  const selected = entries.find(entry => entry.id === state.selectedId) || entries[0];
  target.dataset.selection = selected.id;
  target.replaceChildren();
  const catalog = document.createElement('div');
  catalog.className = 'model-catalog';
  catalog.setAttribute('role', 'group');
  catalog.setAttribute('aria-label', 'Configured gateway models');
  const future = document.createElement('details');
  future.className = 'catalog-future';
  future.open = futureExpanded;
  const futureSummary = document.createElement('summary');
  futureSummary.textContent = 'Additional providers · not connected';
  future.append(futureSummary);
  const examples = document.createElement('div');
  examples.className = 'model-catalog';
  for (const entry of entries) {
    const button = document.createElement('button');
    button.id = `catalog-${entry.id}`;
    button.type = 'button';
    button.disabled = state.pending;
    button.setAttribute('aria-pressed', String(entry.id === selected.id));
    button.dataset.status = entry.status;
    const title = document.createElement('strong');
    title.textContent = entry.label;
    const format = document.createElement('span');
    format.textContent = entry.model?.format || 'API compatibility needs verification';
    const status = document.createElement('small');
    status.textContent = entry.status === 'Configured, unverified' ? 'Ready to test'
      : entry.status === 'Response observed' ? 'Responded this session' : 'Not connected';
    button.append(title, status);
    button.addEventListener('click', () => {
      select(entry.id);
      if (entry.model && state.gatewayConfigured && !state.pending) useModel(entry.model);
    });
    if (entry.model) catalog.append(button);
    else examples.append(button);
  }
  future.append(examples);
  future.hidden = !examples.childElementCount;
  const preview = document.createElement('details');
  preview.className = 'catalog-preview compact';
  preview.open = previousSelection === selected.id && connectionExpanded;
  preview.setAttribute('aria-label', 'Selected model interface');
  const previewSummary = document.createElement('summary');
  previewSummary.textContent = selected.model ? 'Connection details & limits' : 'Connection prerequisites';
  const contract = document.createElement('div');
  const contractTitle = document.createElement('h3');
  contractTitle.textContent = `${selected.label} · ${selected.model ? 'API shape' : 'Integration prerequisites'}`;
  const note = document.createElement('p');
  note.textContent = selected.model
    ? 'Illustrative values, not a submitted request. The local backend adds the real published name and runtime key.'
    : 'Design only. This destination is not selectable in the live request form.';
  const code = document.createElement('pre');
  code.textContent = requestContract(selected, state.authHeader);
  const format = document.createElement('p');
  format.className = 'catalog-format';
  format.textContent = selected.model
    ? `${modelProvider(selected.model) === 'databricks' ? 'Native Databricks invocations · OpenAI-style payload, not endpoint normalization' : selected.model.format === 'anthropic-messages' ? 'Native Anthropic Messages' : 'OpenAI-compatible chat'} · explicit published-model selection`
    : 'Provider import and API compatibility are prerequisites, not working integrations.';
  contract.append(contractTitle, format);
  if (selected.model) {
    const settings = document.createElement('dl');
    settings.className = 'catalog-settings';
    for (const [label, value] of [
      ['Endpoint', `POST ${modelApiPath(selected.model)}`],
      ['Access', state.gatewayId === 'apim-v2'
        ? 'API-scoped APIM subscription key held server-side; backend managed identity'
        : 'Server-side gateway key; backend credentials managed by the gateway']
    ]) {
      const term = document.createElement('dt');
      term.textContent = label;
      const description = document.createElement('dd');
      description.textContent = value;
      settings.append(term, description);
    }
    const example = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'Inspect the API example';
    example.append(summary, note, code);
    contract.append(settings, example);
    if (modelProvider(selected.model) === 'databricks') {
      const scope = document.createElement('p');
      scope.textContent = 'Same gateway and local app API, native Databricks endpoint—not universal endpoint normalization. Only a supported gateway response in this session earns Response observed; configuration is not a current credential-health check. Foundry and Databricks are providers on Azure, not multiple clouds. Built-in Foundation Model API access is workspace-level, not per-model authorization. No Unity Catalog tools/data, intelligent routing, failover or telemetry is demonstrated by this call.';
      const auth = document.createElement('p');
      auth.textContent = 'Backend auth: gateway-held, seven-day model-serving-inference scoped Bearer PAT; no app/backend secret. Rotate before expiry (see README). Expired credentials remain explicit failures, not fallback responses.';
      if (state.gatewayId === 'apim-v2') {
        auth.textContent = apimDatabricksAuth;
        contract.append(scope, auth);
      } else contract.append(scope, auth);
    }
  } else {
    contract.append(note, code);
  }
  preview.append(previewSummary, contract);
  const status = document.createElement('p');
  status.className = 'setup';
  status.hidden = state.gatewayConfigured;
  status.setAttribute('role', 'status');
  status.textContent = state.configurationStatus;
  const options = document.createElement('div');
  options.className = 'catalog-options';
  options.append(future, preview);
  target.append(catalog, options, status);
}
