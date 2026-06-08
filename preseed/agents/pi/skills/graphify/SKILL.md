---
name: graphify
description: Graphify workflow for Pi/Codeflare. Build, refresh, query, explain, trace, or locate repo/Vault/session knowledge. Uses official Graphify AST/build/cluster/report/export flows, and uses the Pi main session agent for semantic extraction and community labels.
---

# Graphify in Pi / Codeflare

Use this skill for Graphify build, refresh, query, explain, path, and repo/Vault/global graph work.

Hard rules:

- **Never use external/provider LLM backends for interactive Graphify work.** Do not run `graphify label`, do not pass `--backend`, and do not use Gemini/OpenAI/Anthropic/DeepSeek/Kimi/Ollama extraction from this skill.
- **Never use the `graphify_build` tool.** Its `semanticBackend` parameter defaults to DeepSeek (an external provider requiring `DEEPSEEK_API_KEY`, which is NOT set in this container), so it fails with `backend 'deepseek' requires DEEPSEEK_API_KEY`. Use the local scripts/flows in this skill instead (`build-graphify-ast.sh`, `safe-graphify-update.sh`, `graphify cluster-only`).
- **Vault graph rebuilds publish to `Raw/Graphs/`.** After a local `graphify cluster-only .` from `/home/user/Vault`, copy `graphify-out/graph.html` to `Raw/Graphs/vault-graph.html` so the seeded `Raw/Graphs/Vault Graph.md` index link resolves through the SilverBullet `.fs/` route. `graphify-out/` is excluded from R2 bisync and the `.fs/` route, so without the copy the link 404s.
- **The Vault graph uses the canonical graphify schema.** Vault nodes carry `file_type` + `source_file` (document/code) or `file_type: "concept"` with `source_file: null`; edges carry `relation` + `confidence` + `confidence_score`, identical to repo and global graphs. Never write the legacy `type`/`path`/`mentions` shape - `graphify global add` label-merges any node lacking `source_file`, collapsing document identity.
- **Use the Pi main session agent for community labels.** The main session writes `graphify-out/.graphify_labels.json`; then Graphify regenerates report/html locally from the graph's existing community assignments.
- **Use Pi `Agent` subagents only for uncached Full-mode semantic extraction chunks.** Do not run headless semantic extraction for uncached docs/images.
- **Use official Graphify flows** for AST detection/extraction, graph build/merge, clustering, report generation, HTML generation, query/path/explain, global merge, and callflow export.
- **Do not hand-edit graph output JSON.** Do not add Codeflare-specific AST allowlists, import rewrites, or graph normalization.

## Graph paths

```text
Repo graph:   <repo>/graphify-out/graph.json
Vault graph:  /home/user/Vault/graphify-out/graph.json
Global graph: /home/user/.graphify/global-graph.json
```

There is normally no `/home/user/workspace/graphify-out/graph.json`.

## Query workflow

Use the first-party native Pi tools for every graphify query - repo, Vault, and cross-repo/global alike:

- Broad context: `graphify_query({ question, mode: "bfs" })`
- Trace/path: `graphify_query({ question, mode: "dfs" })` or `graphify_path`
- Node details: `graphify_explain({ concept })`

The native tool resolves the graph automatically: the active repo's graph when you are in a cloned repo, otherwise the merged global graph (`/home/user/.graphify/global-graph.json`, which holds the Vault plus every globally-added repo). You do not pass a graph path - this includes Vault/session/cross-repo memory questions, which resolve to the global graph.

After answering from a `graphify_query` / `graphify_path` / `graphify_explain` result, persist the Q&A back into the graph with `graphify save-result` so the next update extracts it as a node. For the CLI `--graph` fallback, the `save-result` feedback loop (`--type query` / `path_query` / `explain`), and the `/graphify path` and `/graphify explain` flows, see `references/query.md`.

## Clone-time triage

Clone-time prompts must never authorize an automatic graph update. When a cloned repo has no graph, ask the user which graph action they want before running any build:

- **Full repo AST-only build** — free/local code graph.
- **Full repo semantic build** — intent to run Pi Agent semantic extraction after detection shows the actual uncached file/subagent counts.
- **No graph action right now** — stop without creating `graphify-out`.

When a cloned repo has a stale/unknown existing graph, ask before any update and offer only:

- **Use the existing graph as-is** — no files are modified.
- **Full repo AST-only update** — refresh code structure via the bounded wrapper.
- **Full repo semantic refresh** — intent to run the agent-driven semantic flow after detection shows the actual uncached file/subagent counts.

If the user already chose clone-time AST-only, treat that as the graph refresh choice after detection and do not ask the same mode question again. If the user chose clone-time Full semantic, treat it as intent only: after detection, show the actual uncached file/subagent counts and get confirmation before dispatching semantic subagents. Only re-prompt for a different mode if the chosen option is unavailable (for example, Full semantic was chosen but detection finds zero docs/papers/images).

## Detect corpus

From the repo root:

```bash
/root/.local/share/uv/tools/graphifyy/bin/python - <<'PY'
import json
from pathlib import Path
from graphify.detect import detect
Path('.graphify_detect.json').write_text(json.dumps(detect(Path('.').resolve()), indent=2), encoding='utf-8')
PY
/root/.local/share/uv/tools/graphifyy/bin/python - <<'PY'
import json
from pathlib import Path
result = json.loads(Path('.graphify_detect.json').read_text())
print(f"Corpus: {result.get('total_files', 0)} files · ~{result.get('total_words', 0)} words")
for key in ['code', 'document', 'paper', 'image', 'video']:
    count = len(result.get('files', {}).get(key, []))
    if count:
        print(f"  {key}: {count}")
PY
```

