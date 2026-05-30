---
name: consult-llm
description: This skill should be used when the user wants to consult external LLMs for a second opinion or discussion. Use when the user says "discuss with llms", "consult llms", "consult LLMs", "ask LLMs", "get LLM opinions", "what do other LLMs think", "ask ChatGPT", "consult Gemini", "ask GPT", "get a second opinion", "ask another AI".
version: 2.1.0
---

# Consult LLM: Query External AI Models

This skill queries external LLM providers via the `consult_llm` MCP tool and presents their responses for comparison.

There are exactly two configured providers: **OpenAI** (GPT) and **Google Gemini**. API keys are managed in **Settings > LLM API Keys** and injected at session start.

## Prerequisites

API keys must be configured in **Settings > LLM API Keys** before using this skill. Keys take effect on the next session start.

- **OpenAI**: Get your API key from https://platform.openai.com/api-keys
- **Gemini**: Get your API key from https://aistudio.google.com/apikey

## Step 1 - Decide which provider(s) to consult

- **User named a provider explicitly** ("ask GPT", "ask OpenAI", "ask ChatGPT", "ask Gemini", "ask Google") -> use exactly that provider. No dialog.
- **User did NOT name a provider** ("consult an LLM", "get a second opinion", "what do other LLMs think") -> you MUST show an `AskUserQuestion` dialog (multi-select) letting the user choose which of the two configured providers to consult:
  - Option 1: **OpenAI (GPT)**
  - Option 2: **Google Gemini**
  - multiSelect: true, so the user can pick one or both.
  - Do NOT silently default to "both" or to one provider. Always ask when ambiguous.
- If the user selects both, consult each provider and synthesize across the responses.

## Step 2 - Resolve the LATEST flagship model (never an old default)

NEVER rely on the `consult_llm` server's configured default model - it is a static pin that drifts to OLD versions (this is the bug that makes consults land on stale models like an old gpt-5.x). You must pass an explicit `model`, and unless the user named a specific model, it must be the provider's **current latest flagship**.

Do NOT hardcode a model ID from memory - resolve it live at call time from the provider's own model list:

- **OpenAI** - pick the newest flagship GPT (highest version number; prefer the general flagship, not `mini`/`nano`/`codex`/`-chat`/specialised variants, unless the user asks):
  ```
  curl -s https://api.openai.com/v1/models \
    -H "Authorization: Bearer $OPENAI_API_KEY" \
    | jq -r '.data[].id' | sort
  ```
- **Google Gemini** - prefer the `gemini-pro-latest` alias (Google maintains it as the current flagship Pro). If you need to verify or the alias is unavailable, pick the newest flagship `gemini-*-pro` (highest version; prefer `pro` over `flash`/`flash-lite`, exclude `image`/`tts`/`embedding`/`robotics`/`preview-customtools` variants) unless the user asks otherwise:
  ```
  curl -s "https://generativelanguage.googleapis.com/v1beta/models?key=$GEMINI_API_KEY" \
    | jq -r '.models[].name' | sort
  ```

If the user names a specific model ("use gpt-5.x", "use gemini flash"), honour that exact choice instead of auto-picking the flagship.

## Step 3 - Build the prompt and call

1. **Identify what to discuss.** Extract the topic from the user's message - a code/architecture question, a file or function to review, a design decision, or a general question.
2. **Construct a context-rich prompt.** Include the question, relevant file paths via the `files` parameter (if code is involved), and enough background for a useful answer. The consult is one-shot - include everything needed.
3. **Call `consult_llm`** once per chosen provider, each with an explicit `model` (the latest flagship from Step 2 - never the server default). Set `task_mode` appropriately: `"review"` for code review, `"plan"` for architecture, `"debug"` for troubleshooting, `"general"` otherwise.

## Step 4 - Present and synthesize

- Label each response with the model name (the exact model ID you used).
- Highlight agreements and disagreements when more than one provider was consulted.
- Add your own synthesis - don't just relay the raw responses.

## Example Usage

**User:** "consult llms whether we should use KV or D1 for session storage"
- No provider named -> show AskUserQuestion (OpenAI / Gemini, multi-select).
- For each chosen provider, resolve its latest flagship model, then call with task_mode `plan`.

**User:** "ask Gemini what it thinks about this approach"
- Provider named (Gemini) -> no dialog.
- Resolve latest flagship Gemini Pro, call with task_mode `general`.

**User:** "ask GPT-5.x to review the auth middleware"
- Provider + specific model named -> use that exact model, task_mode `review`, include the middleware file path.

## Troubleshooting

If the `consult_llm` tool is not available:

1. Check that your API keys are saved in **Settings > LLM API Keys**
2. Restart your session (keys are injected at session start)
3. Verify your API keys are valid and have sufficient quota
