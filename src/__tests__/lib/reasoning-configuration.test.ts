import { describe, expect, it } from 'vitest';
import { canonicalHash, getBuiltInProfileRef, normalizeCustomProfile } from '../../lib/reasoning-profiles';

async function subject(): Promise<any> {
  const modulePath = '../../lib/reasoning-configuration';
  return import(modulePath);
}

const empty = { schemaVersion: 1, customProfileRevisions: [], routeAssignments: {} };

function customRevision(overrides: Record<string, unknown> = {}) {
  return normalizeCustomProfile({
    id: 'custom-revision', name: 'Custom revision', schemaVersion: 1, revision: 1, enabled: true,
    supportedLevels: ['off'], removePaths: ['reasoning_effort'],
    levels: { off: [{ path: 'thinking_mode', value: 'disabled' }] },
    offSemantics: { status: 'explicit-value', path: 'thinking_mode', value: 'disabled' },
    recognizedResponseFields: { content: ['choices[].message.content'] },
    ...overrides,
  });
}

describe('REQ-ENTERPRISE-031 atomic reasoning configuration', () => {
  it('parses one bounded document and preserves exact route and leg profile references', async () => {
    const { parseReasoningConfiguration } = await subject();
    const profileRef = getBuiltInProfileRef('workers-ai-glm-thinking');
    const input = {
      ...empty,
      routeAssignments: {
        mesh: {
          activeProfile: profileRef,
          routeVersion: 'route-v1',
          legs: [{ nodeId: 'primary', provider: 'custom-mesh', declaredModel: 'mesh', customProviderBackend: 'ornith-1.5', profileRef }],
          commonMapping: (() => {
            const levels = { medium: { removePaths: [], writes: [{ path: 'reasoning_effort', value: 'medium' }] } };
            return { levels, digest: canonicalHash(levels) };
          })(),
        },
      },
    };
    expect(parseReasoningConfiguration(input)).toEqual(input);
  });

  it('serialize/parse round-trips the canonical configuration without changing assignments', async () => {
    const { parseReasoningConfiguration, serializeReasoningConfiguration } = await subject();
    const activeProfile = getBuiltInProfileRef('workers-ai-glm-thinking');
    const configuration = {
      schemaVersion: 1,
      customProfileRevisions: [],
      routeAssignments: {
        development: {
          activeProfile,
          routeVersion: 'route-v7',
          legs: [{
            nodeId: 'primary', provider: 'workers-ai', declaredModel: 'glm-4.7-flash',
            profileRef: activeProfile, evidence: { current: true, toolReplay: true },
          }],
        },
      },
    };

    const serialized = serializeReasoningConfiguration(configuration);

    expect(parseReasoningConfiguration(serialized)).toEqual(configuration);
    expect(serializeReasoningConfiguration(parseReasoningConfiguration(serialized))).toBe(serialized);
  });

  it('accepts an exact enabled custom revision and rejects a disabled assigned revision', async () => {
    const { parseReasoningConfiguration } = await subject();
    const custom = normalizeCustomProfile({
      id: 'custom-safe', name: 'Custom safe', schemaVersion: 1, revision: 1, enabled: true,
      supportedLevels: ['off'], removePaths: ['reasoning_effort'],
      levels: { off: [{ path: 'thinking_mode', value: 'disabled' }] },
      offSemantics: { status: 'explicit-value', path: 'thinking_mode', value: 'disabled' },
      recognizedResponseFields: { content: ['choices[].message.content'] },
    });
    const activeProfile = { id: custom.id, revision: custom.revision, hash: custom.hash };
    expect(parseReasoningConfiguration({ ...empty, customProfileRevisions: [custom], routeAssignments: { route: { activeProfile } } }))
      .toMatchObject({ routeAssignments: { route: { activeProfile } } });
    const disabled = normalizeCustomProfile({ ...custom, enabled: false, hash: undefined });
    expect(() => parseReasoningConfiguration({ ...empty, customProfileRevisions: [disabled], routeAssignments: { route: { activeProfile: { ...activeProfile, hash: disabled.hash } } } }))
      .toThrow(/disabled/i);
  });

  it('fails rather than truncating oversized documents, paths, revisions, or non-scalars', async () => {
    const { parseReasoningConfiguration } = await subject();
    expect(() => parseReasoningConfiguration({ ...empty, padding: 'x'.repeat(256 * 1024) })).toThrow(/size|unknown/i);
    expect(() => parseReasoningConfiguration({ ...empty, customProfileRevisions: Array.from({ length: 65 }, (_, revision) => ({ id: 'x', revision })) })).toThrow(/revision|64/i);
  });

  it('rejects non-canonical built-in revision hashes', async () => {
    const { parseReasoningConfiguration } = await subject();
    expect(() => parseReasoningConfiguration({
      ...empty,
      routeAssignments: { route: { activeProfile: { ...getBuiltInProfileRef('workers-ai-glm-thinking'), hash: 'a'.repeat(64) } } },
    })).toThrow(/canonical|missing/i);
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
    expect(result.proposed.routeAssignments.general).toMatchObject({
      activeProfile: { id: 'workers-ai-glm-thinking' },
      migration: { sourceProfileId: 'workers-ai-glm-5.3' },
    });
    expect(result.proposed.routeAssignments.development).toMatchObject({
      activeProfile: { id: 'workers-ai-kimi-k-thinking' },
      migration: { sourceProfileId: 'workers-ai-kimi-k2.6' },
    });
    expect(result.persisted).toBe(false);
  });

  it('uses valid legacy assignments only when the atomic configuration is absent, without persistence', async () => {
    const { parseReasoningConfigurationWithLegacyFallback } = await subject();
    const configuration = parseReasoningConfigurationWithLegacyFallback(undefined, JSON.stringify({
      general: { contextWindow: 262144, reasoningProfile: 'workers-ai-glm-5.3' },
      development: { contextWindow: 262144, reasoningProfile: 'workers-ai-kimi-k2.6' },
    }));
    expect(configuration.routeAssignments.general.activeProfile.id).toBe('workers-ai-glm-thinking');
    expect(configuration.routeAssignments.development.activeProfile.id).toBe('workers-ai-kimi-k-thinking');
  });

  it('does not fall back over an unreadable atomic configuration or accept malformed/GPT-OSS legacy data', async () => {
    const { parseReasoningConfigurationWithLegacyFallback } = await subject();
    const validLegacy = JSON.stringify({
      general: { contextWindow: 262144, reasoningProfile: 'workers-ai-glm-5.3' },
    });
    expect(() => parseReasoningConfigurationWithLegacyFallback('{not-json', validLegacy)).toThrow(/invalid JSON/i);
    expect(() => parseReasoningConfigurationWithLegacyFallback('', validLegacy)).toThrow(/invalid JSON/i);
    expect(() => parseReasoningConfigurationWithLegacyFallback(undefined, '{not-json')).toThrow(/administrator correction/i);
    expect(() => parseReasoningConfigurationWithLegacyFallback(undefined, JSON.stringify({
      review: { contextWindow: 262144, reasoningProfile: 'workers-ai-gpt-oss' },
    }))).toThrow(/GPT-OSS/i);
  });

  it('surfaces malformed legacy records as safe migration errors without proposing assignments', async () => {
    const { migrateLegacyReasoningAssignments } = await subject();
    const malformedDocument = migrateLegacyReasoningAssignments({ routeSettings: '{not-json' });
    expect(malformedDocument.proposed.routeAssignments).toEqual({});
    expect(malformedDocument.errors).toEqual([
      expect.objectContaining({ code: 'legacy_configuration_malformed' }),
    ]);
    expect(malformedDocument.persisted).toBe(false);

    const malformedRoute = migrateLegacyReasoningAssignments({
      routeSettings: { development: { contextWindow: 262144, reasoningProfile: { unsafe: true } } },
    });
    expect(malformedRoute.proposed.routeAssignments).toEqual({});
    expect(malformedRoute.errors).toEqual([
      expect.objectContaining({ code: 'legacy_assignment_malformed', route: 'development' }),
    ]);
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
    const custom = normalizeCustomProfile({
      id: 'custom-a', name: 'Custom A', schemaVersion: 1, revision: 2, enabled: true,
      supportedLevels: ['off'], removePaths: [],
      levels: { off: [{ path: 'thinking_mode', value: 'disabled' }] },
      offSemantics: { status: 'explicit-value', path: 'thinking_mode', value: 'disabled' },
      recognizedResponseFields: { content: ['choices[].message.content'] },
    });
    const profileRef = { id: custom.id, revision: custom.revision, hash: custom.hash };
    const current = {
      schemaVersion: 1,
      customProfileRevisions: [custom],
      routeAssignments: { route: { activeProfile: profileRef, legs: [{ nodeId: 'leg', provider: 'custom', declaredModel: 'alias', customProviderBackend: 'backend', profileRef }] } },
    };
    expect(() => validateReasoningConfigurationUpdate(current, { ...current, customProfileRevisions: [] }))
      .toThrow(/referenced/i);
    expect(() => validateReasoningConfigurationUpdate(current, { ...current, customProfileRevisions: [], routeAssignments: {} }))
      .toThrow(/referenced/i);
  });

  it('REQ-ENTERPRISE-031 AC3: rejects an in-place mutation of an existing custom revision', async () => {
    const { validateReasoningConfigurationUpdate } = await subject();
    const currentRevision = customRevision();
    const mutatedRevision = customRevision({ name: 'Mutated revision' });
    const current = { ...empty, customProfileRevisions: [currentRevision] };

    expect(() => validateReasoningConfigurationUpdate(current, { ...current, customProfileRevisions: [mutatedRevision] }))
      .toThrow(/immutable/i);
  });

  it('REQ-ENTERPRISE-031 AC3: raw references protect revisions before malformed assignments can bypass collection or disable checks', async () => {
    const { validateReasoningConfigurationUpdate } = await subject();
    const revision = customRevision();
    const profileRef = { id: revision.id, revision: revision.revision, hash: revision.hash };
    const malformedAssignment = {
      activeProfile: getBuiltInProfileRef('workers-ai-glm-thinking'),
      legs: [{ profileRef }],
    };
    const current = { ...empty, customProfileRevisions: [revision], routeAssignments: { route: malformedAssignment } };

    expect(() => validateReasoningConfigurationUpdate(current, { ...empty, customProfileRevisions: [] }))
      .toThrow(/referenced and cannot be collected/i);

    const disabled = customRevision({ enabled: false });
    expect(() => validateReasoningConfigurationUpdate(
      { ...empty, customProfileRevisions: [revision] },
      { ...empty, customProfileRevisions: [disabled], routeAssignments: { route: malformedAssignment } },
    )).toThrow(/referenced and cannot be disabled/i);
  });

  it('REQ-ENTERPRISE-031 AC3: rejects malformed route assignments and route legs', async () => {
    const { parseReasoningConfiguration } = await subject();
    const activeProfile = getBuiltInProfileRef('workers-ai-glm-thinking');
    const leg = { nodeId: 'primary', provider: 'workers-ai', declaredModel: 'glm', profileRef: activeProfile };
    const malformed = [
      { assignment: null, error: /must be an object/i },
      { assignment: { activeProfile, legs: {} }, error: /legs must be an array/i },
      { assignment: { activeProfile, legs: [{ ...leg, provider: 'custom-mesh' }] }, error: /backend provenance/i },
      { assignment: { activeProfile, legs: [leg, leg] }, error: /duplicate nodeId/i },
    ];

    for (const { assignment, error } of malformed) {
      expect(() => parseReasoningConfiguration({ ...empty, routeAssignments: { route: assignment } })).toThrow(error);
    }
  });

  it('REQ-ENTERPRISE-031 AC3: rejects non-canonical common mappings', async () => {
    const { parseReasoningConfiguration } = await subject();
    const activeProfile = getBuiltInProfileRef('workers-ai-glm-thinking');
    const invalidLevels = [
      { turbo: { removePaths: [], writes: [] } },
      { medium: { removePaths: ['reasoning_effort', 'reasoning_effort'], writes: [] } },
      { medium: { removePaths: [], writes: [{ path: 'reasoning_effort', value: 'low' }, { path: 'reasoning_effort', value: 'high' }] } },
    ];

    for (const levels of invalidLevels) {
      expect(() => parseReasoningConfiguration({
        ...empty,
        routeAssignments: { route: { activeProfile, commonMapping: { levels, digest: canonicalHash(levels) } } },
      })).toThrow(/unsupported level|unique|duplicate path/i);
    }
    const levels = { medium: { removePaths: [], writes: [] } };
    expect(() => parseReasoningConfiguration({
      ...empty,
      routeAssignments: { route: { activeProfile, commonMapping: { levels, digest: '0'.repeat(64) } } },
    })).toThrow(/digest is not canonical/i);
  });

  it('REQ-ENTERPRISE-031 AC3: rejects unsafe route-leg evidence summaries', async () => {
    const { parseReasoningConfiguration } = await subject();
    const activeProfile = getBuiltInProfileRef('workers-ai-glm-thinking');
    const assignmentWithEvidence = (evidence: unknown) => ({
      activeProfile,
      legs: [{ nodeId: 'primary', provider: 'workers-ai', declaredModel: 'glm', profileRef: activeProfile, evidence }],
    });

    for (const evidence of [
      { 'invalid-key': true },
      { attempts: Array.from({ length: 21 }, () => true) },
      { current: { nested: true } },
    ]) {
      expect(() => parseReasoningConfiguration({
        ...empty, routeAssignments: { route: assignmentWithEvidence(evidence) },
      })).toThrow(/invalid key|too many summaries|sanitized scalar/i);
    }
  });
});
