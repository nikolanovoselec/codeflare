# README media acceptance — 2026-07-31

This record covers the manual acceptance owned by REQ-LANDING-013, REQ-LANDING-016, and REQ-LANDING-018. GitHub rendering and playback remain outside this record and pending under REQ-LANDING-019.

## Evidence identity

| Field | Value |
|---|---|
| Operator | Repository-owner-directed Pi engineering session |
| Source deployment | `https://codeflare.novoselec.ch/?readme-media=e30d22a` |
| Source head | [`e30d22a57948a2220af28db1d4df5f12e31dfad7`](https://github.com/nikolanovoselec/codeflare/commit/e30d22a57948a2220af28db1d4df5f12e31dfad7) |
| Integration deployment | [GitHub Actions run 30616733361](https://github.com/nikolanovoselec/codeflare/actions/runs/30616733361) |
| Capture path | Cloudflare Browser Run through Chrome DevTools, at a 1,440 × 1,000 desktop viewport |
| Repository dependencies added for capture | None |

## Canonical source and artifact results

Frames were captured from the deployed landing elements below. Encoding used temporary tooling outside the repository; the committed assets are the evidence retained by Codeflare.

| Media | Deployed source | Committed pair | Dimensions | GIF frames | Playback | Result |
|---|---|---|---:|---:|---|---|
| Execution | `[data-readme-reel="execution"]` | [`execution.gif`](../../assets/documentation/execution.gif) / [`execution.png`](../../assets/documentation/execution.png) | 1080 × 485 | 81 | Once, resolved ending | PASS |
| Browser VS Code | `#ide .terminal` | [`browser-vscode.gif`](../../assets/documentation/browser-vscode.gif) / [`browser-vscode.png`](../../assets/documentation/browser-vscode.png) | 1080 × 398 | 12 | Repeats | PASS |
| Browser E2E | `#context .split-band:nth-of-type(2)` | [`browser-e2e.gif`](../../assets/documentation/browser-e2e.gif) / [`browser-e2e.png`](../../assets/documentation/browser-e2e.png) | 1080 × 272 | 7 | Once, resolved ending | PASS |
| Review governance | `#pipeline .review-board` | [`review-governance.gif`](../../assets/documentation/review-governance.gif) / [`review-governance.png`](../../assets/documentation/review-governance.png) | 1080 × 447 | 10 | Repeats | PASS |
| Deployment | `[data-execution-face="software"] .terminal` | [`deployment.gif`](../../assets/documentation/deployment.gif) / [`deployment.png`](../../assets/documentation/deployment.png) | 1080 × 389 | 40 | Once, resolved ending | PASS |
| Inference Mesh | `#inference-mesh .mesh-hero-grid` | [`inference-mesh.gif`](../../assets/documentation/inference-mesh.gif) / [`inference-mesh.png`](../../assets/documentation/inference-mesh.png) | 1080 × 372 | 12 | Repeats | PASS |

The three one-shot encodes end with their matching resolved static fallback. The capture sequence and generated fallback for each pair were inspected before the assets were committed.

## Manual acceptance matrix

| Check | Evidence | Result |
|---|---|---|
| Canonical provenance | Every row above was captured from the named element on the deployed source head; no README-only product route or mockup was used. | PASS |
| One-shot resolution | Execution, Browser E2E, and deployment terminate on the resolved PNG-equivalent frame rather than looping or ending mid-event. | PASS |
| Alt text | The six README pictures identify browser E2E, specialist review, Browser VS Code, governed software/private-preview operations, Inference Mesh deployment verification, and private inference capacity respectively. | PASS |
| Architecture preservation | The root README retains its Mermaid topology; the superseded IDE screenshot is absent. | PASS |
| GitHub rendering | Requires inspection of the pushed README on GitHub, including reduced-motion selection and clipping. | PENDING — REQ-LANDING-019 |

## Automated corroboration

`host/__tests__/readme-media.test.js` validates the committed top-level picture declarations, PNG decoding and dimensions, GIF frame decoding and playback policy, retired media, and the per-file and aggregate budgets. The acceptance above does not substitute for the pending GitHub rendering check.
