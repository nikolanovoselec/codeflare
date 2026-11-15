import { describe, expect, it } from 'vitest';
import {
  createDispatcherPhaseState, dispatcherPhaseContext,
  type DispatcherPhaseState, type DispatcherPhaseAuthority, type DispatcherJourneyResult,
} from '../../operators/dispatcher-phases';

// Read-only historical compatibility, not a Root coordinator or SDK workload.
// Activity uses the bootstrap comparison and context codec when reading retained
// intent4 evidence. No admission, transition, receipt binding or final collection
// is executed here. Live application policy belongs to codeflare-operator-dispatcher:
// test/renovate/ownership-plan.test.ts, legacy-admission-parity.test.ts,
// admission-assessment.test.ts and phase-inference-context.test.ts.
// Generic Root execution: dispatcher-application-ownership.test.ts. Local proof
// and the original 5a4c2eaf/266843f1 safety matrix: application-execution.test.ts.
const authority: DispatcherPhaseAuthority = {
  scope: 'activity', generation: 7, deadline: '2026-10-10T12:00:00Z',
  releaseDigest: 'a'.repeat(64), authorityDigest: 'b'.repeat(64),
  repositoryJson: '{ "repository": "owner/repo" }', assessmentBytes: 48 * 1024,
};
const frozen = [
  { pullRequest: 17, headSha: '1'.repeat(40) },
  { pullRequest: 18, headSha: '2'.repeat(40) },
];
const delivery = (n: number) => ({ deliveryToken: `token_${n}`, idempotencyKey: `delivery-${n}` });
const receipt = (n: number) => ({ submissionId: `sdk-${n}`, uid: 'original-instance', offset: `cursor-${n}` });
const ordinary = (index: number): DispatcherJourneyResult => ({ ...frozen[index],
  outcome: 'NOT_MERGED', decision: 'DO_NOT_MERGE', comment: 'Retained judgment' });
const bootstrap = () => createDispatcherPhaseState(authority.scope, authority.authorityDigest, delivery(0));
const discovery = (): DispatcherPhaseState => ({ ...bootstrap(), uid: receipt(0).uid,
  current: { phase: { kind: 'discovery' }, ...delivery(0), receipt: receipt(0) } });
// Literal persisted snapshots from the retired layout, not simulated transitions.
const target = (): DispatcherPhaseState => ({ ...bootstrap(), uid: receipt(0).uid,
  targets: structuredClone(frozen), results: [ordinary(0)],
  previous: [
    { submissionId: 'sdk-0', phase: { kind: 'discovery' }, outcome: 'completed' },
    { submissionId: 'sdk-1', phase: { kind: 'target', index: 0, target: frozen[0] }, outcome: 'completed' },
  ],
  current: { phase: { kind: 'target', index: 1, target: frozen[1] }, ...delivery(2), receipt: receipt(2) },
});
const final = (): DispatcherPhaseState => ({ ...target(),
  previous: [...target().previous,
    { submissionId: 'sdk-2', phase: { kind: 'target', index: 1, target: frozen[1] }, outcome: 'failed' }],
  current: { phase: { kind: 'final' }, ...delivery(3), receipt: receipt(3) },
});
const context = (state: DispatcherPhaseState, auth = authority, token = state.current.deliveryToken) =>
  dispatcherPhaseContext(state, auth, token);

