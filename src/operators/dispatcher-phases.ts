import { z } from 'zod';

// Wire mirror of dispatcher journey-contract.ts at fcb572b; no package policy/effects.
const identity = z.string().min(1).max(128);
const token = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const targetSchema = z.object({ pullRequest: integer.min(1), headSha: z.string().regex(/^[a-f0-9]{40}$/) }).strict();
const decision = z.enum(['MERGE', 'DO_NOT_MERGE']);
const comment = z.string().min(1).max(2000);
const reason = z.enum(['research-failed', 'decision-failed', 'preflight-failed', 'comment-failed',
  'merge-failed', 'response-failed', 'comment-uncertain', 'merge-uncertain', 'prior-effect-uncertain']);
const resultSchema = z.union([
  z.object({ ...targetSchema.shape, decision, comment, outcome: z.enum(['MERGED', 'NOT_MERGED', 'EXECUTION_FAILED']) }).strict(),
  z.object({ ...targetSchema.shape, outcome: z.literal('DEFERRED'), reason }).strict(),
  z.object({ ...targetSchema.shape, decision, comment, outcome: z.literal('DEFERRED'), reason }).strict(),
]).refine(row => (row.outcome !== 'MERGED' || 'decision' in row && row.decision === 'MERGE')
  && (row.outcome !== 'NOT_MERGED' || 'decision' in row && row.decision === 'DO_NOT_MERGE'), 'Disposition mismatch');
const discoverySchema = z.object({ kind: z.literal('discovery') }).strict();
const targetPhaseSchema = z.object({ kind: z.literal('target'), index: integer, target: targetSchema }).strict();
const finalSchema = z.object({ kind: z.literal('final') }).strict();
const phaseSchema = z.discriminatedUnion('kind', [discoverySchema, targetPhaseSchema, finalSchema]);
const nextSchema = z.discriminatedUnion('kind', [targetPhaseSchema, finalSchema]);
const deliverySchema = z.object({ deliveryToken: token, idempotencyKey: z.string().min(1).max(256) }).strict();
const receiptSchema = z.object({ submissionId: identity, uid: z.string().min(1).max(512), offset: z.string().min(1).max(2048) }).strict();
const sdkReceiptSchema = receiptSchema.extend({ deduplicated: z.literal(true).optional() });
const terminalSchema = z.object({ submissionId: identity, phase: phaseSchema, outcome: z.enum(['completed', 'failed']) }).strict();
const stateSchema = z.object({
  version: z.literal(1), scope: identity, authorityDigest: digest, uid: receiptSchema.shape.uid.optional(),
  current: z.object({ phase: phaseSchema, ...deliverySchema.shape, receipt: receiptSchema.optional() }).strict(),
  previous: z.array(terminalSchema), targets: z.array(targetSchema).optional(), results: z.array(resultSchema),
}).strict();
const repositorySchema = z.object({ repository: z.string().max(201).regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/) }).strict();
const journeySchema = z.object({ repository: repositorySchema.shape.repository, results: z.array(resultSchema) }).strict();
const authoritySchema = z.object({ scope: identity, generation: integer.min(1),
  deadline: z.string().refine(value => Number.isFinite(Date.parse(value))),
  releaseDigest: digest, authorityDigest: digest, repositoryJson: z.string(), assessmentBytes: integer.min(1),
}).strict();
const binding = { version: z.literal(1), scope: identity, generation: integer.min(1), submissionId: identity };
const progressSchema = z.union([
  z.object({ ...binding, phase: discoverySchema, next: nextSchema, targets: z.array(targetSchema) }).strict(),
  z.object({ ...binding, phase: targetPhaseSchema, next: nextSchema, results: z.array(resultSchema) }).strict(),
]);
const replySchema = z.object({ submissionId: identity, upToDate: z.boolean(),
  outcome: z.enum(['completed', 'failed', 'aborted']).optional(), data: z.record(z.string(), z.array(z.unknown())),
}).strict();

export type DispatcherTarget = z.infer<typeof targetSchema>;
export type DispatcherJourneyResult = z.infer<typeof resultSchema>;
export type DispatcherJourney = z.infer<typeof journeySchema>;
export type DispatcherPhase = z.infer<typeof phaseSchema>;
export type DispatcherPhaseDelivery = z.infer<typeof deliverySchema>;
type DispatcherPhaseReceipt = z.infer<typeof receiptSchema>;
type DispatcherPhaseTerminal = z.infer<typeof terminalSchema>;
export type DispatcherPhaseState = z.infer<typeof stateSchema>;
/** Original Activity lease/context authority, NOT renewed or persisted by this helper.
 * Activity owns live authorization, generation, release/input binding, deadline and budgets,
 * both before and after awaits. Wire validation cannot establish those live gates.
 */
