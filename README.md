# AI Gateway architecture PoC

A local, customer-neutral demonstration of model access through Azure gateways,
evidence-backed workload selection, native controls, and monitoring boundaries.
The browser has five views: **Architecture**, **Models & API**, **Selection &
cost**, **Gateway controls**, and **Monitoring**.

This is a personal proof of concept, not a production gateway, official product
sample, or certification. It includes no cloud resources, credentials, saved
deployment evidence, or guaranteed working model endpoints. Application source
is licensed under the [MIT License](./LICENSE), copyright 2026 Microsoft
Corporation. Azure icons and dependencies retain their own terms;
see [third-party notices](./THIRD_PARTY_NOTICES.md).

## Run locally

Requirements: **Node.js 24+** and npm. Azure CLI and an authorized Azure account
are needed only for optional operator workflows. The portable lockfile uses
canonical public npm tarball URLs with pinned versions and integrity hashes;
no internal package feed or checked-in `.npmrc` is required for external clones.
Keep any existing ignored `.npmrc` and follow your environment's approved registry
policy. Local dependency operations in a managed environment must use its
configured internal registry, not bypass it. Portable lockfile URLs do not
authorize public-registry network access in that environment. External clones use
their own npm configuration or default registry. If installation fails, resolve
approved registry connectivity or certificate trust before continuing. Do not bypass TLS,
publish feed credentials, or replace the lockfile to manufacture setup success.

```sh
npm ci
cp .env.example .env
# Edit .env locally only when you have your own gateway configuration.
npm run build
npm start
```

Open **http://127.0.0.1:3000**. `PORT` may be changed in `.env`.
`npm start` serves the built frontend and the local Node server; rebuild after
frontend changes and restart after environment/server changes.

```sh
npm test
npm run check
npm run build
```

Tests use isolated fixtures and fake HTTP responses. Passing tests/builds prove
local behavior, not deployment, model availability, native enforcement, or live
Azure telemetry. Installing, building, testing, and starting the app do not
provision Azure resources or run model requests.

### Without Azure configuration

The architecture and explanations remain usable. Model slots, keys, and evidence
are intentionally blank: live requests cannot succeed until configured. Routing
approval, native-control proof, and monitoring show unavailable/not assessed
states where genuine evidence is missing. There is no seeded successful demo,
offline model fallback, or automatic cross-profile failover. Databricks likewise
has no bundled historical verification: its configured/live-call workflow remains
available when you supply and verify your own backend.

## Runtime configuration

Use [.env.example](./.env.example) for the complete runtime variable list.
It is a template, not a credential file.

| Configuration | Purpose |
| --- | --- |
| `GATEWAY_ORIGIN`, `APP_A_KEY`, `APP_B_KEY` | Standalone gateway origin and server-side application runtime keys |
| `MODEL_<n>_NAME` for slots 1–4 | Exact published gateway model/alias names; blank slots are omitted |
| `MODEL_<n>_CLOUD`, `_PROVIDER`, `_FORMAT` | Declared hosting/provider and supported request format |
| `MODEL_<n>_REASONING_EFFORT` | Optional verified `none` or `low` setting for OpenAI-chat models |
| `APIM_V2_*` | Independent APIM Premium v2 origin, keys, models, authentication header, and optional native paths |
| `APIM_V2_FOUNDRY_ASSOCIATED` | Operator assertion after separately verifying the Foundry resource association; default `false` |

Standalone uses the `api-key` header. APIM defaults to
`Ocp-Apim-Subscription-Key`; `api-key` is the only supported alternative.
Origins must be supported Azure HTTPS gateway hostnames without a path, port,
query, or credentials. This application does not accept arbitrary proxy URLs.
Optional APIM model paths must be bounded native `/default/models/...` routes;
see the template for validation rules.

Cloud values are `azure`, `aws`, or `gcp`; providers are `foundry`, `databricks`,
`bedrock`, or `vertex`. Formats are `openai-chat` or `anthropic-messages`.
Labels are configuration, not proof that a provider is connected. Verify the
specific backend's API and authentication; no universal API translation is
implemented. Azure-hosted Databricks is a separate provider, not a second cloud.
Its adapter uses a specific native invocations route, not arbitrary serving
endpoint normalization.

The browser defaults to **Standalone AI Gateway** (`ai-gateway`). Select
**APIM Premium v2** (`apim-v2`) explicitly. Each profile requires its own runtime
configuration and evidence; an unconfigured profile never borrows the other's
keys, approvals, or native proof. Switching profiles clears session observations.

Keep runtime keys in the local server environment. Configure upstream provider
credentials in your gateway/backend, not the browser or application `.env`.
Use system trust or an approved CA bundle (`NODE_EXTRA_CA_CERTS`) if required by
your network; never disable TLS certificate verification.

## What is native, and what is custom?