describe('historical intent4 bootstrap and retained-context validation', () => {
  it('compares the exact unadmitted bootstrap without manufacturing a receipt or context', () => {
    const state = bootstrap();
    expect(state).toEqual({ version: 1, scope: 'activity', authorityDigest: authority.authorityDigest,
      current: { phase: { kind: 'discovery' }, ...delivery(0) }, previous: [], results: [] });
    expect(bootstrap()).toEqual(JSON.parse(JSON.stringify(state)));
    expect(() => context(state)).toThrow();
    expect(state.current).not.toHaveProperty('receipt');
    expect(state).not.toHaveProperty('uid');
  });

  it.each(['offset', 'acceptedAt'] as const)('reads the actual retained %s receipt without converting its format', format => {
    const state = discovery();
    if (format === 'acceptedAt') state.current.receipt = {
      submissionId: 'sdk-0', uid: 'original-instance', acceptedAt: '2026-10-10T11:59:00Z',
    };
    const before = structuredClone(state);
    const restored = JSON.parse(JSON.stringify(state));
    expect(context(restored)).toEqual({ version: 1, scope: authority.scope, generation: authority.generation,
      deadline: authority.deadline, releaseDigest: authority.releaseDigest, authorityDigest: authority.authorityDigest,
      submissionId: 'sdk-0', phase: { kind: 'discovery' }, deliveryToken: 'token_0' });
    expect(restored).toEqual(before);
    expect(restored.current.receipt).toEqual(before.current.receipt);
  });

  it('reads contiguous target/final history and leaves a failed predecessor gap unfilled', () => {
    for (const state of [target(), final()]) {
      const before = structuredClone(state);
      expect(context(state)).toEqual({ version: 1, scope: authority.scope, generation: authority.generation,
        deadline: authority.deadline, releaseDigest: authority.releaseDigest, authorityDigest: authority.authorityDigest,
        submissionId: state.current.receipt!.submissionId, phase: state.current.phase,
        deliveryToken: state.current.deliveryToken, previous: state.previous });
      expect(state).toEqual(before);
      expect(state.results).toEqual([ordinary(0)]);
    }
    const empty: DispatcherPhaseState = { ...discovery(), targets: [],
      previous: [{ submissionId: 'sdk-0', phase: { kind: 'discovery' }, outcome: 'completed' }],
      current: { phase: { kind: 'final' }, ...delivery(1), receipt: receipt(1) } };
    expect(context(empty).phase).toEqual({ kind: 'final' });
    expect(empty.results).toEqual([]);
  });

  it('allows absent progress only for actual failed predecessors, never a completed target', () => {
    const failed = final();
    failed.previous[1].outcome = 'failed'; failed.results = [];
    expect(context(failed).previous).toEqual(failed.previous);
    expect(failed.results).toEqual([]);
    const missing = final(); missing.results = [];
    expect(() => context(missing)).toThrow();
  });

  it('rejects noncontiguous, duplicated, foreign or impossible historical lineage without repairing it', () => {
    const state = target();
    const corrupted: DispatcherPhaseState[] = [
      { ...state, previous: [] },
      { ...state, previous: state.previous.slice(1) },
      { ...state, previous: [...state.previous].reverse() },
      { ...state, previous: [...state.previous, state.previous[1]] },
      { ...state, previous: [{ ...state.previous[0], outcome: 'failed' }, state.previous[1]] },
      { ...state, previous: [state.previous[0], { ...state.previous[1], submissionId: 'sdk-0' }] },
      { ...state, current: { ...state.current, phase: { kind: 'target', index: 0, target: frozen[0] } } },
      { ...state, current: { ...state.current, phase: { kind: 'target', index: 1, target: frozen[0] } } },
      { ...state, current: { ...state.current, receipt: { ...receipt(2), submissionId: 'sdk-1' } } },
      { ...state, current: { ...state.current, receipt: { ...receipt(2), uid: 'foreign-instance' } } },
      { ...state, uid: undefined }, { ...state, targets: undefined },
    ];
    for (const value of corrupted) {
      const before = structuredClone(value);
      expect(() => context(value)).toThrow();
      expect(value).toEqual(before);
    }
    const future = target(); future.results.push(ordinary(1));
    expect(() => context(future)).toThrow();
    const unadmitted = target(); delete unadmitted.current.receipt;
    expect(() => context(unadmitted)).toThrow();
  });

  it('rejects corrupt frozen coordinates and mismatched retained result prefixes', () => {
    for (const targets of [[frozen[0], frozen[0]],
      [{ ...frozen[0], pullRequest: 0 }, frozen[1]],
      [{ ...frozen[0], pullRequest: Number.MAX_SAFE_INTEGER + 1 }, frozen[1]],
      [{ ...frozen[0], headSha: 'A'.repeat(40) }, frozen[1]],
      [{ ...frozen[0], unknown: true }, frozen[1]]]) {
      expect(() => context({ ...target(), targets })).toThrow();
    }
    for (const row of [ordinary(1), { ...ordinary(0), headSha: 'f'.repeat(40) },
      { ...ordinary(0), comment: '' }, { ...ordinary(0), comment: 'x'.repeat(2001) },
      { ...ordinary(0), outcome: 'MERGED' }, { ...ordinary(0), extra: true }]) {
      expect(() => context({ ...target(), results: [row as DispatcherJourneyResult] })).toThrow();
    }
    const deferred = { ...frozen[0], outcome: 'DEFERRED' as const, reason: 'response-failed' as const };
    expect(context({ ...final(), results: [deferred] }).phase).toEqual({ kind: 'final' });
    for (const row of [{ ...deferred, decision: 'MERGE' }, { ...deferred, comment: 'unpaired' },
      { ...deferred, reason: 'unknown-reason' }]) {
      expect(() => context({ ...final(), results: [row as DispatcherJourneyResult] })).toThrow();
    }
  });

  it('rejects malformed historical receipts rather than binding, replacing or normalizing them', () => {
    for (const bad of [{ ...receipt(0), submissionId: '' }, { ...receipt(0), submissionId: 'x'.repeat(129) },
      { ...receipt(0), uid: '' }, { ...receipt(0), uid: 'x'.repeat(513) },
      { ...receipt(0), offset: '' }, { ...receipt(0), offset: 'x'.repeat(2049) },
      { ...receipt(0), acceptedAt: '2026-10-10T11:59:00Z' },
      { submissionId: 'sdk-0', uid: 'original-instance', acceptedAt: 'not-a-date' }]) {
      expect(() => context({ ...discovery(), current: { ...discovery().current, receipt: bad } })).toThrow();
    }
    const noIncarnation = discovery(); delete noIncarnation.uid;
    expect(() => context(noIncarnation)).toThrow();
  });

  it('validates the original authority envelope and exact token, without treating valid historical data as live authority', () => {
    const state = target();
    for (const auth of [{ ...authority, scope: 'foreign' }, { ...authority, authorityDigest: 'c'.repeat(64) },
      { ...authority, generation: 0 }, { ...authority, generation: Number.MAX_SAFE_INTEGER + 1 },
      { ...authority, releaseDigest: 'bad' }, { ...authority, deadline: 'not-a-date' },
      { ...authority, assessmentBytes: 0 }, { ...authority, repositoryJson: '{"repository":"owner/repo","extra":true}' }]) {
      expect(() => context(state, auth)).toThrow();
    }
    for (const token of ['token_0', '', 'bad token', 'x'.repeat(129)]) expect(() => context(state, authority, token)).toThrow();
    // This is a historical codec, not a deadline authorizer. It returns the
    // original expired timestamp; only Activity's current authority gates I/O.
    const expired = { ...authority, deadline: '2000-01-01T00:00:00Z' };
    expect(context(state, expired).deadline).toBe(expired.deadline);
  });

  it('rejects invalid bootstrap delivery envelopes without generating replacements', () => {
    for (const credentials of [{ deliveryToken: '', idempotencyKey: 'valid' },
      { deliveryToken: 'bad token', idempotencyKey: 'valid' }, { deliveryToken: 'x'.repeat(129), idempotencyKey: 'valid' },
      { deliveryToken: 'valid', idempotencyKey: '' }, { deliveryToken: 'valid', idempotencyKey: 'x'.repeat(257) }]) {
      expect(() => createDispatcherPhaseState('activity', authority.authorityDigest, credentials)).toThrow();
    }
    expect(() => createDispatcherPhaseState('', authority.authorityDigest, delivery(0))).toThrow();
    expect(() => createDispatcherPhaseState('activity', 'bad-digest', delivery(0))).toThrow();
  });

  it('does not mutate persisted state/authority or expose aliases through a returned context', () => {
    const state = target(); const before = structuredClone([state, authority]);
    const projected = context(state);
    projected.previous![0].outcome = 'failed';
    if (projected.phase.kind !== 'target') throw Error('Historical target expected');
    projected.phase.target.headSha = 'f'.repeat(40);
    expect([state, authority]).toEqual(before);
    const reordered = Object.fromEntries(Object.entries(state).reverse()) as DispatcherPhaseState;
    expect(context(reordered)).toEqual(context(state));
  });
});
