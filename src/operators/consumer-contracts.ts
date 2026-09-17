/**
 * REQ-OPERATOR-009 generic consumer boundary.
 *
 * This module owns bounded transport identity only. Codeflare parents select
 * resources and authorize session origin before private operator code runs.
 * Stable run/source/revision/input identities reconcile exact repeats; conflicts
 * are never retried as new work. Attachments are opaque references, not paths or
 * bytes. No field grants Review/history, credentials, admission or egress.
 */
import { z } from 'zod';
import { ValidationError } from '../lib/error-types';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const reference = z.string().min(1).max(256).refine(value => value.trim() === value && !/[\x00-\x1f\x7f]/.test(value));
const attachment = z.strictObject({
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/),
  mediaType: z.string().regex(/^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/),
  size: z.number().int().nonnegative().max(8 * 1024 * 1024), sha256: digest, locator: id,
});
const invocationSchema = z.strictObject({
  schemaVersion: z.literal(1), interfaceVersion: z.literal(1), consumerId: id,
  activityId: id, operatorId: id, runId: id,
  source: z.strictObject({ kind: z.enum(['direct', 'session', 'webhook']), reference }),
  revision: z.strictObject({ reference, digest }), inputDigest: digest,
  input: z.json(), attachments: z.array(attachment).max(16),
  resources: z.strictObject({
    inference: z.strictObject({ routeId: id, reasoningLevel: z.string().max(16).nullable() }).nullable(),
    session: z.strictObject({ profileId: id }).nullable(),
    storage: z.strictObject({ scopeId: id }).nullable(),
  }),
}).refine(value => new Set(value.attachments.map(item => item.name)).size === value.attachments.length
  && value.attachments.reduce((total, item) => total + item.size, 0) <= 8 * 1024 * 1024);
export type OperatorConsumerInvocation = z.infer<typeof invocationSchema>;

function safeInput(value: unknown): boolean {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length) {
    const item = stack.pop()!;
    if (++nodes > 1024 || item.depth > 32) return false;
    if (!item.value || typeof item.value !== 'object') continue;
    if (Array.isArray(item.value)) {
      for (const child of item.value) stack.push({ value: child, depth: item.depth + 1 });
      continue;
    }
    for (const [key, child] of Object.entries(item.value)) {
      if (/authority|credential|secret|token|access.?jwt/i.test(key)) return false;
      stack.push({ value: child, depth: item.depth + 1 });
    }
  }
  return true;
}

export function parseOperatorConsumerInvocation(input: unknown): OperatorConsumerInvocation {
  try {
    const json = JSON.stringify(input);
    if (typeof json !== 'string' || new TextEncoder().encode(json).byteLength > 64 * 1024) throw new Error();
    const parsed = invocationSchema.parse(input);
    if (!safeInput(parsed.input)) throw new Error();
    return parsed;
  } catch { throw new ValidationError('Invalid consumer invocation'); }
}

export function reconcileOperatorConsumerInvocation(existing: OperatorConsumerInvocation,
  candidate: unknown): OperatorConsumerInvocation {
  const previous = parseOperatorConsumerInvocation(existing);
  const next = parseOperatorConsumerInvocation(candidate);
  if (JSON.stringify(previous) !== JSON.stringify(next)) throw new ValidationError('Consumer invocation conflict');
  return previous;
}

export type OperatorSessionOrigin = { kind: 'human'; ownerKey: string } | {
  kind: 'operator'; parentActivityId: string };
export function validateOperatorSessionOrigin(origin: unknown, parent: { principal: 'human' | 'operator';
  ownerKey: string; activityId: string | null }): OperatorSessionOrigin {
  const ownerKey = digest.safeParse(parent.ownerKey);
  if (!ownerKey.success) throw new ValidationError('Invalid session origin');
  if (parent.principal === 'human') {
    const parsed = z.strictObject({ kind: z.literal('human'), ownerKey: digest }).safeParse(origin);
    if (!parsed.success || parsed.data.ownerKey !== parent.ownerKey || parent.activityId !== null) {
      throw new ValidationError('Invalid session origin');
    }
    return parsed.data;
  }
  if ((origin as { kind?: unknown } | null)?.kind === 'human') {
    throw new ValidationError('Recursive operator human admission denied');
  }
  const parsed = z.strictObject({ kind: z.literal('operator'), parentActivityId: id }).safeParse(origin);
  if (!parsed.success || !parent.activityId || parsed.data.parentActivityId !== parent.activityId) {
    throw new ValidationError('Invalid session origin');
  }
  return parsed.data;
}
