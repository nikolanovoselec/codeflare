---
name: cloudflare
description: "Cloudflare platform reference — Workers, Pages, KV/D1/R2, AI/Vectorize/Agents SDK, networking, WAF/DDoS, Terraform/Pulumi. Implementation reference (retrieval-first), NOT the new-project entry point: for a preference-less \"build me X\" request start with the `cloudflare-stack` playbook, and to ship/deploy use the `ship` skill. Use this for Cloudflare platform/API details while building or reviewing."
---

# Cloudflare Platform Skill

Consolidated skill for building on the Cloudflare platform. Use the decision trees below to find the right product, then fetch its live docs.

> **Retrieval-first build:** the per-product `references/<product>/` paths in the tables below are **doc slugs, not bundled files** — this skill ships the decision trees, not an offline doc mirror. For any `references/<product>/` entry, fetch the live docs with WebFetch at `https://developers.cloudflare.com/<product>/` (the authoritative, always-current source).

Your knowledge of Cloudflare APIs, types, limits, and pricing may be outdated. **Prefer retrieval over pre-training** — fetch the live docs before citing specifics.

## Retrieval Sources

Fetch the **latest** information before citing specific numbers, API signatures, or configuration options. Do not rely on baked-in knowledge or these reference files alone.

| Source | How to retrieve | Use for |
|--------|----------------|---------|
| Cloudflare docs | `cloudflare-docs` search tool or `https://developers.cloudflare.com/` | Limits, pricing, API reference, compatibility dates/flags |
| Workers types | `npm pack @cloudflare/workers-types` or check `node_modules` | Type signatures, binding shapes, handler types |
| Wrangler config schema | `node_modules/wrangler/config-schema.json` | Config fields, binding shapes, allowed values |
| Product changelogs | `https://developers.cloudflare.com/changelog/` | Recent changes to limits, features, deprecations |

When a reference file and the docs disagree, **trust the docs**. This is especially important for: numeric limits, pricing tiers, type signatures, and configuration options.

## CLI and access routing

Preserve the project's existing CLI and pinned versions. **Existing Codeflare Wrangler projects stay on Wrangler**; do not migrate, install another CLI, or add `cloudflare.config.ts` during unrelated work. Upstream now documents Cloudflare CLI (`cf`) for new or already-`cf` projects: consult [cf agent guidance](https://developers.cloudflare.com/cf/agents/index.md) and the [Wrangler-to-cf reference](https://developers.cloudflare.com/cf/wrangler/reference/index.md) rather than translating commands from memory. This is product guidance, not authorization to install, migrate, or deploy; keep `cloudflare-stack` and `ship` as the project/deployment entry points.

CLI guidance never overrides Codeflare's managed access: use `curl -H 'Authorization: Bearer CF_TOKEN' https://api.cloudflare.com/...` for Cloudflare API requests and the configured Gateway client/URL for AI Gateway. Placeholder tokens are intentional; do not search for real secrets, run login flows, or bypass managed authentication. Preserve least privilege, tenant isolation, and explicit user authorization for destructive, production, billing, credential, and user-data actions. Recommending a product does not authorize provisioning it or switching a backend.

## Quick Decision Trees

### "I need feature flags"

```
Need feature flags?
└─ Feature toggles, targeting rules, percentage rollouts → flagship/
   ├─ Evaluate in Workers → Flagship binding (env.FLAGS)
   ├─ Evaluate in Node.js / browser → OpenFeature SDK (@cloudflare/flagship)
   └─ Manage flags via API → Flagship REST API
```

### "I need to run code"

```
Need to run code?
├─ Serverless functions at the edge → workers/
├─ New static site, SPA, or full-stack app → workers/ + static-assets/
├─ Maintain an existing Pages deployment → pages/ (preserve unless migration requested)
├─ Git-triggered Worker builds → Workers Builds (see live routes below)
├─ Stateful coordination/real-time → durable-objects/
├─ Long-running multi-step jobs → workflows/
├─ Run containers → containers/
├─ Isolated runtime-loaded/generated code → dynamic-workers/ (check egress/bindings/limits)
├─ Agent shell, filesystem, or Linux tools → sandbox/ (inspect existing SDK line first)
├─ Multi-tenant (customers deploy code) → workers-for-platforms/
├─ Customer domains, TLS, and origin routing → Cloudflare for SaaS (see live routes below)
├─ Scheduled tasks (cron) → cron-triggers/
├─ Lightweight edge logic (modify HTTP) → snippets/
├─ Process Worker execution events (logs/observability) → tail-workers/
└─ Optimize latency to backend infrastructure → smart-placement/
```

### "I need to store data"

