---
name: consult-llm
description: Use only when the user explicitly asks to consult external LLMs or names GPT, ChatGPT, Gemini, OpenAI, or consult_llm. Never use at session start, for routine planning/review/debugging, or for a generic "second opinion" unless the user names external LLMs.
version: 3.0.0
---

# Consult LLM: Query External AI Models

Query external LLM providers via the `consult_llm` MCP tool and present their responses for comparison. Two providers are available: **OpenAI** (GPT) and **Google Gemini**.

The server picks the backend automatically — for OpenAI it uses your **Codex subscription** when you are logged into Codex (no API spend), otherwise your OpenAI API key; for Gemini it uses your Gemini API key. Keys/login are managed in **Settings → LLM API Keys** (and `codex login`) and take effect on the next session start.

## Hard gate — explicit user request only

Do not call `consult_llm` unless the user's current request explicitly asks to consult external LLMs or names GPT, ChatGPT, Gemini, OpenAI, or `consult_llm` as the target. This skill is forbidden for:

- session start, orientation, planning, routine code review/debugging, or CI fixes;
- satisfying generic "ask advisor", "stronger model", or "second opinion" instructions when no external LLM is named;
- proactive sanity checks chosen by the assistant.

If the user asks for a generic second opinion without naming external LLMs, ask what they want. Do not call `consult_llm`, and do not invoke advisor unless the user explicitly asks for advisor.

## Step 1 — Choose the model

**If the user named a specific model** ("ask gpt-5.5…", "use gemini-3.1-pro…") → use that exact model ID, no dialog.

**Otherwise you MUST show an `AskUserQuestion` dialog** (single-select) so the user picks. Provide these four options — the tool automatically adds an "Other" free-text choice, giving **five** total:

1. **Latest Google (Gemini)** — call with the selector `model: "gemini"`.
2. **Latest OpenAI (GPT)** — call with the selector `model: "openai"`.
3. **Both** — call once per provider (`"gemini"` and `"openai"`) and synthesize across them.
4. **List all available models** — show the **concrete** model IDs this server actually supports (see **Listing concrete models** below), then let the user pick an exact one. Do **not** present the provider selectors as the model list.
5. *(Other — added automatically)* the user types the **exact model** they want → pass it verbatim.

**Never hardcode a model ID for "latest."** The selectors `"openai"` / `"gemini"` are resolved to the current best flagship by the server at call time — that is the correct way to get "the latest" and avoids drifting to a stale pin.

### Listing concrete models

The `consult_llm` `model` parameter documents only provider **selectors** (`gemini`, `openai`, …) — never present that selector list as "all available models." This server (v2.13.x) has **no** model-list tool and **no** concrete `enum` in its schema (the concrete IDs were deliberately replaced by selectors); it writes the real, per-session list to its **startup log** instead. To list models:

1. Read the **latest** `AVAILABLE MODELS:` block (equivalently the `CONFIGURATION` → `allowedModels` line) from `~/.local/state/consult-llm-mcp/mcp.log`. (If a future server version exposes a concrete `enum` on `model` or a list-models tool, prefer that.)
2. Keep only **Gemini** (`gemini-*`) and **OpenAI** (`gpt-*`) IDs — this deployment configures only those two providers; ignore any `anthropic`/`deepseek`/`minimax` entries and never surface them.
3. Print the IDs grouped under **Gemini** and **OpenAI** in chat, then ask one compact follow-up — **Latest Gemini** (`model: "gemini"`), **Latest OpenAI** (`model: "openai"`), **Both**, or the automatic **Other** free-text to type an exact ID — and call `consult_llm` with the chosen exact ID (a selector only for "latest").

If the log can't be read, say exact model discovery is unavailable this session and offer only the **Gemini** and **OpenAI** selectors, clearly labelled as selectors (not models).

## Step 2 — Build the prompt and call

1. Identify what to discuss — a code/architecture question, a file or function to review, or a design decision.
2. Build a context-rich, one-shot prompt; attach relevant file paths via the `files` parameter when code is involved (include everything needed — the consult is one-shot).
3. Call `consult_llm` with the chosen `model` (a selector for "latest", or the exact ID the user named/picked). Set `task_mode`: `"review"` for code review, `"plan"` for architecture, `"debug"` for troubleshooting, `"general"` otherwise.

## Step 3 — Present and synthesize

- Label each response with the model that produced it.
- When more than one provider was consulted, highlight agreements and disagreements.
- Add your own synthesis — don't just relay the raw responses.

## Examples

- "consult llms whether we should use KV or D1 for session storage" → no model named → show the dialog → on **Latest OpenAI**, call `consult_llm(model: "openai", task_mode: "plan", …)`.
- "ask Gemini to review the auth middleware" → provider named, no specific model → call `consult_llm(model: "gemini", task_mode: "review", files: ["…"])`.
- "ask gpt-5.5 about this approach" → exact model named → call `consult_llm(model: "gpt-5.5", task_mode: "general", …)`.

## Troubleshooting

If the `consult_llm` tool is not available:

1. Confirm your OpenAI/Gemini keys are saved in **Settings → LLM API Keys** (or that you are logged into Codex for OpenAI).
2. Restart your session — keys and CLI logins apply at session start.
3. Note: enterprise deployments do not expose LLM API Keys or consult-llm; models route through the managed AI Gateway instead.
