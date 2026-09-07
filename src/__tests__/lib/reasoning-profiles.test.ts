import { describe, expect, it } from 'vitest';
import * as profiles from '../../lib/reasoning-profiles';

const BUILTIN_IDS = [
  'openai-gpt-chat-tools-reasoning',
  'openai-gpt-chat-tools-off',
  'workers-ai-gemma-thinking',
  'workers-ai-kimi-k-thinking',
  'workers-ai-glm-thinking',
  'codeflare-inference-mesh-binary-thinking',
];

const NOTICE_IDS = [
  'gpt-oss-tool-replay',
  'gemini-chat-completions-tools',
  'gpt-6-astra-tools',
  'responses-required',
];

function customProfile(overrides: Record<string, unknown> = {}) {
  return {
    id: 'custom-validation', name: 'Custom validation', schemaVersion: 1, enabled: true,
    supportedLevels: ['off', 'medium'], removePaths: [],
    levels: {
      off: [{ path: 'thinking_mode', value: 'disabled' }],
      medium: [{ path: 'reasoning_effort', value: 'medium' }],
    },
    offSemantics: { status: 'explicit-value', path: 'thinking_mode', value: 'disabled' },
    recognizedResponseFields: { content: ['choices[].message.content'] },
    ...overrides,
  };
}