| Responsibility | Owner and evidence boundary |
| --- | --- |
| Exact-name dispatch and runtime-key validation | Azure gateway; a real model response is required to demonstrate access |
| Content Safety, model restrictions, caller limits | Native policies only when separately configured and proven for the selected profile/asset |
| Workload declaration, fixed-case evaluation, approval, business exclusions, cost selection | Custom Node PoC, not built-in intelligent gateway routing |
| Request correlation and observed result | Local application; not distributed tracing or gateway-only timing |
| Monitoring snapshot | Separately collected Azure evidence; not a live trace of the current browser request |
| Tools/MCP and enterprise integrations in architecture details | Explanatory unless independently deployed and verified |

**Models & API** is explicit model selection followed by **Send**; it bypasses
the custom workload approval/business gates. A successful call does not establish
per-model authorization, caller isolation, native safety, or Foundry association.
Provider edges highlight only after an observed model response; this is not an
instrumented trace inside the gateway. Upstream errors remain visible and do not
become simulated policy blocks.

No streaming, retry, load balancing, failover, caching, dollar-budget enforcement,
enterprise data access, production identity, or agent framework is implemented.

### Workload selection and policy changes

In **Architecture → Live PoC** or **Selection & cost**, declare a workload,
application, policy, planned input tokens, and synthetic input, then **Run
workload**. The expected preview is separate from the captured actual decision:
workload → policy/version → exclusions → selected model/reason → outcome.

The fixed routing pool is pinned to exact aliases, model versions, generation
settings, and reviewed prices in
[server/model-pricing.ts](./server/model-pricing.ts). Arbitrary configured models
do not inherit these prices or become eligible automatically. Cost comparisons
are scoped token estimates, not invoices or gateway/hosting/monitoring totals;
missing usage is unknown, never zero. Review price provenance and expiry before
claiming savings. Expired prices prevent cost routing.

Extraction and reconciliation each require all three fixed synthetic checks.
Approval is workload/model/profile-specific and expires **24 hours** after
evaluation. Changed configuration, suite, model version/settings, duplicate or
missing cases, and expired reports cannot establish current approval. External
publication has no approved evaluation and is refused before a model call.
These small checks are not general quality certification.

The server owns a shared, in-memory policy for both profiles:
`economy-first` or `premium-required-reconciliation`. Business eligibility is
applied before lowest planned token cost. The external-provider restriction
described in the UI is an architectural example, not an implemented dynamic
provider allowlist; latency, geography, and capacity are not selection inputs.

`GET /api/routing-policy` reads the active policy. Updates post
`{presetId, expectedVersion}` to the same endpoint; conflicts return the current
snapshot. The UI sends `policyVersion` with a workload request to reject a stale
preview. Existing clients may omit that guard and the server still applies its
current policy. Policy changes need no restart, do not alter the input or prior
captured decision, and reset on server restart.

## Operator workflows: bring your own Azure resources

**These commands are not part of local setup.** Review their source, target
configuration, permissions, plans, and costs before running them. `configure:*`
helpers and infrastructure deployments can change real Azure resources and
credentials; evaluations, verification modes, browser requests, and rehearsals
can make billable model calls. Nothing here authorizes publication or cloud
changes on your behalf.

Set up your own subscription, resource group, regions, gateway, model deployments,
role assignments, and any required monitoring/safety/backend resources. Runtime
`.env` configuration and operator deployment configuration serve different
purposes. Do not copy someone else's deployment IDs or proof artifacts.
See the [operator scripts reference](./scripts/README.md) for all required fields
and helper-specific modes. `start`, `evaluate:routing`, and `rehearse:journey`
use runtime environment configuration rather than operator target configuration.

Start from the public operator template, which contains placeholders only:

```sh
mkdir -p .local
cp scripts/deployment-config.example.json .local/deployment-config.json
# Edit the ignored copy with your own targets; never commit it.
```

The JSON separates standalone gateway/model targets, optional APIM comparison
targets, Databricks workspace targets, monitoring resources, and Content Safety
resource/location. The typed operator loader requires all template fields:
replace every placeholder with your own resource bindings before running helpers.
Missing, malformed, or placeholder configuration fails closed; it never falls
back to a saved deployment. Requiring target fields does not itself provision or
authorize any of those resources. Resource identifiers are operator settings,
not runtime secrets, but still belong only in the local copy; never add keys.
Sign in with Azure CLI and explicitly select your intended subscription before
using operator helpers; use least-privilege access and review each helper's
target validation. Do not change a subscription merely to reproduce old evidence.

| Existing script | Intended workflow |
| --- | --- |
| `npm run configure:azure` | Configure standalone model publication and application access on your own gateway |
| `npm run configure:routing-model` | Configure the routing demonstration's economy model |
| `npm run configure:cost-model` | Prepare the pinned premium/economy comparison deployment |
| `npm run configure:limits` | Configure native request/token-limit demonstration policies |
| `npm run read:policies` | Read actual gateway policies into a local evidence snapshot |
| `npm run configure:monitoring` | Configure the supported native monitoring destination |
| `npm run read:monitoring` | Collect actual policy/usage telemetry into a local snapshot |
| `npm run check:databricks` | Inspect your Databricks setup; `-- --call` makes a real synthetic request |
| `npm run configure:databricks` | Plan the optional native Databricks integration; review explicit apply/rotation/verification modes |

