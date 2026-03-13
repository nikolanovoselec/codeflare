---
name: consult-llm
description: This skill should be used when the user wants to consult external LLMs for a second opinion or discussion. Use when the user says "discuss with llms", "consult llms", "consult LLMs", "ask LLMs", "get LLM opinions", "what do other LLMs think", "ask ChatGPT", "consult Gemini", "ask GPT", "get a second opinion", "ask another AI".
version: 2.0.0
---

# Consult LLM: Query External AI Models

This skill queries external LLM providers via the `consult_llm` MCP tool, sending the same prompt to two models in parallel and presenting both responses for comparison.

## Prerequisites

API keys must be configured in **Settings > LLM API Keys** before using this skill. Keys take effect on the next session start.

- **OpenAI**: Get your API key from https://platform.openai.com/api-keys
- **Gemini**: Get your API key from https://aistudio.google.com/apikey

## Model Selection

By default, query both models in parallel:

| Provider | Model ID |
|----------|----------|
| OpenAI | `gpt-5.4` |
| Google | `gemini-3.1-pro-preview` |

If the user explicitly names a model (e.g., "ask GPT", "consult Gemini", "use gpt-5.2"), only call that model instead of both.

All supported models: `gpt-5.4`, `gpt-5.2`, `gpt-5.3-codex`, `gpt-5.2-codex`, `gemini-3.1-pro-preview`, `gemini-3-pro-preview`, `gemini-2.5-pro`. If the user asks what models are available, list these.

## How to Invoke

When this skill triggers, follow these steps:

1. **Check for explicit model selection.** If the user specifies a model by name, use only that model. Otherwise, use both defaults in parallel.

2. **Identify what to discuss.** The user's message contains both the trigger and the topic. Extract the topic — it may be:
   - A question about the current code or architecture
   - A specific file or function to review
   - A design decision to evaluate
   - A general programming question

3. **Construct the prompt.** Build a clear, context-rich prompt for the external models. Include:
   - The user's question or topic
   - Relevant file paths via the `files` parameter (if the discussion involves code)
   - Enough context for the external model to give a useful answer

4. **Call `consult_llm`** — once per selected model (both defaults in parallel, or a single explicit model). Use the same prompt and files for each. Set `task_mode` appropriately (`"review"` for code review, `"plan"` for architecture, `"debug"` for troubleshooting, `"general"` for everything else).

5. **Present responses** to the user with clear attribution:
   - Label each response with the model name
   - Highlight agreements and disagreements between the two
   - Add your own synthesis if the responses diverge

## Example Usage

**User:** "discuss with llms whether we should use KV or D1 for session storage"
- Models: gpt-5.4 + gemini-3.1-pro-preview
- Task mode: plan

**User:** "ask llms to review the auth middleware"
- Models: gpt-5.4 + gemini-3.1-pro-preview
- Task mode: review
- Files: include the auth middleware file path

**User:** "ask Gemini what it thinks about this approach"
- Models: gemini-3.1-pro-preview only
- Task mode: general

## Troubleshooting

If the `consult_llm` tool is not available:

1. Check that your API keys are saved in **Settings > LLM API Keys**
2. Restart your session (keys are injected at session start)
3. Verify your API keys are valid and have sufficient quota
