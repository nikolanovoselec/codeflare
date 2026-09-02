# AI Gateway

Enterprise Codeflare can route supported coding-agent model traffic through the customer's AI Gateway. Agents keep provider-compatible base URLs while the Worker interceptor sends requests to an operator-defined route catalog. Routes can carry model targets, context-window limits, and group-specific selection.

This keeps routing policy outside the container. The agent does not choose an arbitrary Gateway route or receive the Gateway token. Initialization and later Administration own the URL, token replacement, route catalog, and Access-group mappings. Blank replacement fields preserve saved Gateway secrets.

User example: ask the agent which model route is active only if the runtime exposes that information, then run a small model task and have an operator correlate it with AI Gateway analytics. Do not infer the route from the model's writing style.

Operator example: add a low-risk pilot route, map one Access group to it, preview the Administration change, execute it, and confirm both the sanitized run outcome and a real request in Gateway logs. Keep the previous mapping available for rollback.

AI Gateway is Enterprise-only and requires a configured URL, token, and at least one valid dynamic route. Without those, Codeflare must not claim routing is active.

Source anchors: `sdd/spec/enterprise-mode.md` REQ-ENTERPRISE-004/005/007/012/013/017/022, `src/llm-interceptor.ts`, `documentation/lanes/configuration.md`, and `documentation/lanes/api-reference.md`.