```
Need storage?
├─ Key-value (config, sessions, cache) → kv/
├─ Relational SQL → d1/ (SQLite) or hyperdrive/ (existing Postgres/MySQL)
├─ Object/file storage (S3-compatible) → r2/
├─ Versioned file trees (repos, build outputs, checkpoints) → artifacts/ (confirm beta access)
├─ Message queue (async processing) → queues/
├─ Vector embeddings (AI/semantic search) → vectorize/
├─ Strongly-consistent per-entity state → durable-objects/ (DO storage)
├─ Secrets management → secrets-store/
├─ Streaming ETL to R2 → basin-pipelines/ (formerly Pipelines)
├─ Managed Apache Iceberg catalog on R2 → basin-catalog/ (formerly R2 Data Catalog)
├─ Serverless SQL analytics over Iceberg tables → basin-sql/ (formerly R2 SQL)
├─ Durable event log with independent readers → k2/
├─ Application response caching → Workers Cache (see live routes below)
└─ Persistent cache (long-term retention) → cache-reserve/
```

### "I need AI/ML"

```
Need AI?
├─ Run inference (LLMs, embeddings, images) → workers-ai/
├─ Vector database for RAG/search → vectorize/
├─ Build stateful AI agents → agents-sdk/
├─ Gateway for any AI provider (caching, routing) → ai-gateway/
└─ Managed search/answers over your content (RAG) → ai-search/
```

### "I need networking/connectivity"

```
Need networking?
├─ Expose local service to internet → tunnel/
├─ TCP/UDP proxy (non-HTTP) → spectrum/
├─ WebRTC TURN server → turn/
├─ Private network connectivity → network-interconnect/
├─ Worker access to private services → workers-vpc/
├─ Domain records/resolution → dns/
├─ HTTPS/certificates → ssl/
├─ Origin health checks/failover → load-balancing/
├─ Optimize routing → argo-smart-routing/
├─ Optimize latency to backend (not user) → smart-placement/
└─ Real-time video/audio → realtimekit/ or realtime-sfu/
```

### "I need security"

```
Need security?
├─ Web Application Firewall → waf/
├─ DDoS protection → ddos/
├─ Bot detection/management → bot-management/
├─ API protection → api-shield/
├─ CAPTCHA alternative → turnstile/ (validate tokens server-side)
├─ Identity-based internal app access → Cloudflare Access (see live routes below)
├─ Admission control during traffic spikes → waiting-room/
└─ Credential leak detection → waf/ (managed ruleset)
```

### "I need media/content"

```
Need media?
├─ Image optimization/transformation → images/
├─ Video streaming/encoding → stream/
├─ Browser automation/screenshots/rendered extraction → browser-rendering/ (Browser Run)
└─ Third-party script management → zaraz/
```

### "I need analytics/metrics data"

```
Need analytics?
├─ Query across all Cloudflare products (HTTP, Workers, DNS, etc.) → graphql-api/
├─ Custom high-cardinality metrics from Workers → analytics-engine/
├─ Client-side (RUM) performance data → web-analytics/
├─ Workers Logs and real-time debugging → observability/
├─ SQL over Iceberg data lake (logs, events) → basin-sql/ (+ basin-pipelines/, basin-catalog/)
└─ Raw logs (Logpush to external tools) → Cloudflare docs
```

### "I need infrastructure-as-code"

```
Need IaC? → pulumi/ (Pulumi), terraform/ (Terraform), or api/ (REST API)
```

### Additional live-doc routes

