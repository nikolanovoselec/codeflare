---
name: consult-llm
description: Consult external LLMs (OpenAI GPT, Google Gemini) for a second opinion via the consult_llm tool. Use when the user says "consult llms", "ask LLMs", "get a second opinion", "ask GPT", "ask ChatGPT", "ask Gemini", "consult Gemini", "what do other LLMs think".
---

# Consult LLM (Pi): Query External AI Models

Query external LLM providers via the `consult_llm` tool (promoted to a first-class tool by the pi-mcp-adapter) and present their responses for comparison. Two providers are available: **OpenAI** (GPT) and **Google Gemini**.

The server picks the backend automatically — for OpenAI it uses your **Codex subscription** when you are logged into Codex (no API spend), otherwise your OpenAI API key; for Gemini it uses your Gemini API key. Keys/login are managed in **Settings → LLM API Keys** (and `codex login`) and take effect on the next session start.

## Step 1 — Choose the model

**If the user named a specific model** ("ask gpt-5.5…", "use gemini-3.1-pro…") → use that exact model ID, no dialog.

**Otherwise show an `ask_user_question` dialog** (single-select) so the user picks. Provide these four options — the tool automatically adds an "Other" free-text choice, giving **five** total:

1. **Latest Google (Gemini)** — call with the selector `model: "gemini"`.
2. **Latest OpenAI (GPT)** — call with the selector `model: "openai"`.
3. **Both** — call once per provider (`"gemini"` and `"openai"`) and synthesize across them.
4. **List all available models** — present the OpenAI and Gemini models `consult_llm` exposes (read the supported set from the `consult_llm` tool's `model` parameter), then ask which one to use and call with that exact model ID.
5. *(Other — added automatically)* the user types the **exact model** they want → pass it verbatim.

**Never hardcode a model ID for "latest."** The selectors `"openai"` / `"gemini"` are resolved to the current best flagship by the server at call time — that is the correct way to get "the latest" and avoids drifting to a stale pin.

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
