/**
 * Property-based fuzz tests for the post-March-2026 parser surface:
 * vault route dispatch + bucket tokens (REQ-VAULT-021), the SilverBullet
 * service-worker graft (REQ-VAULT-023/024/025), the Governed-Mode regime
 * state machine (REQ-ENTERPRISE-018/020), and the Pi session-JSONL helpers
 * (REQ-MEM-001, REQ-VAULT-003).
 *
 * Same harness contract as input-validation.fuzz.test.ts: each property is a
 * real application invariant. CI runs 50k iterations (FAST_CHECK_NUM_RUNS);
 * local runs 1k.
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { validateVaultRoute } from '../../routes/vault-validation';
import { VAULT_BUCKET_TOKEN_PATTERN, getVaultBucketToken } from '../../lib/vault-bucket-token';
import { SESSION_ID_PATTERN } from '../../lib/constants';
import { graftVaultKeyRecovery, VAULT_NATIVE_SW_VERBATIM } from '../../routes/vault-native-sw';
import { getRegimeState, resolveReadRegime, type RegimeState } from '../../lib/r2-regime-state';
import {
  parseSessionMessages,
  isChildSessionFirstLine,
  isVaultExcludedPath,
  VAULT_GENERATED_PREFIXES,
} from '../../../preseed/agents/pi/extensions/memory-vault-helpers';

const NUM_RUNS = parseInt(process.env.FAST_CHECK_NUM_RUNS || '1000');
// WebCrypto digests are async; 50k awaited SHA-256 rounds would dominate the CI
// job for no extra edge coverage. Explicitly capped (not silently) — the input
// space is exercised identically, just fewer rounds.
const ASYNC_NUM_RUNS = Math.min(NUM_RUNS, 5000);

// Charset that survives URL parsing verbatim in a path segment: no dots (URL
// dot-segment normalization), no '%' (escape decoding), no '/', '?', '#'.
const SEGMENT_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_~';
const segmentArb = fc
  .array(fc.constantFrom(...SEGMENT_CHARS.split('')), { minLength: 1, maxLength: 48 })
  .map((a) => a.join(''));
const hex32Arb = fc
  .array(fc.constantFrom(...'0123456789abcdef'.split('')), { minLength: 32, maxLength: 32 })
  .map((a) => a.join(''));

function vaultRequest(path: string, upgrade?: string): Request {
  return new Request(`https://worker.example${path}`, {
    headers: upgrade === undefined ? {} : { Upgrade: upgrade },
  });
}

// ---------------------------------------------------------------------------
// Vault route dispatch — the newest externally-reachable parser in the worker.
// A 32-hex first segment routes as a bucket token, a session-pattern segment
// routes session-keyed, anything else is a 400. Exactly one outcome, always.
// ---------------------------------------------------------------------------
describe('Fuzz: validateVaultRoute', () => {
  it('never throws and yields exactly one outcome (token XOR session XOR 400) for any vault path', () => {
    fc.assert(
      fc.property(segmentArb, segmentArb, (first, rest) => {
        const result = validateVaultRoute(vaultRequest(`/api/vault/${first}/${rest}`));
        expect(result.isVaultRoute).toBe(true);
        const outcomes = [result.bucketToken, result.sessionId, result.errorResponse].filter(
          (o) => o !== undefined,
        );
        expect(outcomes).toHaveLength(1);
        if (VAULT_BUCKET_TOKEN_PATTERN.test(first)) {
          expect(result.bucketToken).toBe(first);
          expect(result.remainingPath).toBe(`/${rest}`);
        } else if (SESSION_ID_PATTERN.test(first)) {
          expect(result.sessionId).toBe(first);
          expect(result.remainingPath).toBe(`/${rest}`);
        } else {
          expect(result.errorResponse?.status).toBe(400);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('a bare /api/vault/<segment> (no trailing slash) is never a vault proxy route', () => {
    fc.assert(
      fc.property(segmentArb, (first) => {
        expect(validateVaultRoute(vaultRequest(`/api/vault/${first}`)).isVaultRoute).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('non-vault paths never claim the vault route', () => {
    fc.assert(
      fc.property(segmentArb, segmentArb, (a, b) => {
        expect(validateVaultRoute(vaultRequest(`/${a}/${b}`)).isVaultRoute).toBe(false);
        expect(validateVaultRoute(vaultRequest(`/api/${a}/${b}`)).isVaultRoute).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('the WebSocket flag follows the Upgrade header case-insensitively and only for "websocket"', () => {
    fc.assert(
      fc.property(
        hex32Arb,
        fc.oneof(
          fc.constantFrom('websocket', 'WebSocket', 'WEBSOCKET'),
          segmentArb, // arbitrary other Upgrade values
          fc.constant(undefined), // header absent
        ),
        (token, upgrade) => {
          const result = validateVaultRoute(vaultRequest(`/api/vault/${token}/x`, upgrade));
          expect(result.isWebSocket).toBe(upgrade !== undefined && upgrade.toLowerCase() === 'websocket');
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Bucket token derivation — the bucket-stable vault URL key (REQ-VAULT-021).
// The 32-hex shape is load-bearing: it is what disambiguates token routing
// from session-id routing in validateVaultRoute.
// ---------------------------------------------------------------------------
describe('Fuzz: getVaultBucketToken', () => {
  it('always yields a 32-hex token that can never collide with the session-id namespace', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), async (bucket) => {
        const token = await getVaultBucketToken(bucket);
        expect(token).toMatch(VAULT_BUCKET_TOKEN_PATTERN);
        // Routing disambiguation: a token must never parse as a session id,
        // or /api/vault/<sid>/ requests could be captured by the token branch.
        expect(SESSION_ID_PATTERN.test(token)).toBe(false);
      }),
      { numRuns: ASYNC_NUM_RUNS },
    );
  });

  it('is deterministic per bucket and distinct across distinct buckets', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.tuple(fc.string(), fc.string()).filter(([a, b]) => a !== b),
        async ([a, b]) => {
          const [ta1, ta2, tb] = await Promise.all([
            getVaultBucketToken(a),
            getVaultBucketToken(a),
            getVaultBucketToken(b),
          ]);
          expect(ta1).toBe(ta2);
          expect(ta1).not.toBe(tb);
        },
      ),
      { numRuns: ASYNC_NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// SilverBullet SW graft — string surgery on served JavaScript. The failure
// class is silent: a bad graft output means the browser refuses to register
// the service worker and the vault never becomes ready.
// ---------------------------------------------------------------------------
describe('Fuzz: graftVaultKeyRecovery', () => {
  it('throws (never returns a silently un-grafted worker) for any input missing the anchors', () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        expect(() => graftVaultKeyRecovery(input)).toThrow(/anchor/);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('is single-shot: grafting an already-grafted worker throws instead of double-patching', () => {
    // A second graft would wrap the remote-list guard IIFE in another IIFE and
    // re-inject the recovery helpers — the anchor consumption is the guard.
    const grafted = graftVaultKeyRecovery(VAULT_NATIVE_SW_VERBATIM);
    expect(() => graftVaultKeyRecovery(grafted)).toThrow(/anchor/);
  });
});

// ---------------------------------------------------------------------------
// Governed-Mode regime state machine (REQ-ENTERPRISE-018/020).
// ---------------------------------------------------------------------------
const regimeArb = fc.constantFrom<'sse-c' | 'plain'>('sse-c', 'plain');
const statusArb = fc.constantFrom<'ready' | 'migrating' | 'mixed-recovery'>(
  'ready',
  'migrating',
  'mixed-recovery',
);
const regimeStateArb: fc.Arbitrary<RegimeState> = fc.record(
  {
    status: statusArb,
    regime: regimeArb,
    generation: fc.integer(),
    from: regimeArb,
    to: regimeArb,
    cursor: fc.oneof(fc.string(), fc.constant(null)),
    phase: fc.constantFrom<'migrate' | 'verify'>('migrate', 'verify'),
    total: fc.nat(),
    processed: fc.nat(),
    halted: fc.boolean(),
    lastError: fc.string(),
  },
  { requiredKeys: ['status', 'regime', 'generation'] },
);

describe('Fuzz: resolveReadRegime', () => {
  it('always picks exactly one primary regime and self-heals only on ready buckets', () => {
    fc.assert(
      fc.property(regimeStateArb, (state) => {
        const r = resolveReadRegime(state);
        // Exactly one read path is primary; the other is the SSE-mismatch fallback.
        expect(r.primary).toBe(!r.fallback);
        expect(r.primary).toBe(state.regime === 'plain');
        // A fallback HIT on a ready bucket means a stray outlier -> heal; a
        // migrating bucket legitimately holds both regimes -> never heal.
        expect(r.selfHealOnFallbackHit).toBe(state.status === 'ready');
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('Fuzz: getRegimeState KV hardening', () => {
  // Arbitrary KV garbage a partial write / manual edit could leave behind.
  const kvGarbageArb = fc.oneof(
    fc.constant(null),
    fc.string(),
    fc.integer(),
    fc.boolean(),
    fc.object(),
    fc.record({ status: fc.oneof(fc.constant(''), fc.constant(null)) }, { requiredKeys: [] }),
    regimeStateArb,
  );

  function kvEnv(stateValue: unknown, prefsValue: unknown) {
    return {
      KV: {
        get: async (key: string) => (key.includes('r2-regime') ? stateValue : prefsValue),
      },
    } as never;
  }

  it('never throws and always yields a state with status+regime, defaulting malformed KV content', async () => {
    await fc.assert(
      fc.asyncProperty(
        kvGarbageArb,
        fc.oneof(fc.constant(null), fc.object(), fc.record({ r2SseRegime: fc.oneof(fc.constant('plain'), fc.string()) }, { requiredKeys: [] })),
        async (stored, prefs) => {
          const state = await getRegimeState(kvEnv(stored, prefs), 'bucket-x');
          expect(state.status).toBeTruthy();
          expect(state.regime).toBeTruthy();
          const shapeValid = Boolean(
            stored && typeof stored === 'object' && (stored as RegimeState).status && (stored as RegimeState).regime,
          );
          if (shapeValid) {
            // A shape-valid stored state is returned verbatim (KV is an
            // internal boundary; setRegimeState is the only writer).
            expect(state).toEqual(stored);
          } else {
            // Malformed/absent -> safe default: ready, honoring only the
            // legacy 'plain' migration marker from user preferences.
            expect(state.status).toBe('ready');
            const legacyPlain = Boolean(prefs && (prefs as { r2SseRegime?: string }).r2SseRegime === 'plain');
            expect(state.regime).toBe(legacyPlain ? 'plain' : 'sse-c');
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Pi session-JSONL helpers — parse untrusted session-file content
// (REQ-MEM-001 AC7/AC8, REQ-VAULT-003 AC7).
// ---------------------------------------------------------------------------
describe('Fuzz: parseSessionMessages', () => {
  it('never throws on arbitrary content and returns only message payloads', () => {
    fc.assert(
      fc.property(fc.string(), (content) => {
        const messages = parseSessionMessages(content);
        expect(Array.isArray(messages)).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('extracts exactly the message entries, in order, dropping headers/compaction/garbage', () => {
    const entryArb = fc.oneof(
      fc.record({ type: fc.constant('message' as const), message: fc.record({ role: fc.constantFrom('user', 'assistant', 'toolResult') }) }),
      fc.record({ type: fc.constant('session' as const), id: fc.string() }),
      fc.record({ type: fc.constant('compaction' as const), summary: fc.string() }),
      fc.constant('not json at all {'),
    );
    fc.assert(
      fc.property(fc.array(entryArb, { maxLength: 30 }), (entries) => {
        const jsonl = entries
          .map((e) => (typeof e === 'string' ? e : JSON.stringify(e)))
          .join('\n');
        const expected = entries.filter(
          (e): e is { type: 'message'; message: { role: string } } =>
            typeof e !== 'string' && e.type === 'message',
        );
        const messages = parseSessionMessages(jsonl);
        expect(messages).toHaveLength(expected.length);
        expect(messages.map((m) => m.role)).toEqual(expected.map((e) => e.message.role));
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('Fuzz: isChildSessionFirstLine', () => {
  it('never throws and only accepts a session header with a non-empty string parentSession', () => {
    fc.assert(
      fc.property(fc.string(), (line) => {
        expect(typeof isChildSessionFirstLine(line)).toBe('boolean');
      }),
      { numRuns: NUM_RUNS },
    );
    fc.assert(
      fc.property(
        fc.record(
          {
            type: fc.oneof(fc.constant('session'), fc.constant('message'), fc.string()),
            parentSession: fc.oneof(fc.string(), fc.integer(), fc.constant(null)),
          },
          { requiredKeys: ['type'] },
        ),
        (header) => {
          const expected =
            header.type === 'session' &&
            typeof header.parentSession === 'string' &&
            header.parentSession.length > 0;
          expect(isChildSessionFirstLine(JSON.stringify(header))).toBe(expected);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('Fuzz: isVaultExcludedPath segment awareness', () => {
  const VAULT = '/home/user/Vault';
  const nameArb = fc
    .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-'.split('')), { minLength: 1, maxLength: 24 })
    .map((a) => a.join(''));

  it('excludes everything under a generated prefix, but never a prefix-similar sibling directory', () => {
    fc.assert(
      fc.property(fc.constantFrom(...VAULT_GENERATED_PREFIXES), nameArb, (prefix, name) => {
        expect(isVaultExcludedPath(VAULT, `${VAULT}/${prefix}/${name}.md`)).toBe(true);
        // 'Raw/GraphsX' must not be swallowed by the 'Raw/Graphs' rule: the
        // match is segment-aware, not a naive substring startsWith.
        const sibling = `${VAULT}/${prefix}X/${name}.md`;
        const siblingRel = `${prefix}X/${name}.md`;
        const coveredByOtherRule = VAULT_GENERATED_PREFIXES.some(
          (p) => siblingRel === p || siblingRel.startsWith(`${p}/`),
        );
        expect(isVaultExcludedPath(VAULT, sibling)).toBe(coveredByOtherRule);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
