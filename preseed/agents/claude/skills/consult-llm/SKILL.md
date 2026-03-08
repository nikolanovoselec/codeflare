---
name: consult-llm
description: This skill should be used when the user wants to query an external LLM (ChatGPT, Gemini, GPT-4, etc.) from within their coding session. Use this skill when the user says things like "ask ChatGPT", "consult Gemini", "what would GPT say", "get a second opinion", "ask another AI", or wants to compare answers from different models. This skill requires API keys configured in Settings.
version: 1.0.0
---

# Consult LLM: Query External AI Models

This skill lets you query external LLM providers (OpenAI, Google Gemini) directly from your coding session using the `consult_llm` MCP tool.

## Prerequisites

You must have API keys configured in **Settings > LLM API Keys** before using this skill. Keys take effect on the next session start.

- **OpenAI**: Get your API key from https://platform.openai.com/api-keys
- **Gemini**: Get your API key from https://aistudio.google.com/apikey

## How to Use

The `consult_llm` MCP tool is automatically available when API keys are configured. Use it to:

- Get a second opinion on code or architecture decisions
- Compare approaches by asking another model
- Translate between programming languages
- Ask for explanations from a different perspective

## Example Invocations

Ask Claude to use the tool naturally:

- "Ask ChatGPT how it would implement this function"
- "Get Gemini's opinion on this database schema"
- "Consult GPT-4 about the best approach for caching"
- "What would another AI suggest for this error?"

## Available Models

- **OpenAI**: GPT-4o, GPT-4, GPT-3.5 (requires OpenAI API key)
- **Gemini**: Gemini Pro, Gemini Flash (requires Gemini API key)

## Troubleshooting

If the `consult_llm` tool is not available:

1. Check that your API keys are saved in **Settings > LLM API Keys**
2. Restart your session (keys are injected at session start)
3. Verify your API keys are valid and have sufficient quota