describe('REQ-ENTERPRISE-031 capability profile catalog', () => {
  it('ships exactly the six executable built-ins and keeps failed families as notices', () => {
    expect(profiles.REASONING_PROFILE_IDS).toEqual(BUILTIN_IDS);
    expect((profiles as any).COMPATIBILITY_NOTICES.map((notice: any) => notice.id)).toEqual(NOTICE_IDS);
  });

  it('normalizes bounded scalar mappings and rejects protected request roots', () => {
    const normalize = (profiles as any).normalizeCustomProfile;
    const valid = normalize({
      id: 'custom-binary',
      name: 'Custom binary',
      schemaVersion: 1,
      enabled: true,
      supportedLevels: ['off', 'medium'],
      removePaths: ['reasoning_effort'],
      levels: {
        off: [{ path: 'chat_template_kwargs.enable_thinking', value: false }],
        medium: [{ path: 'chat_template_kwargs.enable_thinking', value: true }],
      },
      offSemantics: { status: 'explicit-toggle', path: 'chat_template_kwargs.enable_thinking', value: false },
      recognizedResponseFields: { reasoning: ['choices[].message.reasoning_content'], content: ['choices[].message.content'] },
    });
    expect(valid.supportedLevels).toEqual(['off', 'medium']);

    for (const path of ['model', 'messages.0.content', 'tools', 'stream', 'headers.authorization', 'provider', 'chat_template_kwargs.__proto__.polluted']) {
      expect(() => normalize({ ...valid, id: 'blocked-path', levels: { off: [{ path, value: null }] } }))
        .toThrow(/protected|path/i);
    }
    expect(() => normalize({ ...valid, id: 'nested-value', levels: { off: [{ path: 'thinking', value: { enabled: false } }] } }))
      .toThrow(/scalar/i);
    expect(() => normalize({
      ...valid,
      id: 'mismatched-off',
      offSemantics: { status: 'explicit-value', path: 'reasoning_effort', value: 'none' },
    })).toThrow(/off semantics/i);
  });

  it('applies only validated removal paths and scalar writes while preserving transport fields', () => {
    const profile = (profiles as any).normalizeCustomProfile({
      id: 'custom-safe', name: 'Custom safe', schemaVersion: 1, enabled: true,
      supportedLevels: ['off'], removePaths: ['reasoning_effort', 'chat_template_kwargs.enable_thinking'],
      levels: { off: [{ path: 'chat_template_kwargs.enable_thinking', value: false }] },
      offSemantics: { status: 'explicit-toggle', path: 'chat_template_kwargs.enable_thinking', value: false },
      recognizedResponseFields: { content: ['choices[].message.content'] },
    });
    const translated = (profiles as any).translateReasoningRequest({
      model: 'selected', messages: [{ role: 'user', content: 'hello' }], tools: [{ type: 'function' }],
      reasoning_effort: 'high', chat_template_kwargs: { enable_thinking: true, unrelated: 'kept' },
    }, profile, 'off');
    expect(translated).toMatchObject({
      model: 'selected', messages: [{ role: 'user', content: 'hello' }], tools: [{ type: 'function' }],
      chat_template_kwargs: { enable_thinking: false, unrelated: 'kept' },
    });
  });

  it('maps binary non-off aliases to identical bytes and never aliases off to enabled', () => {
    const mesh = (profiles as any).BUILT_IN_REASONING_PROFILES.find((profile: any) => profile.id === 'codeflare-inference-mesh-binary-thinking');
    const normalized = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
      .map((level) => JSON.stringify(mesh.levels[level]));
    expect(new Set(normalized)).toHaveLength(1);
    expect(JSON.stringify(mesh.levels.off)).not.toBe(normalized[0]);
  });

  it('declares Kimi off unsupported rather than mapping it to low', () => {
    const kimi = (profiles as any).BUILT_IN_REASONING_PROFILES.find((profile: any) => profile.id === 'workers-ai-kimi-k-thinking');
    expect(kimi.supportedLevels).not.toContain('off');
    expect(kimi.unsupportedLevels).toContain('off');
  });

  it('REQ-ENTERPRISE-031 AC2: requires off to be a literal disable rather than an alias or enabled toggle', () => {
    expect(() => profiles.normalizeCustomProfile(customProfile({
      levels: { off: 'medium', medium: [{ path: 'reasoning_effort', value: 'medium' }] },
    }))).toThrow(/off cannot alias/i);
    expect(() => profiles.normalizeCustomProfile(customProfile({
      levels: {
        off: [{ path: 'chat_template_kwargs.enable_thinking', value: true }],
        medium: [{ path: 'reasoning_effort', value: 'medium' }],
      },
      offSemantics: { status: 'explicit-toggle', path: 'chat_template_kwargs.enable_thinking', value: true },
    }))).toThrow(/toggle must be false/i);
    expect(() => profiles.normalizeCustomProfile(customProfile({
      supportedLevels: ['medium'],
      levels: { medium: [{ path: 'reasoning_effort', value: 'medium' }] },
      offSemantics: { status: 'explicit-value', path: 'thinking_mode', value: 'disabled' },
    }))).toThrow(/must be unsupported/i);
  });

  it('REQ-ENTERPRISE-031 AC2: rejects self-referential, unsupported, and cyclic level aliases', () => {
    expect(() => profiles.normalizeCustomProfile(customProfile({
      levels: { off: [{ path: 'thinking_mode', value: 'disabled' }], medium: 'medium' },
    }))).toThrow(/alias for medium is invalid/i);
    expect(() => profiles.normalizeCustomProfile(customProfile({
      levels: { off: [{ path: 'thinking_mode', value: 'disabled' }], medium: 'high' },
    }))).toThrow(/alias for medium is invalid/i);
    expect(() => profiles.normalizeCustomProfile(customProfile({
      supportedLevels: ['low', 'medium'],
      levels: { low: 'medium', medium: 'low' },
      offSemantics: { status: 'unsupported' },
    }))).toThrow(/aliases contain a cycle/i);
  });

  it('REQ-ENTERPRISE-031 AC2: sanitizes evidence copies and rejects malformed evidence summaries', () => {
    const sourceTags = ['current', 'tool-replay'];
    const normalized = profiles.normalizeCustomProfile(customProfile({
      evidence: [{ current: true, attempts: 3, tags: sourceTags }],
      validatedAgainst: [{ routeVersion: 'route-v2' }],
    }));
    sourceTags.push('mutated-after-normalization');
    expect(normalized.evidence).toEqual([{ current: true, attempts: 3, tags: ['current', 'tool-replay'] }]);
    expect(normalized.validatedAgainst).toEqual([{ routeVersion: 'route-v2' }]);

    for (const evidence of [
      [{ 'invalid-key': true }],
      [{ nested: { unsafe: true } }],
      [{ tags: ['safe', 2] }],
    ]) {
      expect(() => profiles.normalizeCustomProfile(customProfile({ evidence })))
        .toThrow(/invalid field|sanitized scalar summaries/i);
    }
    expect(() => profiles.normalizeCustomProfile(customProfile({
      evidence: Array.from({ length: 20 }, () => ({ current: true })),
      validatedAgainst: [{ routeVersion: 'one-too-many' }],
    }))).toThrow(/validation summaries/i);
  });

  it('REQ-ENTERPRISE-031 AC2: accepts only allowlisted response evidence fields and paths', () => {
    expect(() => profiles.normalizeCustomProfile(customProfile({
      recognizedResponseFields: { secret: ['choices[].message.content'] },
    }))).toThrow(/recognized response fields are invalid/i);
    expect(() => profiles.normalizeCustomProfile(customProfile({
      recognizedResponseFields: { reasoning: ['choices[].message.unknown'] },
    }))).toThrow(/response path is unsupported/i);
    expect(() => profiles.normalizeCustomProfile(customProfile({
      recognizedResponseFields: { content: Array.from({ length: 17 }, () => 'choices[].message.content') },
    }))).toThrow(/recognized response fields are invalid/i);
  });
});
