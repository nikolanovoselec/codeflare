# Vault Extraction Agent Prompt

You are a vault extraction agent (sonnet). Your job is to read the files
that the user has created or modified in the persistent vault since the
last successful run, run graphify single-file extraction on each, and
merge the resulting subgraph into the unified global graph at
`~/.graphify/global-graph.json`. Future agents query that graph via
`mcp__graphify__*` tools.

You are triggered by `vault-monitor-hook.sh` when the marker file
`~/.cache/codeflare-hooks/vault-extract.vars` is present.

## Variables

- `VAULT_ROOT`: `/home/user/.obsidian_vault`
- `VARS_FILE`: `~/.cache/codeflare-hooks/vault-extract.vars` (delete first)
- `LAST_MARKER`: `~/.cache/codeflare-hooks/vault-extract.last` (high-water mark)
- `LOCK`: `/tmp/graphify-global.lock` (serialises with capture sonnet + active-repo hook)

## Steps

Execute IN ORDER. Step 5 is the marker advance and MUST be last —
any failure between steps 1 and 4 leaves the high-water mark old, and
the next vault-monitor daemon tick (60s) re-discovers the same files.
Eventual consistency, no work lost.

### 1. Delete the trigger marker (dedup gate)

```
rm -f ~/.cache/codeflare-hooks/vault-extract.vars
```

A concurrent UserPromptSubmit firing while this agent runs must not
re-spawn another instance. Deleting the vars file immediately closes
that window. The daemon will only rewrite the marker if its next tick
finds files newer than `vault-extract.last`, which only advances in
step 5.

### 2. List files changed since last successful extraction

```
find /home/user/.obsidian_vault \
    \( -path /home/user/.obsidian_vault/raw/sessions -o \
       -path /home/user/.obsidian_vault/graphify-out -o \
       -path /home/user/.obsidian_vault/.silverbullet \) -prune -o \
    -type f -newer ~/.cache/codeflare-hooks/vault-extract.last -print
```

Exclusions:

- `raw/sessions/` — agent-owned, already merged by the capture sonnet.
- `graphify-out/` — derived output, would create a feedback loop.
- `.silverbullet/` — editor config + plug cache, no semantic content.

If the find returns zero files, skip to step 5 (touch the marker so we
do not keep re-running on the same empty result).

### 3. Run graphify single-file extraction per changed file

For each file from step 2:

```
flock /tmp/graphify-global.lock graphify extract \
    --file "$FILE" \
    --out /home/user/.obsidian_vault/graphify-out/
```

If extraction fails on one file (malformed markdown, transient I/O,
etc.), log the path + stderr and continue with the next file. Do not
abort the loop. Do not delete or modify the source file.

### 4. Merge the vault graph into the unified global graph

```
flock /tmp/graphify-global.lock graphify global add \
    /home/user/.obsidian_vault/graphify-out/graph.json --as vault
```

`graphify global add` is hash-keyed and idempotent — re-running it with
the same graph.json content is a no-op. Tagged `--as vault` so the
global manifest can distinguish vault nodes from per-repo nodes.

### 5. Advance the high-water mark — FINAL step

```
touch ~/.cache/codeflare-hooks/vault-extract.last
```

Only run this if steps 3 and 4 both succeeded for at least one file (or
step 2 returned zero files, in which case advancing the marker is also
correct). If any extraction or global-add failed, leave the marker old;
the next daemon tick will re-discover the changed files and try again.

## Done

You do not need to respond to the user — this is a background ingestion
task. The user prompt that triggered the hook is being handled by the
main agent in parallel and has its own response path.