Additional entrypoints in `scripts/` include `configure-comparison.ts`,
`governance-proof.ts`, and `content-safety.ts`. Inspect their supported modes
before use: inspection, policy configuration, and live verification are different
operations. Do not assume every helper is read-only or safe to repeat. Where a
helper refuses to replace a completed verification batch, preserve the genuine
observations rather than editing or retrying until they look successful.

After verifying the exact pinned models and settings, collect real evaluations:

```sh
npm run evaluate:routing -- --gateway ai-gateway
# Or independently:
npm run evaluate:routing -- --gateway apim-v2
```

These execute a finite fixed suite with real requests and deliberate spacing,
not forced passes. Use **Evidence & limitations → Reload evidence** afterward.
Reload atomically reads genuine reports without restarting, running evaluations,
or extending approval expiry. Restart instead when runtime configuration changes.

`npm run rehearse:journey -- --gateway ai-gateway` (or `apim-v2`) runs a finite
live acceptance journey, including policy changes. Its redacted local report is
rehearsal evidence, not automatically loaded approval, native proof, or evidence
that a browser session succeeded.

### Evidence and native-control acceptance

No saved `.local/` evidence belongs in this repository. Generate it yourself and
keep it private: even redacted reports can reveal deployment metadata. Evaluation
reports may contain synthetic model responses; use synthetic data throughout.

Standalone reports use `.local/workload-evaluation.json`,
`.local/gateway-policies.json`, `.local/gateway-monitoring.json`, and
`.local/gateway-content-safety.json`. APIM uses separately bound
`.local/apim-v2-workload-evaluation.json`, `.local/apim-v2-gateway-policies.json`,
`.local/apim-v2-gateway-monitoring.json`, and `.local/apim-v2-content-safety.json`.
Native governance proof is also profile-bound. The validators in `server/`
define the schemas; fabricated pass flags or copied snapshots are not substitutes
for attributable observations.

- First establish a real successful model response through the chosen gateway.
- For native rejection, correlate the exact policy/asset readback with genuine
  blocked and allowed requests and a native-specific rejection signature. HTTP
  400/403/429 alone is insufficient; provider errors and capacity limits can look
  similar. Configuration coverage is not runtime enforcement.
- A model-allowlist rejection/allow pair using caller A proves an alias
  restriction, **not caller isolation**. Caller-limit isolation requires A to
  reach its policy limit while an independent B still succeeds. Shared A/B keys
  cannot establish independent callers.
- Content Safety uses the harmless `POC_CONTENT_SAFETY_BLOCK` marker and a clean
  control request. Each enabled proof button makes one real request with no local
  safety filter or fabricated response. Missing/partial evidence disables
  unverified assets. Category severity cards are configuration, not blocklist
  enforcement, classifier accuracy, output filtering, or Prompt Shields proof.
- **Reload evidence** does not turn a saved attempt into a current request.
  Monitoring readbacks are separately timestamped, not automatic end-to-end
  tracing. Missing token usage/cost remains unavailable, not zero.

For Databricks, backend credentials can expire independently of the UI/model
configuration. Review your credential expiry, rotate in gateway configuration
with the explicit operator workflow, revoke superseded credentials, and run a
new genuine verification. An enabled card does not prove an unexpired backend.

## Costs, preview status, and security limits

You are responsible for your own Azure/provider charges, quotas, resource
cleanup, budgets, and credential rotation. A tag or date does not shut down
resources or cap spending. Check regional model/tier availability before
deployment; a successful call is not a performance benchmark.

The standalone AI Gateway profile is treated as **public preview with no SLA**.
APIM Premium v2 infrastructure and its Foundry integration have different
lifecycles; this PoC labels the integration as preview. Capabilities and preview
monitoring limits change: verify current official
[gateway overview](https://learn.microsoft.com/en-us/azure/api-management/ai-gateway-overview),
[governance/monitoring](https://learn.microsoft.com/en-us/azure/api-management/ai-gateway-govern-secure-assets),
and [models/tools](https://learn.microsoft.com/en-us/azure/api-management/ai-gateway-manage-models-tools)
documentation for your target tier. Links are references, not claims of fresh
live verification.

The server binds to `127.0.0.1`, checks Host/Origin, uses a restrictive CSP, and
keeps runtime keys server-side. The A/B picker is **not authentication**; do not
expose this service publicly or treat it as a multi-user production service.
Prompts and raw model output are visible in local request details. Structured
outcome events omit keys/prompts/output, but local/cloud logs still require
operator review. Browser timing includes the local proxy, network, and inference.

Never commit `.env`, `.local/`, `.npmrc`, credentials, CA bundles, raw cloud exports,
or machine-specific configuration. Keep local editor skills and generated
build/dependency/compile-cache directories out of source control. Before any
separately authorized publication, review the exact
file set and run `npm run check:public` from a Git repository root. That guard is
a supplemental pattern check, not a comprehensive security audit, license review,
or permission to publish.
