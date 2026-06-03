/**
 * Contract tests: verify that the Zod enums / object shapes duplicated between
 * the Worker (src/) and the web-ui (web-ui/src/) stay in sync.
 *
 * These schemas are intentionally duplicated because the two halves build into
 * separate targets (Workers runtime vs browser bundle) and cannot share a
 * module without a build step. The pure-Zod web-ui schema module has no
 * DOM/Hono dependencies, so the Workers test runtime can import it directly via
 * relative path - the same approach used by constants.test.ts.
 *
 * If an enum gains/loses a member or a constraint changes in one copy but not
 * the other, these tests fail loudly so the wire contract can't silently drift
 * (CF-010).
 */
import { describe, it, expect } from 'vitest';
import {
  AgentTypeSchema as BackendAgentTypeSchema,
  SessionModeSchema as BackendSessionModeSchema,
  AccessTierSchema as BackendAccessTierSchema,
  SubscriptionTierSchema as BackendSubscriptionTierSchema,
} from '../../types';
import { TabConfigSchema as BackendTabConfigSchema } from '../../lib/schemas';

// Frontend schemas live in a separate build target but the same repo root.
import {
  AgentTypeSchema as FrontendAgentTypeSchema,
  SessionModeSchema as FrontendSessionModeSchema,
  AccessTierSchema as FrontendAccessTierSchema,
  SubscriptionTierSchema as FrontendSubscriptionTierSchema,
  TabConfigSchema as FrontendTabConfigSchema,
} from '../../../web-ui/src/lib/schemas';

describe('backend/frontend schema parity (CF-010)', () => {
  it('AgentType enum members match', () => {
    expect(FrontendAgentTypeSchema.options).toEqual(BackendAgentTypeSchema.options);
  });

  it('SessionMode enum members match', () => {
    expect(FrontendSessionModeSchema.options).toEqual(BackendSessionModeSchema.options);
  });

  it('AccessTier enum members match', () => {
    expect(FrontendAccessTierSchema.options).toEqual(BackendAccessTierSchema.options);
  });

  it('SubscriptionTier enum members match', () => {
    expect(FrontendSubscriptionTierSchema.options).toEqual(BackendSubscriptionTierSchema.options);
  });

  it('TabConfig is a single source of truth (worker re-exports the web-ui copy)', () => {
    // CF-018: the worker schema module re-exports TabConfigSchema from the
    // web-ui copy, so both names must resolve to the exact same object. If a
    // local worker definition is ever re-introduced, this strict identity
    // check fails loudly - duplication can no longer drift in silently.
    expect(BackendTabConfigSchema).toBe(FrontendTabConfigSchema);
  });

  it('TabConfig accepts/rejects identically across both copies', () => {
    const cases = [
      { id: '1', command: 'bash', label: 'Shell' },          // valid
      { id: '7', command: 'bash', label: 'Shell' },           // id out of "1".."6"
      { id: '1', command: 'x'.repeat(201), label: 'Shell' },  // command too long
      { id: '1', command: 'bash', label: 'x'.repeat(51) },    // label too long
    ];
    for (const c of cases) {
      expect(FrontendTabConfigSchema.safeParse(c).success)
        .toBe(BackendTabConfigSchema.safeParse(c).success);
    }
    // Sanity: the first case is valid, the rest invalid (guards against both
    // copies being uniformly broken, which would pass a pure equality check).
    expect(BackendTabConfigSchema.safeParse(cases[0]).success).toBe(true);
    expect(BackendTabConfigSchema.safeParse(cases[1]).success).toBe(false);
  });
});
