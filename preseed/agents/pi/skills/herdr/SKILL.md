---
name: herdr
description: Control Herdr tabs, panes, and coding agents when Pi runs inside Herdr.
disable-model-invocation: true
---

# Herdr control

Use Herdr only for requested UI control or work benefiting from another live terminal or coding agent.

## Gate

Run before any Herdr command:

```bash
if [ "${HERDR_ENV:-}" != "1" ] || [ -z "${HERDR_PANE_ID:-}" ] || [ -z "${HERDR_SOCKET_PATH:-}" ]; then
  echo "not running inside Herdr"
  exit 1
fi
HERDR="${HERDR_BIN_PATH:-herdr}"
timeout 2 "$HERDR" pane current --current >/dev/null
```

If gate fails, continue as normal Codeflare terminal agent. Do not start a Herdr server or invent IDs.

## Fast UI operations

Herdr IDs can become stale after users close tabs or panes. For follow-up UI requests, query current state first when target was not created in same command sequence:

```bash
HERDR="${HERDR_BIN_PATH:-herdr}"
"$HERDR" tab list
"$HERDR" pane list
```

### Tabs

Open tab and start Pi:

```bash
HERDR="${HERDR_BIN_PATH:-herdr}"
if ! agents=$("$HERDR" agent list); then
  exit 1
fi
if ! printf '%s\n' "$agents" \
  | jq -e '.result.agents | type == "array" and all(.[]; (.name == null) or ((.name | type) == "string"))' >/dev/null; then
  exit 1
fi
index=2
while [ "$index" -le 999 ] && printf '%s\n' "$agents" \
  | jq -e --arg name "pi$index" '.result.agents[]? | select(.name == $name)' >/dev/null; do
  index=$((index + 1))
done
test "$index" -le 999
name="pi$index"
created=$("$HERDR" tab create --cwd "$PWD" --label pi)
pane=$(printf '%s\n' "$created" | jq -r '.result.root_pane.pane_id')
"$HERDR" agent start "$name" --kind pi --pane "$pane" --timeout 60000
```

Focus tab by visible number:

```bash
HERDR="${HERDR_BIN_PATH:-herdr}"
tab=$("$HERDR" tab list | jq -r '.result.tabs[] | select(.number == 2) | .tab_id')
test -n "$tab" && "$HERDR" tab focus "$tab"
```

Use returned `tab_id` directly when tab was just created. Do not assume IDs such as `w1:t2` still exist.

### Splits

Direction describes where new pane appears:

- Vertical divider / side-by-side panes: `--direction right`
- Horizontal divider / stacked panes: `--direction down`

Split focused/current pane:

```bash
HERDR="${HERDR_BIN_PATH:-herdr}"
"$HERDR" pane split --current --direction right --cwd "$PWD" --focus
"$HERDR" pane split --current --direction down --cwd "$PWD" --focus
```

`--current` means Pi agent's pane, not necessarily pane currently focused in Herdr UI. To affect UI-focused pane, resolve it from `pane list`:

```bash
HERDR="${HERDR_BIN_PATH:-herdr}"
pane=$("$HERDR" pane list | jq -r '.result.panes[] | select(.focused == true) | .pane_id')
"$HERDR" pane split --pane "$pane" --direction right --cwd "$PWD" --focus
```

Change split orientation when no direct layout command exists: preserve main pane, close disposable shell pane, then split main pane in new direction. Never close a pane with an active agent or process without user confirmation.

Close focused disposable split:

```bash
HERDR="${HERDR_BIN_PATH:-herdr}"
pane=$("$HERDR" pane list | jq -r '.result.panes[] | select(.focused == true) | .pane_id')
if [ "$pane" = "$HERDR_PANE_ID" ]; then
  echo "refusing to close current Pi pane" >&2
  exit 1
fi
"$HERDR" pane close "$pane"
```

Before closing, inspect `agent_status`, `agent`, and process state when safety is uncertain. Never close current Pi pane.

## Agent orchestration

Choose unique lowercase name after checking:

```bash
HERDR="${HERDR_BIN_PATH:-herdr}"
"$HERDR" agent list
```

Create helper without stealing focus:

```bash
HERDR="${HERDR_BIN_PATH:-herdr}"
created=$("$HERDR" tab create --cwd "$PWD" --label helper --no-focus)
pane=$(printf '%s\n' "$created" | jq -r '.result.root_pane.pane_id')
"$HERDR" agent start helper --kind pi --pane "$pane" --timeout 60000
```

Never run current Pi session file in two processes.

Wait until helper can accept work, then prompt:

```bash
HERDR="${HERDR_BIN_PATH:-herdr}"
"$HERDR" agent wait helper --until idle --until done --timeout 120000
"$HERDR" agent prompt helper "Implement focused task and report changed paths" \
  --wait --until idle --until done --until blocked --timeout 120000
```

Blocked agents reject prompts. Read UI, then use `agent send-keys` for deliberate response. Always set timeouts; Herdr waits indefinitely otherwise. Treat `unknown` as unknown, never success.

Steer working helper asynchronously:

```bash
HERDR="${HERDR_BIN_PATH:-herdr}"
"$HERDR" agent prompt helper "Adjust current work using this new constraint"
```

Herdr v0.8.2 does not bind wait to steer submitted while agent works. Require task-specific completion evidence.

Read results:

```bash
HERDR="${HERDR_BIN_PATH:-herdr}"
"$HERDR" agent read helper --source recent-unwrapped --lines 200
```

For long alternate-screen output, ask helper to write Markdown under `/tmp`, return path, then read file. Reading does not focus tab or mark `done` seen.

Prefer `agent` commands for recognized coding agents. Use `pane run`, `pane wait-output`, and `pane read` for shells, tests, and servers. Keep helper pane open unless work finished and closing intended.

## Avoid command discovery loops

Use these known forms directly:

```bash
HERDR="${HERDR_BIN_PATH:-herdr}"
"$HERDR" tab list
"$HERDR" tab focus <tab_id>
"$HERDR" pane list
"$HERDR" pane split --pane <pane_id> --direction right|down --cwd "$PWD" --focus
"$HERDR" pane close <pane_id>
```

Use `<group> <command> --help` only when requested operation is absent above. After any `pane_not_found` or `tab_not_found`, refresh lists once and retry with resolved ID; do not guess IDs.