These are live documentation links, not bundled references. Use the [product directory](https://developers.cloudflare.com/directory/index.md) for needs not listed; recommend only products that meet a concrete requirement and confirm current availability, limits, and pricing.

| Need | Live docs / deciding guidance |
|------|------------------------------|
| New websites/apps | [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/index.md); preserve existing Pages deployments |
| Next.js on Workers | [Current Next.js guide](https://developers.cloudflare.com/workers/framework-guides/web-apps/nextjs/index.md); upstream recommends vinext for new projects, not incidental migration of existing apps |
| Customer code / customer domains | [Workers for Platforms](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/index.md) / [Cloudflare for SaaS](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/index.md) |
| Worker-to-backend latency | [Workers placement](https://developers.cloudflare.com/workers/configuration/placement/index.md): explicit region hints or traffic-based Smart Placement |
| Application caching | [Workers Cache](https://developers.cloudflare.com/workers/cache/index.md); check [patterns](https://developers.cloudflare.com/workers/cache/examples/index.md) and [limitations](https://developers.cloudflare.com/workers/cache/limitations/index.md) before choosing Cache API or KV instead |
| Internal app access | [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/access-controls/index.md); preserve authentication and authorization boundaries |
| Build / preview / release | [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/index.md), [Previews](https://developers.cloudflare.com/workers/previews/index.md), [versions and deployments](https://developers.cloudflare.com/workers/versions-and-deployments/index.md); check resource sharing/isolation, and remember rollback does not restore connected data |
| Send / forward / process email | [Email Service](https://developers.cloudflare.com/email-service/index.md), [routing](https://developers.cloudflare.com/email-service/get-started/route-emails/index.md), [email handler](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/index.md) |

Browser Run is the current product name for Browser Rendering; the `browser-rendering/` doc slug below is retained, as in upstream's reference route. This rename is not an instruction to change Codeflare's browser backend. For Sandbox, preserve the existing stable/preview SDK line; consult live migration guidance only when migration is requested.

## Product Index

### Feature Flags
| Product | Reference |
|---------|-----------|
| Flagship | `references/flagship/` |

### Compute & Runtime
| Product | Reference |
|---------|-----------|
| Workers | `references/workers/` |
| Pages | `references/pages/` |
| Pages Functions | `references/pages-functions/` |
| Durable Objects | `references/durable-objects/` |
| Workflows | `references/workflows/` |
| Containers | `references/containers/` |
| Dynamic Workers | `references/dynamic-workers/` |
| Workers for Platforms | [Live docs](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/index.md) |
| Cron Triggers | `references/cron-triggers/` |
| Tail Workers | `references/tail-workers/` |
| Snippets | `references/snippets/` |
| Workers placement / Smart Placement | [Live docs](https://developers.cloudflare.com/workers/configuration/placement/index.md) |

### Storage & Data
| Product | Reference |
|---------|-----------|
| KV | `references/kv/` |
| D1 | `references/d1/` |
| R2 | `references/r2/` |
| Artifacts | `references/artifacts/` |
| Queues | `references/queues/` |
| Hyperdrive | `references/hyperdrive/` |
| DO Storage | `references/do-storage/` |
| Secrets Store | `references/secrets-store/` |
| Basin Pipelines | `references/basin-pipelines/` |
| Basin Catalog | `references/basin-catalog/` |
| Basin SQL | `references/basin-sql/` |
| K2 Streams | `references/k2/` |

### AI & Machine Learning
| Product | Reference |
|---------|-----------|
| Workers AI | `references/workers-ai/` |
| Vectorize | `references/vectorize/` |
| Agents SDK | `references/agents-sdk/` |
| AI Gateway | `references/ai-gateway/` |
| AI Search | `references/ai-search/` |

### Networking & Connectivity
| Product | Reference |
|---------|-----------|
| Tunnel | `references/tunnel/` |
| Spectrum | `references/spectrum/` |
| TURN | `references/turn/` |
| Network Interconnect | `references/network-interconnect/` |
| Argo Smart Routing | `references/argo-smart-routing/` |
| Workers VPC | `references/workers-vpc/` |
| DNS | `references/dns/` |
| SSL/TLS | `references/ssl/` |
| Load Balancing | `references/load-balancing/` |

### Security
| Product | Reference |
|---------|-----------|
| WAF | `references/waf/` |
| DDoS Protection | `references/ddos/` |
| Bot Management | `references/bot-management/` |
| API Shield | `references/api-shield/` |
| Turnstile | `references/turnstile/` |
| Waiting Room | `references/waiting-room/` |

### Media & Content
| Product | Reference |
|---------|-----------|
| Images | `references/images/` |
| Stream | `references/stream/` |
| Browser Run (formerly Browser Rendering) | `references/browser-rendering/` |
| Zaraz | `references/zaraz/` |

### Real-Time Communication
| Product | Reference |
|---------|-----------|
| RealtimeKit | `references/realtimekit/` |
| Realtime SFU | `references/realtime-sfu/` |

### Developer Tools
| Product | Reference |
|---------|-----------|
| Wrangler (existing Wrangler projects) | `references/wrangler/` |
| Cloudflare CLI (`cf`, see CLI routing) | `references/cf/` |
| Miniflare | `references/miniflare/` |
| C3 | `references/c3/` |
| Observability | `references/observability/` |
| GraphQL Analytics API | `references/graphql-api/` |
| Analytics Engine | `references/analytics-engine/` |
| Web Analytics | `references/web-analytics/` |
| Sandbox | `references/sandbox/` |
| Workerd | `references/workerd/` |
| Workers Playground | `references/workers-playground/` |

### Infrastructure as Code
| Product | Reference |
|---------|-----------|
| Pulumi | `references/pulumi/` |
| Terraform | `references/terraform/` |
| API | `references/api/` |

### Other Services
| Product | Reference |
|---------|-----------|
| Email Service (sending, routing, Workers) | `references/email-service/` |
| Static Assets | `references/static-assets/` |
| Bindings | `references/bindings/` |
| Cache Reserve | `references/cache-reserve/` |

## Upstream provenance

Selectively adapted from Cloudflare's Apache-2.0 [platform skill at commit `1f2cd0a19588e2c6197c91dd7c71729df1fb6156`](https://github.com/cloudflare/skills/blob/1f2cd0a19588e2c6197c91dd7c71729df1fb6156/skills/cloudflare/SKILL.md). The adjacent `LICENSE` is retained. This is a Codeflare-specific live-doc router, not a verbatim upstream copy or a bundled upstream skill/reference suite; local routing, managed-access, and authorization policies remain in force.
