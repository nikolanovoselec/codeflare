import { describe, expect, it } from 'vitest';
import { profileDisplayName, profileValidationBasis } from '../../components/admin/pi-profile-presentation';

describe('REQ-ENTERPRISE-045: provider-aware Pi compatibility profiles', () => {
  it.each([
    ['workers-ai-kimi-k-thinking', 'Workers AI · Kimi', 'Workers AI'],
    ['workers-ai-glm-thinking', 'Workers AI · GLM', 'Workers AI'],
    ['workers-ai-gemma-thinking', 'Workers AI · Gemma', 'Workers AI'],
    ['openai-gpt-chat-tools-reasoning', 'OpenAI · GPT — tools and reasoning', 'OpenAI'],
    ['openai-gpt-chat-tools-off', 'OpenAI · GPT — reasoning off', 'OpenAI'],
    ['codeflare-inference-mesh-binary-thinking', 'Codeflare Inference Mesh · Qwen / Ornith', 'Codeflare Inference Mesh'],
  ])('identifies the tested provider for %s without changing its reference', (id, label, provider) => {
    const profile = Object.freeze({ id, name: 'Canonical stored name', revision: 1, hash: 'a'.repeat(64) });
    expect(profileDisplayName(profile)).toBe(label);
    expect(profileValidationBasis(profile)).toContain(provider);
    expect(profile).toEqual({ id, name: 'Canonical stored name', revision: 1, hash: 'a'.repeat(64) });
  });

  it('preserves a custom name without inventing a tested provider', () => {
    const profile = { id: 'custom-team', name: 'Team translation' };
    expect(profileDisplayName(profile)).toBe('Team translation');
    expect(profileValidationBasis(profile)).toBeUndefined();
  });
});
