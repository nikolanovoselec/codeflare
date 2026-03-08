---
name: consult-llm
description: This skill should be used when the user wants to consult external LLMs for a second opinion or discussion. Use when the user says "discuss with llms", "consult llms", "consult LLMs", "ask LLMs", "get LLM opinions", "what do other LLMs think", "ask ChatGPT", "consult Gemini", "ask GPT", "get a second opinion", "ask another AI", "discuss with code llms", "consult code llms". The user may specify an LLM type like "code" to select code-specialized models.
version: 2.0.0
---

# Consult LLM: Query External AI Models

This skill queries external LLM providers via the `consult_llm` MCP tool, sending the same prompt to two models in parallel and presenting both responses for comparison.

## Prerequisites

API keys must be configured in **Settings > LLM API Keys** before using this skill. Keys take effect on the next session start.

- **OpenAI**: Get your API key from https://platform.openai.com/api-keys
- **Gemini**: Get your API key from https://aistudio.google.com/apikey

## Model Selection

The user can specify an LLM type as a parameter. Parse the type from the user's message.

### Default (no type specified)

When the user says "discuss with llms", "consult llms", or similar without specifying a type:

| Provider | Model ID |
|----------|----------|
| OpenAI | `gpt-5.4` |
| Google | `gemini-3.1-pro-preview` |

### Code LLMs

When the user says "discuss with code llms", "consult code llms", "ask code llms", or includes the word "code" before "llm(s)":

| Provider | Model ID |
|----------|----------|
| OpenAI | `gpt-5.3-codex` |
| Google | `gemini-3.1-pro-preview` |

## How to Invoke

When this skill triggers, follow these steps:

1. **Parse the LLM type** from the user's message. Look for "code" before "llm" — if present, use Code LLMs. Otherwise, use Default.

2. **Identify what to discuss.** The user's message contains both the trigger ("discuss with llms") and the topic. Extract the topic — it may be:
   - A question about the current code or architecture
   - A specific file or function to review
   - A design decision to evaluate
   - A general programming question

3. **Construct the prompt.** Build a clear, context-rich prompt for the external models. Include:
   - The user's question or topic
   - Relevant file paths via the `files` parameter (if the discussion involves code)
   - Enough context for the external model to give a useful answer

4. **Call `consult_llm` twice in parallel** — once for each model in the selected pair. Use the same prompt and files for both. Set `task_mode` appropriately (`"review"` for code review, `"plan"` for architecture, `"debug"` for troubleshooting, `"general"` for everything else).

5. **Present both responses** to the user with clear attribution:
   - Label each response with the model name
   - Highlight agreements and disagreements between the two
   - Add your own synthesis if the responses diverge

## Example Usage

**User:** "discuss with llms whether we should use KV or D1 for session storage"
- Type: Default (no "code" keyword)
- Models: gpt-5.4 + gemini-3.1-pro-preview
- Task mode: plan

**User:** "consult code llms about this function" (while viewing a file)
- Type: Code
- Models: gpt-5.3-codex + gemini-3.1-pro-preview
- Task mode: review

**User:** "ask llms to review the auth middleware"
- Type: Default
- Models: gpt-5.4 + gemini-3.1-pro-preview
- Task mode: review
- Files: include the auth middleware file path

## Available Models Reference

All models available via the `consult_llm` MCP tool:

| Model ID | Provider | Best for |
|----------|----------|----------|
| `gpt-5.4` | OpenAI | Latest reasoning, general tasks |
| `gpt-5.2` | OpenAI | General tasks, fast |
| `gpt-5.3-codex` | OpenAI | Code generation and review |
| `gpt-5.2-codex` | OpenAI | Code generation, fast |
| `gemini-3.1-pro-preview` | Google | Latest Gemini, broad reasoning |
| `gemini-3-pro-preview` | Google | Gemini, stable |
| `gemini-2.5-pro` | Google | Gemini, established |

## Troubleshooting

If the `consult_llm` tool is not available:

1. Check that your API keys are saved in **Settings > LLM API Keys**
2. Restart your session (keys are injected at session start)
3. Verify your API keys are valid and have sufficient quota
