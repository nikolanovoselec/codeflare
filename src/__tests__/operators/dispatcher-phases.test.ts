import { describe, expect, it } from 'vitest';
import {
  createDispatcherPhaseState, dispatcherPhaseWire, bindDispatcherPhaseReceipt,
  dispatcherPhaseContext, advanceDispatcherPhase, collectDispatcherFinal,
  type DispatcherPhaseState, type DispatcherPhaseAuthority, type DispatcherPhaseReply,
  type DispatcherTarget, type DispatcherJourneyResult,
} from '../../operators/dispatcher-phases';

// Intentional contracts: fcb572b intent4 wire/lineage and public Flue 2.1.0 receipts.
// REQ-OPERATOR-048 AC2/3/4/5 and REQ-OPERATOR-062 AC3; Activity gates are separate.
const authority: DispatcherPhaseAuthority = {
  scope: 'activity', generation: 7, deadline: '2026-10-10T12:00:00Z',
  releaseDigest: 'a'.repeat(64), authorityDigest: 'b'.repeat(64),
  repositoryJson: '{ "repository": "owner/repo" }', assessmentBytes: 48 * 1024,
};
const delivery = (n: number) => ({ deliveryToken: `token_${n}`, idempotencyKey: `delivery-${n}` });
const targets = (n: number): DispatcherTarget[] => Array.from({ length: n }, (_, i) => ({
  pullRequest: i + 1, headSha: (i + 1).toString(16).padStart(40, '0'),
}));
const deferred = (target: DispatcherTarget): DispatcherJourneyResult => ({ ...target, outcome: 'DEFERRED', reason: 'response-failed' });
const ordinary = (target: DispatcherTarget, comment = 'actual judgment') => ({
  ...target, outcome: 'NOT_MERGED', decision: 'DO_NOT_MERGE', comment,
} satisfies DispatcherJourneyResult);
const receipt = (n: number) => ({ submissionId: `sdk-${n}`, uid: 'actual-instance-uid', offset: `cursor-${n}` });
const create = () => createDispatcherPhaseState(authority.scope, authority.authorityDigest, delivery(0));
const bind = (state: DispatcherPhaseState, n: number) => bindDispatcherPhaseReceipt(state, authority, state.current.deliveryToken, receipt(n));
const initial = () => bind(create(), 0);
const next = (frozen: DispatcherTarget[], index: number) => index < frozen.length
  ? { kind: 'target' as const, index, target: frozen[index] } : { kind: 'final' as const };
const progress = (state: DispatcherPhaseState, frozen: DispatcherTarget[], results: DispatcherJourneyResult[] = []) => ({
  version: 1, scope: authority.scope, generation: authority.generation,
  submissionId: state.current.receipt!.submissionId, phase: state.current.phase,
  next: next(frozen, state.current.phase.kind === 'target' ? state.current.phase.index + 1 : 0),
  ...(state.current.phase.kind === 'discovery' ? { targets: frozen } : { results }),
});
const reply = (state: DispatcherPhaseState, outcome: 'completed' | 'failed' | 'aborted' = 'completed', data: Record<string, unknown[]> = {}): DispatcherPhaseReply => ({
  submissionId: state.current.receipt!.submissionId, upToDate: true, outcome, data,
});
const step = (state: DispatcherPhaseState, response: DispatcherPhaseReply, n: number, auth = authority) =>
  advanceDispatcherPhase(state, auth, state.current.deliveryToken, response, delivery(n));
const discover = (frozen: DispatcherTarget[]) => bind(step(initial(), reply(initial(), 'completed', {
  'dispatcher-progress': [progress(initial(), frozen)],
}), 1), 1);
const finish = (state: DispatcherPhaseState, rows: DispatcherJourneyResult[], auth = authority) =>
  collectDispatcherFinal(state, auth, state.current.deliveryToken, reply(state, 'completed', {
    assessment: [{ repository: 'owner/repo', results: rows }],
  }));
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

