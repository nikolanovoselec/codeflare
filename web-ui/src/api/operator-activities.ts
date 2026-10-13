/** Authenticated, owner-scoped browser projections for operator activity UI. */
import { z } from 'zod';
import { baseFetch } from './fetch-helper';

const status = z.enum(['queued', 'running', 'waiting', 'completed', 'failed', 'cancel-requested', 'unknown']);
const cleanup = z.enum(['pending', 'stopping', 'stopped', 'unknown']);
const collection = z.enum(['unavailable', 'ready', 'consumed', 'unknown']);
export const operatorActivitySummarySchema = z.strictObject({
  activityId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  operatorId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  operatorName: z.string().max(128).optional(),
  context: z.string().max(256).nullable().optional(),
  progress: z.string().max(128).nullable().optional(),
  executionStatus: status,
  cleanupStatus: cleanup,
  collectionStatus: collection,
  attention: z.boolean(),
  sessionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).nullable(),
  source: z.string().max(256).nullable(),
  updatedAt: z.union([z.string().datetime(), z.number().int().nonnegative()]),
});
export type OperatorActivitySummary = z.infer<typeof operatorActivitySummarySchema>;
const count = z.number().int().nonnegative();
const listSchema = z.strictObject({ items: z.array(operatorActivitySummarySchema).max(5),
  nextCursor: operatorActivitySummarySchema.shape.activityId.nullable(), workingCount: count,
  unreadCount: count, latestSequence: count });
export function listOperatorActivities(after: string | null = null): Promise<z.infer<typeof listSchema>> {
  return baseFetch(`/api/operator-activities?limit=5${after ? `&after=${encodeURIComponent(after)}` : ''}`, {},
    { credentials: 'same-origin', schema: listSchema });
}
export function acknowledgeOperatorActivities(through: number): Promise<{ unreadCount: number }> {
  return baseFetch('/api/operator-activities/read', { method: 'POST', body: JSON.stringify({ through }) },
    { credentials: 'same-origin', schema: z.strictObject({ unreadCount: count }) });
}
// Closed result-only wire mirror. Public receipt identity is not execution authority.
const receiptInteger = z.number().int().nonnegative().safe();
const receiptDigest = z.string().regex(/^[a-f0-9]{64}$/);
const receiptTarget = z.strictObject({ repository: z.string().max(201).regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  pullRequest: receiptInteger.positive(), headSha: z.string().regex(/^[a-f0-9]{40}$/) });
const receiptResponse = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('comment'), status: z.literal(201), commentId: receiptInteger.positive(),
    responseBodyDigest: receiptDigest }),
  z.strictObject({ kind: z.literal('merge'), status: z.literal(200), merged: z.literal(true),
    mergeSha: z.string().regex(/^[a-f0-9]{40}$/) }),
]);
const receiptCoordinates = { ordinal: receiptInteger, operationDigest: receiptDigest,
  method: z.enum(['POST', 'PUT']), effect: z.enum(['comment', 'merge']) };
const receiptItem = z.discriminatedUnion('binding', [
  z.strictObject({ ...receiptCoordinates, binding: z.literal('unresolved'),
    journalPhase: z.enum(['reserved', 'completed', 'unknown']), requestDigest: receiptDigest.optional(),
    responseDigest: receiptDigest.optional(), phaseIndex: receiptInteger.optional(),
    submissionDigest: receiptDigest.optional(), deliveryDigest: receiptDigest.optional(), target: receiptTarget.optional() }),
  z.strictObject({ ...receiptCoordinates, binding: z.literal('verified'), journalPhase: z.literal('completed'),
    requestDigest: receiptDigest, responseDigest: receiptDigest, phaseIndex: receiptInteger,
    submissionDigest: receiptDigest, deliveryDigest: receiptDigest, target: receiptTarget, observedResponse: receiptResponse }),
]).refine(row => row.effect === (row.method === 'POST' ? 'comment' : 'merge')
  && (row.binding !== 'verified' || row.observedResponse.kind === row.effect), 'Contradictory receipt kind');
const receiptHeader = { version: z.literal(1), activityId: operatorActivitySummarySchema.shape.activityId };
const unavailableReceipts = z.strictObject({ ...receiptHeader, scan: z.literal('unavailable'), pageStatus: z.literal('unavailable'),
  journalCount: z.null(), inspectedEntries: z.literal(0), unresolvedJournalEntries: z.null(),
  unclassifiedEntries: z.literal(0), nextAfterOrdinal: z.null(), items: z.array(receiptItem).length(0) });
const selectedReceipts = z.strictObject({ ...receiptHeader, generation: receiptInteger.positive(),
  inputDigest: receiptDigest, artifactDigest: receiptDigest, admissionDigest: receiptDigest,
  scan: z.enum(['complete', 'partial']), pageStatus: z.enum(['complete', 'more', 'partial']),
  journalCount: receiptInteger, inspectedEntries: receiptInteger.max(1024), unresolvedJournalEntries: receiptInteger,
  unclassifiedEntries: receiptInteger, nextAfterOrdinal: receiptInteger.nullable(), items: z.array(receiptItem).max(8) })
  .refine(value => value.unresolvedJournalEntries <= value.journalCount
    && value.unclassifiedEntries <= value.inspectedEntries
    && (value.scan !== 'complete' || value.inspectedEntries === value.journalCount && value.unclassifiedEntries === 0)
    && (value.pageStatus !== 'complete' || value.scan === 'complete')
    && (value.pageStatus === 'more' ? value.items.length === 8 && value.nextAfterOrdinal === value.items.at(-1)!.ordinal
      : value.nextAfterOrdinal === null)
    && value.items.every((row, index) => index === 0 || row.ordinal > value.items[index - 1].ordinal),
  'Contradictory receipt completeness');
const effectReceiptsSchema = z.union([unavailableReceipts, selectedReceipts]);
const detailSchema = operatorActivitySummarySchema.extend({ checkpoint: z.unknown(), result: z.unknown(),
  sdkCleanupReleased: z.boolean().optional(), effectReceipts: effectReceiptsSchema.optional() })
  .refine(value => !value.effectReceipts || value.effectReceipts.activityId === value.activityId, 'Foreign receipt activity');
export type OperatorActivityDetail = z.infer<typeof detailSchema>;
export function getOperatorActivity(activityId: string): Promise<OperatorActivityDetail> {
  return baseFetch(`/api/operator-activities/${encodeURIComponent(activityId)}/result`, {},
    { credentials: 'same-origin', schema: detailSchema });
}
export function cancelOperatorActivity(activityId: string): Promise<OperatorActivitySummary> {
  return baseFetch(`/api/operator-activities/${encodeURIComponent(activityId)}/cancel`, { method: 'POST', body: '{}' },
    { credentials: 'same-origin', schema: operatorActivitySummarySchema });
}
