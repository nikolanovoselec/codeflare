# Local main-session community labels

Load this after any build/refresh produces an unlabeled graph. The core skill's build sections all end by pointing here. This is the only allowed label path in Pi interactive Graphify - never run `graphify label`.

1. Prepare a label worklist from the graph's existing community assignments:

```bash
bash /home/user/.pi/agent/scripts/local-graphify-labels.sh prepare .
```

2. The **Pi main session agent** labels communities exactly like upstream Graphify expects: read the worklist/batches, inspect each community's node labels and source paths, and choose a 2–6 word plain-language name.

This is the current Pi session doing the inference. It is not a Graphify backend/provider call. Do **not** generate labels with a deterministic keyword script, do **not** reuse a generic label with numeric suffixes, and do **not** fabricate labels for communities you did not inspect.

For large/noisy graphs, check `community_count` in `graphify-out/.graphify_community_label_worklist.json` before labeling. If there are too many communities to label honestly in the main session, stop and tell the user the graph needs a narrower scope or architecture-mode graph. Do not produce garbage labels just to finish.

Write one JSON object:

```text
graphify-out/.graphify_labels.json
```

Shape:

```json
{"0":"Container Runtime","1":"Agent Preseed System"}
```

Every current community id must be present. Labels must be unique, specific, 2–6 words, and must not be placeholders like `Community 12` or numbered duplicates like `PR Review Workflow 77`. If two communities share a broad domain, qualify them by concrete source or responsibility, e.g. `Review Spawn Hooks`, `Review Job Storage`, `Review Enforcement Rules`.

3. Apply the labels and regenerate report/html with the exact local command:

```bash
bash /home/user/.pi/agent/scripts/local-graphify-labels.sh apply .
```

The apply script validates labels before and after regeneration, rejects placeholders/repeated labels/numeric suffixes, then uses Graphify's local Python modules to rebuild `GRAPH_REPORT.md` and the final user-facing `graph.html` from the graph's existing community assignments. It intentionally does **not** recluster during label application, because reclustering can change community IDs after the main session labels them. This is the point where labeled HTML becomes final.

Never run `graphify label` in this workflow.

Every completed build/update must finish by running label apply, and label apply must leave `graphify-out/callflow.html` next to the final labeled `graph.html`. The apply script runs:

```bash
graphify export callflow-html --graph graphify-out/graph.json --output graphify-out/callflow.html
```

If the `graphify export callflow-html` CLI form is unavailable, use the Pi `graphify_export_callflow` tool with explicit paths before reporting completion. Never push or present `graph.html`/`callflow.html` from before label apply as final output.
