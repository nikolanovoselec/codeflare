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
const detailSchema = operatorActivitySummarySchema.extend({ checkpoint: z.unknown(), result: z.unknown(),
  sdkCleanupReleased: z.boolean().optional() });
export type OperatorActivityDetail = z.infer<typeof detailSchema>;
export function getOperatorActivity(activityId: string): Promise<OperatorActivityDetail> {
  return baseFetch(`/api/operator-activities/${encodeURIComponent(activityId)}/result`, {},
    { credentials: 'same-origin', schema: detailSchema });
}
export function cancelOperatorActivity(activityId: string): Promise<OperatorActivitySummary> {
  return baseFetch(`/api/operator-activities/${encodeURIComponent(activityId)}/cancel`, { method: 'POST', body: '{}' },
    { credentials: 'same-origin', schema: operatorActivitySummarySchema });
}
