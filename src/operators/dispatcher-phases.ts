import { z } from 'zod';

// Read-only decoder of the retained pre-application workflow format.
// New phase planning, transitions and final policy belong to the operator package.
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
const deliverySchema = z.object({ deliveryToken: token, idempotencyKey: z.string().min(1).max(256) }).strict();
const legacyReceiptSchema = z.object({ submissionId: identity, uid: z.string().min(1).max(512), offset: z.string().min(1).max(2048) }).strict();
const normalReceiptSchema = z.object({ submissionId: identity, uid: z.string().min(1).max(512),
  acceptedAt: z.string().max(128).refine(value => Number.isFinite(Date.parse(value))) }).strict();
const receiptSchema = z.union([legacyReceiptSchema, normalReceiptSchema]);
const terminalSchema = z.object({ submissionId: identity, phase: phaseSchema, outcome: z.enum(['completed', 'failed']) }).strict();
const stateSchema = z.object({
  version: z.literal(1), scope: identity, authorityDigest: digest, uid: legacyReceiptSchema.shape.uid.optional(),
  current: z.object({ phase: phaseSchema, ...deliverySchema.shape, receipt: receiptSchema.optional() }).strict(),
  previous: z.array(terminalSchema), targets: z.array(targetSchema).optional(), results: z.array(resultSchema),
}).strict();
const repositorySchema = z.object({ repository: z.string().max(201).regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/) }).strict();
const authoritySchema = z.object({ scope: identity, generation: integer.min(1),
  deadline: z.string().refine(value => Number.isFinite(Date.parse(value))),
  releaseDigest: digest, authorityDigest: digest, repositoryJson: z.string(), assessmentBytes: integer.min(1),
}).strict();
export type DispatcherTarget = z.infer<typeof targetSchema>;
export type DispatcherJourneyResult = z.infer<typeof resultSchema>;
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
/** Return durable start identity; caller persists this BEFORE any SDK POST. Tokens and
 * keys are caller-minted, never SID/UID. No I/O, clock, randomness or authority renewal.
 */
export function createDispatcherPhaseState(scope: string, authorityDigest: string,
  delivery: DispatcherPhaseDelivery): DispatcherPhaseState {
  return readState({ version: 1, scope, authorityDigest,
    current: { phase: { kind: 'discovery' }, ...deliverySchema.parse(delivery) }, previous: [], results: [] });
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
