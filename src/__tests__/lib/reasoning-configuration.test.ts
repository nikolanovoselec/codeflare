import { describe, expect, it } from 'vitest';

async function subject(): Promise<any> {
  const modulePath = '../../lib/reasoning-configuration';
  return import(modulePath);
}

const empty = { schemaVersion: 1, customProfileRevisions: [], routeAssignments: {} };

describe('REQ-ENTERPRISE-031 atomic reasoning configuration', () => {
  it('parses one bounded document and preserves exact route and leg profile references', async () => {
    const { parseReasoningConfiguration } = await subject();
    const profileRef = { id: 'workers-ai-glm-thinking', revision: 1, hash: 'a'.repeat(64) };
    const input = {
      ...empty,
      routeAssignments: {
        mesh: {
          activeProfile: profileRef,
          routeVersion: 'route-v1',
          legs: [{ nodeId: 'primary', provider: 'custom-mesh', declaredModel: 'mesh', customProviderBackend: 'ornith-1.5', profileRef }],
          commonMapping: { levels: { medium: { removePaths: [], writes: [{ path: 'reasoning_effort', value: 'medium' }] } }, digest: 'b'.repeat(64) },
        },
      },
    };
    expect(parseReasoningConfiguration(input)).toEqual(input);
  });

  it('fails rather than truncating oversized documents, paths, revisions, or non-scalars', async () => {
    const { parseReasoningConfiguration } = await subject();
    expect(() => parseReasoningConfiguration({ ...empty, padding: 'x'.repeat(256 * 1024) })).toThrow(/size|unknown/i);
    expect(() => parseReasoningConfiguration({ ...empty, customProfileRevisions: Array.from({ length: 65 }, (_, revision) => ({ id: 'x', revision })) })).toThrow(/revision|64/i);
  });

  it('proposes GLM and Kimi migration in preview without persisting it', async () => {
    const { migrateLegacyReasoningAssignments } = await subject();
    const result = migrateLegacyReasoningAssignments({
      routeSettings: {
        general: { contextWindow: 262144, reasoningProfile: 'workers-ai-glm-5.3' },
        development: { contextWindow: 262144, reasoningProfile: 'workers-ai-kimi-k2.6' },
      },
      defaults: { global: { route: 'general', reasoning: 'medium' }, groups: {} },
    });
    expect(result.proposed.routeAssignments.general.activeProfile.id).toBe('workers-ai-glm-thinking');
    expect(result.proposed.routeAssignments.development.activeProfile.id).toBe('workers-ai-kimi-k-thinking');
    expect(result.persisted).toBe(false);
  });

  it('leaves GPT-OSS unresolved and requires correction for a Kimi off startup default', async () => {
    const { migrateLegacyReasoningAssignments } = await subject();
    const result = migrateLegacyReasoningAssignments({
      routeSettings: {
        review: { contextWindow: 262144, reasoningProfile: 'workers-ai-gpt-oss' },
        development: { contextWindow: 262144, reasoningProfile: 'workers-ai-kimi-k2.6' },
      },
      defaults: { global: { route: 'development', reasoning: 'off' }, groups: {} },
    });
    expect(result.proposed.routeAssignments.review).toBeUndefined();
    expect(result.errors.map((error: any) => error.code)).toEqual(expect.arrayContaining([
      'legacy_profile_unresolved',
      'default_level_unmapped',
    ]));
    expect(result.persisted).toBe(false);
  });

  it('rejects disabling or collecting a custom revision while a route or leg references it', async () => {
    const { validateReasoningConfigurationUpdate } = await subject();
    const profileRef = { id: 'custom-a', revision: 2, hash: 'c'.repeat(64) };
    const current = {
      schemaVersion: 1,
      customProfileRevisions: [{ id: 'custom-a', revision: 2, hash: 'c'.repeat(64), enabled: true }],
      routeAssignments: { route: { activeProfile: profileRef, legs: [{ nodeId: 'leg', provider: 'custom', declaredModel: 'alias', profileRef }] } },
    };
    expect(() => validateReasoningConfigurationUpdate(current, { ...current, customProfileRevisions: [] }))
      .toThrow(/referenced/i);
  });
});