If the user asks to ignore a file class (for example images), exclude that class from semantic extraction and/or pass matching `--exclude` flags to Graphify code-refresh commands. Do not alter code detection.

## Mandatory graph refresh choice

After detection, present these choices and wait for the user to choose one, unless the current clone-time triage already captured an explicit Full repo AST-only or no-graph choice. If clone-time triage captured Full repo semantic, present only a post-detection cost/count confirmation before any semantic subagents run:

1. **Architecture graph** — recommended for large/noisy repos and daily navigation. Builds a smaller runtime-source graph by excluding tests, fixtures, generated files, docs/spec bulk, and build artifacts. Free/local.
2. **Full repo AST-only** — official Graphify AST/code graph for every detected code file. Free/local, but can be noisy on large repos.
3. **Full repo semantic** — Pi Agent subagents produce semantic chunks for docs/papers/images, then Graphify consumes local semantic fragments and rebuilds locally.
4. **No, I don't want to create/update a graph right now.** — stop without modifying `graphify-out`.

If there are zero docs/papers/images, hide only the semantic option; still offer Architecture graph, Full repo AST-only, and the no-graph option. For repos with more than ~200 files, recommend Architecture graph unless the user explicitly wants exhaustive coverage.

If the user chooses the no-graph option, do not build, update, label, delete, or regenerate any Graphify outputs. Acknowledge and stop.

## Architecture graph build

Use this when the user chooses Architecture graph:

```bash
bash /home/user/.pi/agent/scripts/build-graphify-architecture.sh .
```

The script uses Graphify’s own `detect`, `extract`, `build`, `cluster`, and `report` modules after applying generic architecture filters. It does not rewrite Graphify output. It deliberately defers user-facing `graph.html` and `callflow.html` until labels exist.

Then label communities using the **Local main-session community labels** section below. Do not push or present HTML outputs until label apply regenerates them from `.graphify_labels.json`.

## Full repo AST-only initial build

Use this only when the user chooses Full repo AST-only and `graphify-out/graph.json` is missing:

```bash
bash /home/user/.pi/agent/scripts/build-graphify-ast.sh .
```

The script uses Graphify’s own `detect`, `extract`, `build`, `cluster`, and `report` modules only. It does not rewrite Graphify output. It deliberately defers user-facing `graph.html` and `callflow.html` until labels exist.

Then label communities using the **Local main-session community labels** section below. Do not push or present HTML outputs until label apply regenerates them from `.graphify_labels.json`.

## Full repo AST-only refresh for an existing graph

Use this when the user chooses Full repo AST-only, `graphify-out/graph.json` exists, and source code changed:

```bash
bash /home/user/.pi/agent/scripts/safe-graphify-update.sh .
```

The safety wrapper only sets `GRAPHIFY_MAX_WORKERS`, applies `ulimit -v`, and runs upstream `graphify update`. Any `graph.html` produced by upstream update is provisional.

Then label communities using the **Local main-session community labels** section below. Do not push or present HTML outputs until label apply regenerates them from `.graphify_labels.json`.

## Full build/update without provider LLMs

Use this when the user chooses Full repo semantic. Pi `Agent` subagents produce semantic chunks for the uncached docs/papers/images, then Graphify consumes the local semantic fragments and rebuilds locally. **Do not pass a model override** when dispatching those subagents - they use the running session model. The full four-step flow (create semantic file list, dispatch subagents, merge chunks into the Graphify cache + local fragment, then rebuild from an AST baseline with `build-graphify-ast.sh`) lives in `references/build.md`. Load it only after the post-detection cost/count confirmation passes.

Then label communities using the **Local main-session community labels** flow below.

## Local main-session community labels

This is the only allowed label path in Pi interactive Graphify - never run `graphify label`. The Pi main session agent prepares a worklist (`local-graphify-labels.sh prepare .`), inspects each community's nodes/sources, writes unique 2–6 word names to `graphify-out/.graphify_labels.json`, then applies them (`local-graphify-labels.sh apply .`), which regenerates `GRAPH_REPORT.md` + the final labeled `graph.html` + `callflow.html` without reclustering. Every completed build/update must finish by running label apply. See `references/labels.md` for the worklist/naming rules, the apply-script guarantees, and the callflow-html fallback.

## Validation checklist

After build/refresh, verify:

- `graphify-out/graph.json` exists
- `graphify-out/GRAPH_REPORT.md` exists
- `graphify-out/graph.html` exists
- `graphify-out/callflow.html` exists
- node/edge counts are nonzero
- duplicate IDs = 0
- dangling edges = 0
- semantic cache was preserved for Full mode
- `graphify-out/.graphify_labels.json` exists and has complete, unique, non-placeholder, non-numbered labels for all communities

## Global merge and git persistence

Merge into the global graph:

```bash
flock -w 5 /tmp/graphify-global.lock graphify global add graphify-out/graph.json --as "$(basename "$PWD")"
```

Commit only durable outputs when the user can push:

- `graphify-out/graph.json`
- `graphify-out/GRAPH_REPORT.md`
- `graphify-out/graph.html`
- `graphify-out/.graphify_labels.json`
- `graphify-out/callflow.html`
- optional `graphify-out/wiki/`

Do not commit caches, manifests, chunks, or `.graphify_*` intermediates other than `.graphify_labels.json` unless explicitly asked.

Ensure `.gitattributes` contains:

```gitattributes
graphify-out/graph.json merge=graphify
```