export type DispatcherPhaseAuthority = z.infer<typeof authoritySchema>;
/** Already exact-submission projected SDK named data and settlement. Not a timeout/error
 * translation: Activity must reconstruct/retain duplicate counts and reject late data itself.
 */
export type DispatcherPhaseReply = z.infer<typeof replySchema>;
export interface DispatcherPhaseContext {
  version: 1;
  scope: string;
  generation: number;
  deadline: string;
  releaseDigest: string;
  authorityDigest: string;
  submissionId: string;
  phase: DispatcherPhase;
  deliveryToken: string;
  previous?: DispatcherPhaseTerminal[];
}
export interface DispatcherPhaseWire {
  kind: 'signal';
  type: 'dispatcher-phase';
  body: string;
  attributes: { deliveryToken: string };
  uid: string | null;
  idempotencyKey: string;
}
export const DISPATCHER_JOURNEY_RESULT_BYTES = 48 * 1024;

// Parsed strict JSON values have no undefined fields; object member order has no authority.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function equal(left: unknown, right: unknown): boolean { return canonical(left) === canonical(right); }
/** JSON member order cannot change an already witnessed functional checkpoint. */
export const sameDispatcherPhaseValue = equal;
function requireWire(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function unique(targets: DispatcherTarget[]): void {
  requireWire(new Set(targets.map(row => row.pullRequest)).size === targets.length, 'Duplicate frozen coordinates');
}
function nextPhase(targets: DispatcherTarget[], phase: DispatcherPhase): DispatcherPhase {
  requireWire(phase.kind !== 'final', 'Final phase cannot advance');
  const index = phase.kind === 'target' ? phase.index + 1 : 0;
  return index < targets.length ? { kind: 'target', index, target: { ...targets[index] } } : { kind: 'final' };
}
function coordinates(rows: DispatcherJourneyResult[], targets: DispatcherTarget[]): void {
  requireWire(rows.length <= targets.length && rows.every((row, i) =>
    row.pullRequest === targets[i].pullRequest && row.headSha === targets[i].headSha), 'Frozen disposition order changed');
}
function witnessed(rows: DispatcherJourneyResult[], prior: DispatcherJourneyResult[]): void {
  requireWire(rows.length >= prior.length && prior.every((row, i) => equal(row, rows[i])), 'Witnessed disposition changed');
}
function bounded(value: unknown, authority: DispatcherPhaseAuthority): void {
  requireWire(new TextEncoder().encode(JSON.stringify(value)).byteLength
    <= Math.min(DISPATCHER_JOURNEY_RESULT_BYTES, authority.assessmentBytes), 'Phase data oversized');
}

/** Validate durable reconstruction, including contiguous original SID/phase lineage and
 * actual-prefix gaps. Only actual failed predecessors can lack witnessed progress.
 */
function readState(value: DispatcherPhaseState): DispatcherPhaseState {
  const state = stateSchema.parse(value);
  const frozen = state.targets;
  if (frozen !== undefined) unique(frozen);
  const ids = new Set<string>();
  let expected: DispatcherPhase = { kind: 'discovery' };
  for (const prior of state.previous) {
    requireWire(!ids.has(prior.submissionId) && equal(prior.phase, expected), 'Original terminal lineage changed');
    ids.add(prior.submissionId);
    requireWire(frozen !== undefined && prior.phase.kind !== 'final', 'Frozen original lineage required');
    if (prior.phase.kind === 'discovery') requireWire(prior.outcome === 'completed', 'Discovery must complete');
    if (prior.phase.kind === 'target' && prior.outcome === 'completed') {
      requireWire(state.results.length > prior.phase.index, 'Completed target progress missing');
    }
    expected = nextPhase(frozen, prior.phase);
  }
  requireWire(equal(state.current.phase, expected), 'Current phase out of order');
  if (state.current.phase.kind === 'discovery') {
    requireWire(frozen === undefined && state.results.length === 0, 'Discovery scope not yet frozen');
    requireWire((state.uid !== undefined) === (state.current.receipt !== undefined), 'Actual incarnation binding required');
  } else {
    requireWire(frozen !== undefined && state.uid !== undefined, 'Original incarnation and frozen scope required');
    coordinates(state.results, frozen);
    const prefixEnd = state.current.phase.kind === 'target' ? state.current.phase.index : frozen.length;
    requireWire(state.results.length <= prefixEnd, 'Future disposition not witnessed');
  }
  if (state.current.receipt) {
    requireWire(state.current.receipt.uid === state.uid && !ids.has(state.current.receipt.submissionId), 'Actual receipt identity conflict');
  }
  return state;
}
function check(state: DispatcherPhaseState, original: DispatcherPhaseAuthority, capturedToken?: string): {
  state: DispatcherPhaseState; authority: DispatcherPhaseAuthority; repository: string;
} {
  const parsed = readState(state);
  const authority = authoritySchema.parse(original);
  requireWire(parsed.scope === authority.scope && parsed.authorityDigest === authority.authorityDigest, 'Original authority mismatch');
  if (capturedToken !== undefined) requireWire(token.parse(capturedToken) === parsed.current.deliveryToken, 'Stale phase delivery');
  const { repository } = repositorySchema.parse(JSON.parse(authority.repositoryJson));
  return { state: parsed, authority, repository };
}
function actualReceipt(state: DispatcherPhaseState): DispatcherPhaseReceipt {
  requireWire(state.current.receipt !== undefined, 'Actual SDK admission receipt required');
  return state.current.receipt;
}
function settlement(state: DispatcherPhaseState, value: DispatcherPhaseReply): DispatcherPhaseReply {
  const reply = replySchema.parse(value);
  requireWire(reply.submissionId === actualReceipt(state).submissionId && reply.upToDate
    && (reply.outcome === 'completed' || reply.outcome === 'failed'), 'Exact current terminal settlement required');
  return reply;
}

/** Return durable start identity; caller persists this BEFORE any SDK POST. Tokens and
 * keys are caller-minted, never SID/UID. No I/O, clock, randomness or authority renewal.
 */
export function createDispatcherPhaseState(scope: string, authorityDigest: string,
  delivery: DispatcherPhaseDelivery): DispatcherPhaseState {
  return readState({ version: 1, scope, authorityDigest,
    current: { phase: { kind: 'discovery' }, ...deliverySchema.parse(delivery) }, previous: [], results: [] });
}

/** First send/replay remains create-only even after binding. SDK keyed replay adopts
 * the original submission. Every successor conditions on the original actual UID.
 * Body retains the original repository JSON bytes supplied by Activity.
 */
export function dispatcherPhaseWire(state: DispatcherPhaseState, authority: DispatcherPhaseAuthority): DispatcherPhaseWire {
  const checked = check(state, authority);
  return { kind: 'signal', type: 'dispatcher-phase', body: checked.authority.repositoryJson,
    attributes: { deliveryToken: checked.state.current.deliveryToken },
    uid: checked.state.current.phase.kind === 'discovery' ? null : checked.state.uid!,
    idempotencyKey: checked.state.current.idempotencyKey };
}

/** Bind only an actual public SDK receipt. Dedup origin -1 never replaces an already
 * bound admission cursor. This helper does not read/write Activity's projection cursor;
 * Activity must preserve that separately on reattachment, including eviction recovery.
 */
export function bindDispatcherPhaseReceipt(state: DispatcherPhaseState, authority: DispatcherPhaseAuthority,
  capturedToken: string, value: unknown): DispatcherPhaseState {
  const checked = check(state, authority, capturedToken).state;
  const incoming = sdkReceiptSchema.parse(value);
  requireWire(incoming.offset !== '-1' || incoming.deduplicated === true, 'SDK deduplicated origin required');
  requireWire(!checked.previous.some(row => row.submissionId === incoming.submissionId), 'SDK submission reused across phases');
  requireWire(checked.uid === undefined || checked.uid === incoming.uid, 'Original SDK incarnation changed');
  const prior = checked.current.receipt;
  if (prior) {
    requireWire(prior.submissionId === incoming.submissionId && prior.uid === incoming.uid
      && (prior.offset === incoming.offset || incoming.offset === '-1' && incoming.deduplicated === true), 'SDK receipt conflict');
    return checked;
  }
  return readState({ ...checked, uid: incoming.uid, current: { ...checked.current,
    receipt: { submissionId: incoming.submissionId, uid: incoming.uid, offset: incoming.offset } } });
}

/** Exact package context; no pre-admission or future SID. Package's initial-transition
 * check requires previous ABSENT for discovery; thereafter include the full lineage.
 */
export function dispatcherPhaseContext(state: DispatcherPhaseState, original: DispatcherPhaseAuthority,
  capturedToken: string): DispatcherPhaseContext {
  const { state: checked, authority } = check(state, original, capturedToken);
  return { version: 1, scope: checked.scope, generation: authority.generation, deadline: authority.deadline,
    releaseDigest: authority.releaseDigest, authorityDigest: checked.authorityDigest,
    submissionId: actualReceipt(checked).submissionId, phase: checked.current.phase,
    deliveryToken: checked.current.deliveryToken,
    ...(checked.previous.length ? { previous: checked.previous } : {}) };
}

/** Validate exact settlement and actual functional progress, then return next durable
 * identity to persist BEFORE POST. Failed targets may have NO progress; never create a
 * missing result. The next authentic package response supplies its actual full prefix.
 * Activity decides whether a failed settlement is PR-local; shared/global fences deny
 * before this call. Aborted, timeout, missing and non-up-to-date observations cannot advance.
 */
export function advanceDispatcherPhase(state: DispatcherPhaseState, original: DispatcherPhaseAuthority,
  capturedToken: string, value: DispatcherPhaseReply, nextDelivery: DispatcherPhaseDelivery,
  admittedTarget?: DispatcherTarget): DispatcherPhaseState {
  const { state: checked, authority } = check(state, original, capturedToken);
  requireWire(checked.current.phase.kind !== 'final', 'Final phase cannot advance');
  const reply = settlement(checked, value);
  requireWire((reply.data.assessment?.length ?? 0) === 0, 'Nonfinal assessment denied');
  const parts = reply.data['dispatcher-progress'] ?? [];
  requireWire(parts.length <= 1, 'Functional progress duplicated');
  if (checked.current.phase.kind === 'discovery' || reply.outcome === 'completed') {
    requireWire(reply.outcome === 'completed' && parts.length === 1, 'Completed phase progress required');
  }
  let frozen = checked.targets;
  let results = checked.results;
  if (parts.length) {
    // Count original wire bytes before schema parsing/normalization.
    bounded(parts[0], authority);
    const progress = progressSchema.parse(parts[0]);
    requireWire(progress.scope === checked.scope && progress.generation === authority.generation
      && progress.submissionId === actualReceipt(checked).submissionId
      && equal(progress.phase, checked.current.phase), 'Functional progress binding mismatch');
    if ('targets' in progress) {
      frozen = progress.targets;
      unique(frozen);
    } else {
      requireWire(frozen !== undefined && checked.current.phase.kind === 'target'
        && progress.results.length === checked.current.phase.index + 1, 'Complete actual disposition prefix required');
      coordinates(progress.results, frozen);
      witnessed(progress.results, results);
      results = progress.results;
    }
    requireWire(frozen !== undefined && equal(progress.next, nextPhase(frozen, checked.current.phase)), 'Exact next phase required');
  }
  requireWire(frozen !== undefined, 'Completed discovery scope required');
  if (admittedTarget !== undefined) {
    const admitted = targetSchema.parse(admittedTarget);
    requireWire(frozen.length === 1 && equal(frozen[0], admitted), 'Exact admitted singleton required');
  }
  const delivery = deliverySchema.parse(nextDelivery);
  requireWire(delivery.deliveryToken !== checked.current.deliveryToken
    && delivery.idempotencyKey !== checked.current.idempotencyKey, 'Distinct next delivery identity required');
  return readState({ ...checked, targets: frozen, results,
    previous: [...checked.previous, { submissionId: actualReceipt(checked).submissionId,
      phase: checked.current.phase, outcome: reply.outcome as 'completed' | 'failed' }],
    current: { phase: nextPhase(frozen, checked.current.phase), ...delivery } });
}

/** Only exact completed final settlement with the sole actual assessment is collectible.
 * Validate all frozen coordinates and prior witnessed JSON values, including optional
 * judgment absence. Failed gaps may be filled only by THIS actual assessment.
 */
export function collectDispatcherFinal(state: DispatcherPhaseState, original: DispatcherPhaseAuthority,
  capturedToken: string, value: DispatcherPhaseReply): DispatcherJourney {
  const { state: checked, authority, repository } = check(state, original, capturedToken);
  requireWire(checked.current.phase.kind === 'final' && checked.targets !== undefined, 'Designated final phase required');
  const reply = settlement(checked, value);
  requireWire(reply.outcome === 'completed' && (reply.data['dispatcher-progress']?.length ?? 0) === 0
    && reply.data.assessment?.length === 1, 'Sole completed final assessment required');
  bounded(reply.data.assessment[0], authority);
  const journey = journeySchema.parse(reply.data.assessment[0]);
  requireWire(journey.repository === repository && journey.results.length === checked.targets.length, 'Complete frozen final scope required');
  coordinates(journey.results, checked.targets);
  witnessed(journey.results, checked.results);
  return journey;
}
