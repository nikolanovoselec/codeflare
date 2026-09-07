interface ProfileIdentity { id: string; name?: string }

// Presentation metadata only: canonical profile names, hashes and references remain immutable.
const BUILTIN_PRESENTATION: Record<string, { label: string; basis: string }> = {
  'workers-ai-kimi-k-thinking': { label: 'Workers AI · Kimi', basis: 'Tested with Kimi through Workers AI.' },
  'workers-ai-glm-thinking': { label: 'Workers AI · GLM', basis: 'Tested with GLM through Workers AI.' },
  'workers-ai-gemma-thinking': { label: 'Workers AI · Gemma', basis: 'Tested with Gemma through Workers AI.' },
  'openai-gpt-chat-tools-reasoning': { label: 'OpenAI · GPT — tools and reasoning', basis: 'Tested with GPT through OpenAI, including tools and supported reasoning controls.' },
  'openai-gpt-chat-tools-off': { label: 'OpenAI · GPT — reasoning off', basis: 'Tested with GPT through OpenAI using tools with reasoning disabled.' },
  'codeflare-inference-mesh-binary-thinking': { label: 'Codeflare Inference Mesh · Qwen / Ornith', basis: 'Tested with Qwen and Ornith through Codeflare Inference Mesh.' },
};

export function profileDisplayName(profile: ProfileIdentity): string {
  return Object.prototype.hasOwnProperty.call(BUILTIN_PRESENTATION, profile.id)
    ? BUILTIN_PRESENTATION[profile.id].label : profile.name || profile.id;
}

export function profileValidationBasis(profile: ProfileIdentity): string | undefined {
  return Object.prototype.hasOwnProperty.call(BUILTIN_PRESENTATION, profile.id)
    ? BUILTIN_PRESENTATION[profile.id].basis : undefined;
}
