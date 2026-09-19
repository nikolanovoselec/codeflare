/** Authenticated, owner-scoped browser projections for operator activity UI. */
import { z } from 'zod';
import { baseFetch } from './fetch-helper';

const status = z.enum(['queued', 'running', 'waiting', 'completed', 'failed', 'cancel-requested', 'unknown']);
const cleanup = z.enum(['pending', 'stopping', 'stopped', 'unknown']);
const collection = z.enum(['unavailable', 'ready', 'consumed', 'unknown']);
export const operatorActivitySummarySchema = z.strictObject({
  activityId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  operatorId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  executionStatus: status,
  cleanupStatus: cleanup,
  collectionStatus: collection,
  attention: z.boolean(),
  sessionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).nullable(),
  source: z.string().max(256).nullable(),
  updatedAt: z.union([z.string().datetime(), z.number().int().nonnegative()]),
});
export type OperatorActivitySummary = z.infer<typeof operatorActivitySummarySchema>;
const listSchema = z.strictObject({ items: z.array(operatorActivitySummarySchema).max(100) });
export function listOperatorActivities(): Promise<{ items: OperatorActivitySummary[] }> {
  return baseFetch('/api/operator-activities', {}, { credentials: 'same-origin', schema: listSchema });
}
export function cancelOperatorActivity(activityId: string): Promise<OperatorActivitySummary> {
  return baseFetch(`/api/operator-activities/${encodeURIComponent(activityId)}/cancel`, { method: 'POST', body: '{}' },
    { credentials: 'same-origin', schema: operatorActivitySummarySchema });
}