describe('intent4 exact serial phase contract candidate', () => {
  it('persists delivery identity before admission; lost acknowledgement keeps the same create-only wire', () => {
    const state = create();
    const wire = { kind: 'signal', type: 'dispatcher-phase', body: authority.repositoryJson,
      attributes: { deliveryToken: 'token_0' }, uid: null, idempotencyKey: 'delivery-0' };
    expect(dispatcherPhaseWire(state, authority)).toEqual(wire);
    expect(dispatcherPhaseWire(JSON.parse(JSON.stringify(state)), authority)).toEqual(wire);
    expect(state).toEqual({ version: 1, scope: 'activity', authorityDigest: authority.authorityDigest,
      current: { phase: { kind: 'discovery' }, ...delivery(0) }, previous: [], results: [] });
    expect(() => dispatcherPhaseContext(state, authority, 'token_0')).toThrow();
    const adopted = bindDispatcherPhaseReceipt(state, authority, 'token_0', { ...receipt(0), offset: '-1', deduplicated: true });
    expect(adopted.current.receipt).toEqual({ ...receipt(0), offset: '-1' });
    expect(adopted.uid).toBe('actual-instance-uid');
    expect(dispatcherPhaseWire(adopted, authority)).toEqual(wire);
    expect(dispatcherPhaseContext(adopted, authority, 'token_0')).toEqual({
      version: 1, scope: authority.scope, generation: authority.generation,
      deadline: authority.deadline, releaseDigest: authority.releaseDigest, authorityDigest: authority.authorityDigest,
      submissionId: 'sdk-0', phase: { kind: 'discovery' }, deliveryToken: 'token_0',
    });
  });

  it('adopts replay identity without replacing an already-bound admission cursor', () => {
    const state = initial();
    const replayed = bindDispatcherPhaseReceipt(state, authority, 'token_0', { ...receipt(0), offset: '-1', deduplicated: true });
    expect(replayed).toEqual(state);
    // Activity's separately persisted projection cursor is outside this helper's API.
    expect(() => bindDispatcherPhaseReceipt(state, authority, 'token_0', { ...receipt(0), offset: 'conflicting-admission-cursor' })).toThrow();
  });

  it('runs all 30 targets with original UID, exact contexts, immutable actual prefixes and a sole final assessment', () => {
    const frozen = targets(30);
    let state = discover(frozen);
    const rows: DispatcherJourneyResult[] = [];
    for (let index = 0; index < 30; index++) {
      const context = dispatcherPhaseContext(state, authority, state.current.deliveryToken);
      expect(context).toEqual({ version: 1, scope: authority.scope, generation: 7,
        deadline: authority.deadline, releaseDigest: authority.releaseDigest, authorityDigest: authority.authorityDigest,
        submissionId: `sdk-${index + 1}`, phase: next(frozen, index), deliveryToken: `token_${index + 1}`,
        previous: state.previous });
      expect(context.previous).toHaveLength(index + 1);
      expect(dispatcherPhaseWire(state, authority)).toEqual({ kind: 'signal', type: 'dispatcher-phase',
        body: authority.repositoryJson, attributes: { deliveryToken: `token_${index + 1}` },
        uid: receipt(0).uid, idempotencyKey: `delivery-${index + 1}` });
      rows.push(ordinary(frozen[index]));
      state = bind(step(state, reply(state, 'completed', { 'dispatcher-progress': [progress(state, frozen, rows)] }), index + 2), index + 2);
      expect(state.results).toEqual(rows);
    }
    expect(state.current.phase).toEqual({ kind: 'final' });
    expect(state.previous).toHaveLength(31);
    expect(finish(state, rows)).toEqual({ repository: 'owner/repo', results: rows });
  });

  it('allows consecutive failed-before-intake phases, then accepts only an actual complete prefix', () => {
    const frozen = targets(4);
    let state = discover(frozen);
    for (let index = 0; index < 2; index++) {
      state = bind(step(state, reply(state, 'failed'), index + 2), index + 2);
      expect(state.results).toEqual([]);
    }
    expect(dispatcherPhaseContext(state, authority, state.current.deliveryToken).previous).toEqual([
      { submissionId: 'sdk-0', phase: { kind: 'discovery' }, outcome: 'completed' },
      { submissionId: 'sdk-1', phase: next(frozen, 0), outcome: 'failed' },
      { submissionId: 'sdk-2', phase: next(frozen, 1), outcome: 'failed' },
    ]);
    const actual = [deferred(frozen[0]), deferred(frozen[1]), ordinary(frozen[2])];
    state = bind(step(state, reply(state, 'completed', { 'dispatcher-progress': [progress(state, frozen, actual)] }), 4), 4);
    expect(state.results).toEqual(actual);
    state = bind(step(state, reply(state, 'failed'), 5), 5);
    expect(state.current.phase).toEqual({ kind: 'final' });
    expect(state.results).toEqual(actual);
    expect(() => finish(state, actual)).toThrow();
    expect(finish(state, [...actual, deferred(frozen[3])]).results).toEqual([...actual, deferred(frozen[3])]);
  });

  it('last failure without progress produces no synthetic result; final supplies the actual disposition', () => {
    const frozen = targets(1);
    const target = discover(frozen);
    const final = bind(step(target, reply(target, 'failed'), 2), 2);
    expect(final.results).toEqual([]);
    expect(finish(final, [deferred(frozen[0])]).results).toEqual([deferred(frozen[0])]);
    expect(() => finish(final, [])).toThrow();
  });

  it('failed target may carry valid progress, which remains immutable in the final response', () => {
    const frozen = targets(1), state = discover(frozen), row = ordinary(frozen[0]);
    const final = bind(step(state, reply(state, 'failed', { 'dispatcher-progress': [progress(state, frozen, [row])] }), 2), 2);
    expect(finish(final, [row]).results).toEqual([row]);
    expect(() => finish(final, [deferred(frozen[0])])).toThrow();
    expect(() => step(state, reply(state, 'failed', { 'dispatcher-progress': [{}] }), 2)).toThrow();
  });

  it('empty completed discovery advances directly to final, but failed discovery never freezes a scope', () => {
    const state = discover([]);
    expect(state.current.phase).toEqual({ kind: 'final' });
    expect(finish(state, [])).toEqual({ repository: 'owner/repo', results: [] });
    expect(() => step(initial(), reply(initial(), 'failed'), 1)).toThrow();
    expect(() => step(initial(), reply(initial(), 'failed', { 'dispatcher-progress': [progress(initial(), [])] }), 1)).toThrow();
    expect(() => advanceDispatcherPhase(initial(), authority, 'token_0', reply(initial(), 'completed', {
      'dispatcher-progress': [progress(initial(), [])],
    }), delivery(1), targets(1)[0])).toThrow();
  });

  it('enforces supplied admitted singleton without widening or omitting it', () => {
    const admitted = targets(1)[0];
    const accept = (frozen: DispatcherTarget[]) => advanceDispatcherPhase(initial(), authority, 'token_0', reply(initial(), 'completed', {
      'dispatcher-progress': [progress(initial(), frozen)],
    }), delivery(1), admitted);
    expect(accept([admitted]).targets).toEqual([admitted]);
    for (const frozen of [[], targets(2), [{ ...admitted, headSha: 'f'.repeat(40) }]]) expect(() => accept(frozen)).toThrow();
  });

  it.each(['missing-terminal', 'not-current', 'not-up-to-date', 'aborted', 'missing-progress', 'duplicate-progress', 'assessment'])('denies discovery %s', mode => {
    const state = initial(), checkpoint = progress(state, targets(1));
    const candidate = reply(state, 'completed', { 'dispatcher-progress': [checkpoint] });
    if (mode === 'missing-terminal') delete candidate.outcome;
    if (mode === 'not-current') candidate.submissionId = 'foreign';
    if (mode === 'not-up-to-date') candidate.upToDate = false;
    if (mode === 'aborted') candidate.outcome = 'aborted';
    if (mode === 'missing-progress') candidate.data = {};
    if (mode === 'duplicate-progress') candidate.data['dispatcher-progress'].push(checkpoint);
    if (mode === 'assessment') candidate.data.assessment = [{ repository: 'owner/repo', results: [] }];
    expect(() => step(state, candidate, 1)).toThrow();
  });

  it('denies missing completed target progress, aborted target, nonfinal assessments and advancing final', () => {
    const state = discover(targets(1));
    expect(() => step(state, reply(state), 2)).toThrow();
    expect(() => step(state, reply(state, 'aborted'), 2)).toThrow();
    expect(() => step(state, reply(state, 'failed', { assessment: [{}] }), 2)).toThrow();
    const final = discover([]);
    expect(() => step(final, reply(final), 2)).toThrow();
  });

  it('denies foreign/late phase bindings, changed scope/generation, wrong next, duplicate coordinates and unsafe coordinates', () => {
    const state = discover(targets(2));
    const good = progress(state, targets(2), [ordinary(targets(2)[0])]);
    for (const changed of [
      { ...good, scope: 'foreign' }, { ...good, generation: 8 }, { ...good, submissionId: 'sdk-0' },
      { ...good, phase: { kind: 'discovery' } }, { ...good, next: { kind: 'final' } },
      { ...good, phase: { kind: 'target', index: 1, target: targets(2)[1] } },
      { ...good, results: [{ ...ordinary(targets(2)[0]), pullRequest: Number.MAX_SAFE_INTEGER + 1 }] },
      { ...good, results: [{ ...ordinary(targets(2)[0]), headSha: 'A'.repeat(40) }] },
      { ...good, extra: true },
    ]) expect(() => step(state, reply(state, 'completed', { 'dispatcher-progress': [changed] }), 2)).toThrow();
    for (const frozen of [[targets(1)[0], targets(1)[0]], [{ pullRequest: 0, headSha: 'a'.repeat(40) }],
      [{ pullRequest: Number.MAX_SAFE_INTEGER + 1, headSha: 'a'.repeat(40) }], [{ ...targets(1)[0], unknown: true }]]) {
      expect(() => step(initial(), reply(initial(), 'completed', { 'dispatcher-progress': [progress(initial(), frozen)] }), 1)).toThrow();
    }
    expect(() => advanceDispatcherPhase(state, authority, 'token_0', reply(state, 'failed'), delivery(2))).toThrow();
  });

  it('denies replaced/reordered/duplicate prefix coordinates and changed witnessed results; member-order alone is equivalent', () => {
    const frozen = targets(2), first = discover(frozen), row = ordinary(frozen[0]);
    const second = bind(step(first, reply(first, 'completed', { 'dispatcher-progress': [progress(first, frozen, [row])] }), 2), 2);
    const last = ordinary(frozen[1]);
    for (const rows of [[last, row], [row, row], [{ ...row, comment: 'changed' }, last], [{ ...row, headSha: 'f'.repeat(40) }, last], [last]]) {
      expect(() => step(second, reply(second, 'completed', { 'dispatcher-progress': [progress(second, frozen, rows)] }), 3)).toThrow();
    }
    const reversed = Object.fromEntries(Object.entries(row).reverse()) as DispatcherJourneyResult;
    const final = bind(step(second, reply(second, 'completed', { 'dispatcher-progress': [progress(second, frozen, [reversed, last])] }), 3), 3);
    expect(finish(final, [row, last]).results).toEqual([row, last]);
    const corrupted = { ...second, results: [] };
    expect(() => step(corrupted, reply(corrupted, 'failed'), 3)).toThrow();
  });

  it('accepts deferred judgment absent or paired; denies partial pairs, unknown reasons, and inconsistent ordinary outcomes', () => {
    const frozen = targets(1), state = discover(frozen);
    const base = deferred(frozen[0]);
    for (const row of [base, { ...base, decision: 'MERGE' as const, comment: 'actual judgment' }]) {
      const final = bind(step(state, reply(state, 'completed', { 'dispatcher-progress': [progress(state, frozen, [row])] }), 2), 2);
      expect(finish(final, [row]).results).toEqual([row]);
    }
    for (const row of [
      { ...base, decision: 'MERGE' }, { ...base, comment: 'unpaired' }, { ...base, reason: 'invented' },
      { ...base, decision: null, comment: null }, { ...base, extra: true },
      { ...ordinary(frozen[0]), outcome: 'MERGED' }, { ...ordinary(frozen[0]), decision: 'MERGE' },
      { ...ordinary(frozen[0]), comment: '' }, { ...ordinary(frozen[0]), comment: 'x'.repeat(2001) },
      { ...ordinary(frozen[0]), reason: 'response-failed' },
    ]) expect(() => step(state, reply(state, 'completed', { 'dispatcher-progress': [progress(state, frozen, [row as DispatcherJourneyResult])] }), 2)).toThrow();
  });

  it('denies conflicting/invalid actual receipts, reused SIDs, stale tokens, and changed authority digest', () => {
    const state = initial();
    for (const changed of [
      { ...receipt(0), submissionId: 'conflicting' }, { ...receipt(0), uid: 'conflicting' },
      { ...receipt(0), submissionId: '' }, { ...receipt(0), submissionId: 'x'.repeat(129) },
      { ...receipt(0), uid: '' }, { ...receipt(0), uid: 'x'.repeat(513) },
      { ...receipt(0), offset: '' }, { ...receipt(0), offset: 'x'.repeat(2049) },
      { ...receipt(0), offset: '-1' },
    ]) expect(() => bindDispatcherPhaseReceipt(state, authority, 'token_0', changed)).toThrow();
    expect(() => bindDispatcherPhaseReceipt(state, authority, 'stale', receipt(0))).toThrow();
    const pending = step(state, reply(state, 'completed', { 'dispatcher-progress': [progress(state, targets(1))] }), 1);
    expect(() => bindDispatcherPhaseReceipt(pending, authority, 'token_1', receipt(0))).toThrow();
    expect(() => bindDispatcherPhaseReceipt(pending, authority, 'token_1', { ...receipt(1), uid: 'new-instance' })).toThrow();
    expect(() => step(state, reply(state, 'completed', { 'dispatcher-progress': [progress(state, [])] }), 0)).toThrow();
    const changed = { ...authority, authorityDigest: 'c'.repeat(64) };
    expect(() => dispatcherPhaseWire(state, changed)).toThrow();
    expect(() => dispatcherPhaseContext(state, changed, 'token_0')).toThrow();
    expect(() => bindDispatcherPhaseReceipt(state, changed, 'token_0', receipt(0))).toThrow();
    expect(() => step(state, reply(state), 1, changed)).toThrow();
    expect(() => dispatcherPhaseWire(state, { ...authority, scope: 'foreign' })).toThrow();
  });

  it.each(['failed', 'aborted', 'pending', 'not-up-to-date', 'foreign', 'stale-token', 'progress', 'missing', 'duplicate', 'repository', 'order', 'extra', 'changed', 'digest'])('denies final %s', mode => {
    const frozen = targets(2), first = discover(frozen), rows = frozen.map(target => ordinary(target));
    const second = bind(step(first, reply(first, 'completed', { 'dispatcher-progress': [progress(first, frozen, rows.slice(0, 1))] }), 2), 2);
    const final = bind(step(second, reply(second, 'completed', { 'dispatcher-progress': [progress(second, frozen, rows)] }), 3), 3);
    const response = reply(final, 'completed', { assessment: [{ repository: 'owner/repo', results: rows }] });
    if (mode === 'failed' || mode === 'aborted') response.outcome = mode;
    if (mode === 'pending') delete response.outcome;
    if (mode === 'not-up-to-date') response.upToDate = false;
    if (mode === 'foreign') response.submissionId = 'sdk-0';
    if (mode === 'progress') response.data['dispatcher-progress'] = [{}];
    if (mode === 'missing') response.data.assessment = [];
    if (mode === 'duplicate') response.data.assessment.push(response.data.assessment[0]);
    if (mode === 'repository') response.data.assessment = [{ repository: 'owner/foreign', results: rows }];
    if (mode === 'order') response.data.assessment = [{ repository: 'owner/repo', results: [...rows].reverse() }];
    if (mode === 'extra') response.data.assessment = [{ repository: 'owner/repo', results: [...rows, deferred(targets(3)[2])] }];
    if (mode === 'changed') response.data.assessment = [{ repository: 'owner/repo', results: [{ ...rows[0], comment: 'changed' }, rows[1]] }];
    expect(() => collectDispatcherFinal(final,
      mode === 'digest' ? { ...authority, authorityDigest: 'c'.repeat(64) } : authority,
      mode === 'stale-token' ? 'token_2' : 'token_3', response)).toThrow();
    expect(() => collectDispatcherFinal(first, authority, first.current.deliveryToken, reply(first, 'completed', { assessment: response.data.assessment }))).toThrow();
  });

  it('enforces exact UTF-8 bytes for progress and final under both the 48 KiB cap and smaller admitted capacity', () => {
    const frozen = targets(30), rows = frozen.map(target => ordinary(target, 'é'.repeat(1200)));
    // Tune actual comment strings, not sizing placeholders, to hit the intentional byte contract.
    while (bytes({ repository: 'owner/repo', results: rows }) > 48 * 1024) {
      const row = rows.find(item => 'comment' in item && item.comment.length > 1)!;
      if ('comment' in row) row.comment = row.comment.slice(0, -1);
    }
    const assessment = { repository: 'owner/repo', results: rows };
    const deficit = 48 * 1024 - bytes(assessment);
    if ('comment' in rows[29]) rows[29].comment += 'x'.repeat(deficit);
    expect(bytes(assessment)).toBe(48 * 1024);
    let final = discover(frozen);
    for (let i = 0; i < 30; i++) final = bind(step(final, reply(final, 'failed'), i + 2), i + 2);
    expect(finish(final, rows)).toEqual(assessment);
    if ('comment' in rows[29]) rows[29].comment += 'x';
    expect(() => finish(final, rows)).toThrow();
    if ('comment' in rows[29]) rows[29].comment = rows[29].comment.slice(0, -1);
    expect(() => finish(final, rows, { ...authority, assessmentBytes: 48 * 1024 - 1 })).toThrow();
    const one = targets(1), state = discover(one), checkpoint = progress(state, one, [ordinary(one[0], 'é')]);
    const response = reply(state, 'completed', { 'dispatcher-progress': [checkpoint] });
    expect(step(state, response, 2, { ...authority, assessmentBytes: bytes(checkpoint) }).results).toEqual([ordinary(one[0], 'é')]);
    expect(() => step(state, response, 2, { ...authority, assessmentBytes: bytes(checkpoint) - 1 })).toThrow();
    const smallFinal = bind(step(state, response, 2), 2);
    const smallAssessment = { repository: 'owner/repo', results: [ordinary(one[0], 'é')] };
    expect(finish(smallFinal, smallAssessment.results, { ...authority, assessmentBytes: bytes(smallAssessment) })).toEqual(smallAssessment);
    expect(() => finish(smallFinal, smallAssessment.results, { ...authority, assessmentBytes: bytes(smallAssessment) - 1 })).toThrow();
    const discoveryCheckpoint = progress(initial(), one);
    const discoveryReply = reply(initial(), 'completed', { 'dispatcher-progress': [discoveryCheckpoint] });
    expect(step(initial(), discoveryReply, 1, { ...authority, assessmentBytes: bytes(discoveryCheckpoint) }).targets).toEqual(one);
    expect(() => step(initial(), discoveryReply, 1, { ...authority, assessmentBytes: bytes(discoveryCheckpoint) - 1 })).toThrow();
    // 48 KiB progress can be reached with many actual rows; its envelope also counts.
    let last = discover(frozen);
    for (let i = 0; i < 29; i++) last = bind(step(last, reply(last, 'failed'), i + 2), i + 2);
    while (bytes(progress(last, frozen, rows)) > 48 * 1024) {
      const row = rows.find(item => 'comment' in item && item.comment.length > 1)!;
      if ('comment' in row) row.comment = row.comment.slice(0, -1);
    }
    const remainder = 48 * 1024 - bytes(progress(last, frozen, rows));
    if ('comment' in rows[29]) rows[29].comment += 'x'.repeat(remainder);
    const exact = progress(last, frozen, rows);
    expect(bytes(exact)).toBe(48 * 1024);
    expect(step(last, reply(last, 'completed', { 'dispatcher-progress': [exact] }), 31).results).toEqual(rows);
    if ('comment' in rows[29]) rows[29].comment += 'x';
    expect(() => step(last, reply(last, 'completed', { 'dispatcher-progress': [progress(last, frozen, rows)] }), 31)).toThrow();
  });

  it('accepts the complete closed disposition vocabulary as actual final data, not judgments minted by host', () => {
    const frozen = targets(1), state = discover(frozen);
    const final = bind(step(state, reply(state, 'failed'), 2), 2);
    for (const reason of ['research-failed', 'decision-failed', 'preflight-failed', 'comment-failed',
      'merge-failed', 'response-failed', 'comment-uncertain', 'merge-uncertain', 'prior-effect-uncertain'] as const) {
      const row: DispatcherJourneyResult = { ...frozen[0], outcome: 'DEFERRED', reason };
      expect(finish(final, [row]).results).toEqual([row]);
    }
    for (const row of [
      { ...ordinary(frozen[0]), outcome: 'MERGED' as const, decision: 'MERGE' as const },
      ordinary(frozen[0]),
      { ...ordinary(frozen[0]), outcome: 'EXECUTION_FAILED' as const, decision: 'MERGE' as const },
      { ...ordinary(frozen[0]), outcome: 'EXECUTION_FAILED' as const },
    ]) expect(finish(final, [row]).results).toEqual([row]);
    expect(() => finish(final, [{ ...deferred(frozen[0]), decision: 'MERGE' } as DispatcherJourneyResult])).toThrow();
    expect(() => finish(final, [{ ...ordinary(frozen[0]), outcome: 'MERGED' } as DispatcherJourneyResult])).toThrow();
    expect(final.results).toEqual([]);
  });

  it('rejects invalid delivery/authority envelopes and noncontiguous durable lineage without repairing it', () => {
    for (const credentials of [
      { deliveryToken: '', idempotencyKey: 'valid' }, { deliveryToken: 'bad token', idempotencyKey: 'valid' },
      { deliveryToken: 'x'.repeat(129), idempotencyKey: 'valid' },
      { deliveryToken: 'valid', idempotencyKey: '' }, { deliveryToken: 'valid', idempotencyKey: 'x'.repeat(257) },
    ]) expect(() => createDispatcherPhaseState('activity', authority.authorityDigest, credentials)).toThrow();
    const state = discover(targets(2));
    for (const mutated of [
      { ...state, previous: [] },
      { ...state, previous: [{ ...state.previous[0], outcome: 'failed' as const }] },
      { ...state, previous: [...state.previous, state.previous[0]] },
      { ...state, current: { ...state.current, phase: next(targets(2), 1) } },
    ]) expect(() => dispatcherPhaseContext(mutated, authority, state.current.deliveryToken)).toThrow();
    for (const changed of [
      { ...authority, generation: 0 }, { ...authority, generation: Number.MAX_SAFE_INTEGER + 1 },
      { ...authority, releaseDigest: 'bad' }, { ...authority, deadline: 'not-a-date' },
      { ...authority, assessmentBytes: 0 }, { ...authority, repositoryJson: '{"repository":"owner/repo","extra":true}' },
    ]) expect(() => dispatcherPhaseWire(state, changed)).toThrow();
    expect(() => advanceDispatcherPhase(state, authority, state.current.deliveryToken, reply(state, 'failed'),
      { ...delivery(2), idempotencyKey: state.current.idempotencyKey })).toThrow();
    expect(() => advanceDispatcherPhase(state, authority, state.current.deliveryToken, reply(state, 'failed'),
      { ...delivery(2), deliveryToken: state.current.deliveryToken })).toThrow();
  });

  it('never mutates caller-owned state, authority, receipts, checkpoints, deliveries or returned context aliases', () => {
    const state = initial(), frozen = targets(1), checkpoint = progress(state, frozen);
    const response = reply(state, 'completed', { 'dispatcher-progress': [checkpoint] });
    const nextDelivery = delivery(1);
    const inputs = [state, authority, response, nextDelivery], before = JSON.stringify(inputs);
    const advanced = advanceDispatcherPhase(state, authority, state.current.deliveryToken, response, nextDelivery);
    expect(JSON.stringify(inputs)).toBe(before);
    if (!('targets' in checkpoint)) throw new Error('Discovery checkpoint expected');
    checkpoint.targets[0].headSha = 'f'.repeat(40);
    expect(advanced.targets).toEqual(targets(1));
    const actual = receipt(1), bound = bindDispatcherPhaseReceipt(advanced, authority, 'token_1', actual);
    actual.uid = 'mutated-input';
    expect(bound.current.receipt!.uid).toBe('actual-instance-uid');
    const context = dispatcherPhaseContext(bound, authority, 'token_1');
    context.previous![0].outcome = 'failed';
    expect(bound.previous[0].outcome).toBe('completed');
    expect(() => step(state, { ...response, submissionId: 'foreign' }, 1)).toThrow();
    expect(state).toEqual(initial());
  });
});
