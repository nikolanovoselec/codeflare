# Dependency security — 2026-10-03

Scope: the 11 open default-branch Dependabot alerts #220–#230, fixed on develop; PR #1229 is incorporated into develop rather than main. Default-branch alert closure requires a later authorized promotion and fresh GitHub observation. No alert dismissals or new audit exclusions are used.

| Affected artifact | Remediation | Contract |
| --- | --- | --- |
| Host DOMPurify | 3.4.16, latest compatible stable | GHSA-p98j-92pf-mc4p; [REQ-OPS-054](../../sdd/spec/operations.md#req-ops-054-committed-npm-runtime-lock-integrity) |
| Browser Run MCP, Pi and shared npm-tools fast-uri | 3.1.8, latest stable v3 compatible with their parent ranges | GHSA-hrr3-gc8f-f4qj; REQ-OPS-054 |
| Landing devalue | 5.9.4, latest compatible stable v5; six advisory floors fixed from 5.9.3 | GHSA-j22f-vq7h-c4qm, GHSA-hx4r-w6wj-j8fg, GHSA-mcm9-63f2-9j32, GHSA-wf3x-273g-mvxv, GHSA-x5rw-q4pp-hg5g, GHSA-4q55-j62x-fr9h |
| Astro build-image http-cache-semantics | Genuine landing-owned private dependency replacement, not an upstream version claim | GHSA-ch52-4w7c-c8xp; [REQ-LANDING-016](../../sdd/spec/landing.md#req-landing-016-build-image-dependency-denies-cache-freshness) |

The registry still publishes http-cache-semantics 4.2.0 as latest; no stable patched release exists. The local `@codeflare/astro-build-cache-policy` replaces only Astro's dependency edge and supplies its two consumed public methods: no storability and zero freshness TTL. It does not implement a shared cache or remove Astro's own disk-cache/revalidation fallback. Current landing pages use native local images, not optimized remote images; introducing remote optimization requires reassessment. Worker cache/authentication/CSP behavior and static landing rendering remain unchanged.

PR #1229 regenerated Pi locks with lower brace-expansion/undici versions and missing reviewed registry integrities. Incorporation keeps only its registry-verified DOMPurify/fast-uri changes and restores unrelated baseline lock records. Runtime family pins, Node/Agents compatibility holds and #1224 remain unchanged. These image-owned dependency locks are not managed curation skills/extensions; no managed source or seed publication is changed.

## Evidence and limits

- Full test-only RED: `a691e66d340d42360fd5963f7b9c23eb84372548`, [PR Checks 37155180128](https://github.com/nikolanovoselec/codeflare/actions/runs/37155180128).
- Observed failures: three security-floor tests and ten real Astro-edge identity/storability tests. TTL assertions were masked by earlier failures; numerical positive TTL was not separately observed.
- Actual compiled home/login/privacy preservation passed at RED; this is server-rendered content and generated-asset evidence, not real-browser visual acceptance.
- Corrected clean installation, actual dependency substitution, complete tests and GREEN CI remain pending. The local lock identifies a real local package; clean CI must validate its resolution, not merely trust metadata.
- No main merge, Production deployment, runtime activation or default-branch alert closure is claimed.
