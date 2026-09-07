import { describe, expect, it, vi } from 'vitest';

vi.mock('zod', () => { throw new Error('Browser configuration parsing must not load backend dependencies'); });
vi.mock('../../lib/reasoning-verification', () => { throw new Error('Browser configuration parsing must not load Worker verification'); });

import { parseReasoningConfiguration, serializeReasoningConfiguration } from '../../lib/reasoning-configuration';
import { getBuiltInProfileRef } from '../../lib/reasoning-profiles';

const profileRef = getBuiltInProfileRef('openai-gpt-chat-tools-off');
const verification = {
  schemaVersion: 1, profileRef, routeVersion: 'version-1', inventoryDigest: 'a'.repeat(64),
  connectionFingerprint: 'b'.repeat(64), canaryVersion: 'canary-1', supportedLevels: ['off'],
  scope: 'single-model', checkedAt: '2026-01-01T00:00:00.000Z',
};
const configuration = {
  schemaVersion: 1, customProfileRevisions: [], routeAssignments: { working: { activeProfile: profileRef, verification } },
  fallbackRouting: { enabled: true, routes: ['working'], defaultRoute: 'working', reasoning: 'off' },
};

describe('browser-safe checked reasoning configuration (REQ-ENTERPRISE-043/-044)', () => {
  it('round-trips saved authority and fallback without Worker or zod dependencies', () => {
    expect(parseReasoningConfiguration(serializeReasoningConfiguration(configuration))).toEqual(configuration);
  });
  it.each([
    { supportedLevels: ['off', 'off'] }, { supportedLevels: [] }, { scope: 'all-legs' },
    { checkedAt: '2026-02-30T00:00:00Z' }, { routeVersion: '../route' }, { extra: true },
    { profileRef: { ...profileRef, id: 'unsafe/id' } },
  ])('rejects malformed saved authority %j', (change) => {
    expect(() => parseReasoningConfiguration({ ...configuration, routeAssignments: { working: { activeProfile: profileRef, verification: { ...verification, ...change } } } })).toThrow();
  });
  it.each([
    { enabled: false, routes: ['working'] },
    { enabled: true, routes: ['working', 'working'], defaultRoute: 'working', reasoning: 'off' },
    { enabled: true, routes: ['working'], defaultRoute: 'other', reasoning: 'off' },
    { enabled: true, routes: ['constructor'], defaultRoute: 'constructor', reasoning: 'off' },
  ])('rejects malformed fallback %j', (fallbackRouting) => {
    expect(() => parseReasoningConfiguration({ ...configuration, fallbackRouting })).toThrow();
  });
});
