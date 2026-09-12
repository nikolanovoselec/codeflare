interface ProfileIdentity { id: string; name?: string }

// Presentation metadata only: canonical profile names, hashes and references remain immutable.
const BUILTIN_PRESENTATION: Record<string, { label: string; basis: string }> = {
  'workers-ai-kimi-k-thinking': { label: 'Dynamic Route - Workers AI - Kimi', basis: 'Tested with Kimi through Workers AI.' },
  'workers-ai-glm-thinking': { label: 'Dynamic Route - Workers AI - GLM', basis: 'Tested with GLM through Workers AI.' },
  'workers-ai-gemma-thinking': { label: 'Dynamic Route - Workers AI - Gemma', basis: 'Tested with Gemma through Workers AI.' },
  'openai-gpt-chat-tools-reasoning': { label: 'Dynamic Route - OpenAI - GPT tools and reasoning', basis: 'Tested with GPT through OpenAI, including tools and supported reasoning controls.' },
  'openai-gpt-chat-tools-off': { label: 'Dynamic Route - OpenAI - GPT reasoning off', basis: 'Tested with GPT through OpenAI using tools with reasoning disabled.' },
  'codeflare-inference-mesh-binary-thinking': { label: 'Dynamic Route - Codeflare Inference Mesh - Qwen/Ornith', basis: 'Tested with Qwen and Ornith through Codeflare Inference Mesh.' },
  'dynamic-bedrock-anthropic-provider-default': { label: 'Dynamic Route - AWS Bedrock - Claude', basis: 'Tested with Claude Sonnet 5 and Opus 5 through Bedrock Dynamic Routes using streaming tool replay.' },
  'bedrock-anthropic-compat': { label: 'Native Route - AWS Bedrock - Claude', basis: 'Externally validated with Claude Sonnet 5 and Opus 5 through the codeflare-enterprise gateway.' },
  'bedrock-anthropic-native-sonnet': { label: 'Native Route - AWS Bedrock - Claude Sonnet', basis: 'Validated with Claude Sonnet 5 through provider-native Bedrock transport.' },
  'bedrock-anthropic-native-opus-stream': { label: 'Native Route - AWS Bedrock - Claude Opus', basis: 'Validated with Claude Opus 5 through provider-native Bedrock transport.' },
  'bedrock-anthropic-native-opus-invoke': { label: 'Native Route - AWS Bedrock - Claude Opus', basis: 'Validated with Claude Opus 5 through provider-native Bedrock transport.' },
  'bedrock-anthropic-native-opus-auto': { label: 'Native Route - AWS Bedrock - Claude Opus', basis: 'Validated with Claude Opus 5 through provider-native Bedrock transport.' },
  'native-google-ai-studio-compat': { label: 'Native Route - Google AI Studio - Gemini', basis: 'Live-tested with Gemini 3.1 Pro and 3.7/3.8 Flash, including signed tool replay.' },
  'native-openai-compat': { label: 'Native Route - OpenAI - GPT-5.6 tools off', basis: 'Live-tested with GPT-5.6 Sol, Terra, and Luna using tools with reasoning disabled.' },
  'native-codeflare-inference-mesh-compat': { label: 'Native Route - Codeflare Inference Mesh - Qwen/Ornith', basis: 'Live-tested with ornith-1-5-9b-gguf-q8-0, including streaming tool replay.' },
};

export function profileDisplayName(profile: ProfileIdentity): string {
  return Object.prototype.hasOwnProperty.call(BUILTIN_PRESENTATION, profile.id)
    ? BUILTIN_PRESENTATION[profile.id].label : profile.name || profile.id;
}

export function profileValidationBasis(profile: ProfileIdentity): string | undefined {
  return Object.prototype.hasOwnProperty.call(BUILTIN_PRESENTATION, profile.id)
    ? BUILTIN_PRESENTATION[profile.id].basis : undefined;
}
