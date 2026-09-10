interface ProfileIdentity { id: string; name?: string }

// Presentation metadata only: canonical profile names, hashes and references remain immutable.
const BUILTIN_PRESENTATION: Record<string, { label: string; basis: string }> = {
  'workers-ai-kimi-k-thinking': { label: 'Workers AI · Kimi', basis: 'Tested with Kimi through Workers AI.' },
  'workers-ai-glm-thinking': { label: 'Workers AI · GLM', basis: 'Tested with GLM through Workers AI.' },
  'workers-ai-gemma-thinking': { label: 'Workers AI · Gemma', basis: 'Tested with Gemma through Workers AI.' },
  'openai-gpt-chat-tools-reasoning': { label: 'OpenAI · GPT — tools and reasoning', basis: 'Tested with GPT through OpenAI, including tools and supported reasoning controls.' },
  'openai-gpt-chat-tools-off': { label: 'OpenAI · GPT — reasoning off', basis: 'Tested with GPT through OpenAI using tools with reasoning disabled.' },
  'codeflare-inference-mesh-binary-thinking': { label: 'Codeflare Inference Mesh · Qwen / Ornith', basis: 'Tested with Qwen and Ornith through Codeflare Inference Mesh.' },
  'bedrock-anthropic-compat': { label: 'Amazon Bedrock · Claude native', basis: 'Externally validated with Claude Sonnet 5 and Opus 5 through the codeflare-enterprise gateway.' },
  'native-google-ai-studio-compat': { label: 'Google AI Studio · Gemini native', basis: 'Live-tested with Gemini 3.1 Pro and 3.7/3.8 Flash, including signed tool replay.' },
  'native-openai-compat': { label: 'OpenAI · GPT-5.6 native tools-off', basis: 'Live-tested with GPT-5.6 Sol, Terra, and Luna using tools with reasoning disabled.' },
  'native-codeflare-inference-mesh-compat': { label: 'Codeflare Inference Mesh · Ornith native', basis: 'Live-tested with ornith-1-5-9b-gguf-q8-0, including streaming tool replay.' },
};

export function profileDisplayName(profile: ProfileIdentity): string {
  return Object.prototype.hasOwnProperty.call(BUILTIN_PRESENTATION, profile.id)
    ? BUILTIN_PRESENTATION[profile.id].label : profile.name || profile.id;
}

export function profileValidationBasis(profile: ProfileIdentity): string | undefined {
  return Object.prototype.hasOwnProperty.call(BUILTIN_PRESENTATION, profile.id)
    ? BUILTIN_PRESENTATION[profile.id].basis : undefined;
}
