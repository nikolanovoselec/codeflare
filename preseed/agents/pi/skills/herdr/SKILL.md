---
name: herdr
description: Use when Pi is inside Herdr and needs to create, task, steer, wait for, or read another coding-agent pane.
---

# Herdr agent orchestration

Use Herdr only for work that benefits from another live terminal or coding agent.

## Gate

Check before any Herdr command:

```bash
if [ "${HERDR_ENV:-}" != "1" ] || [ -z "${HERDR_PANE_ID:-}" ] || [ -z "${HERDR_SOCKET_PATH:-}" ]; then
  echo "not running inside Herdr"
  exit 1
fi
HERDR="${HERDR_BIN_PATH:-herdr}"
timeout 2 "$HERDR" pane current --current >/dev/null
```

If this fails, continue as a normal Codeflare terminal agent. Do not start a Herdr server or invent pane IDs.

## Start a helper in a new tab

A new tab supplies an available shell pane. Capture IDs from JSON:

```bash
created=$("$HERDR" tab create --cwd "$PWD" --label helper --no-focus)
pane=$(printf '%s\n' "$created" | jq -r '.result.root_pane.pane_id')
"$HERDR" agent start helper --kind pi --pane "$pane" --timeout 60000
```

Choose a unique lowercase agent name after checking `"$HERDR" agent list`. Use `pane split --current --direction right --no-focus` instead when a split is more useful. Never run the current Pi session file in two processes.

## Task, steer, and wait

```bash
"$HERDR" agent prompt helper "Implement the focused task and report changed paths" \
  --wait --until idle --until done --until blocked --timeout 120000
```

`agent prompt` can steer an agent that is already working. A blocked agent rejects prompts; inspect it, then send deliberate UI keys:

```bash
"$HERDR" agent read helper --source recent-unwrapped --lines 120
"$HERDR" agent send-keys helper esc
```

Use `agent get`, `agent list`, or `agent wait` for state. Always set timeouts because Herdr waits indefinitely when none is supplied. Treat `unknown` as unknown, never success.

## Read results

```bash
"$HERDR" agent read helper --source recent-unwrapped --lines 200
```

For long or incomplete alternate-screen output, ask the helper to write Markdown under `/tmp` and return only the path, then read that file. Reading does not focus the tab or mark `done` as seen.

Prefer `agent` commands for recognized coding agents. Use `pane run`, `pane wait-output`, and `pane read` for ordinary shells, tests, and servers. Keep the helper pane open unless its work is finished and closing it is intended.
