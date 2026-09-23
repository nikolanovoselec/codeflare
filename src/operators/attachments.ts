import { z } from 'zod';
import { parseOperatorConsumerInvocation, type OperatorConsumerInvocation } from './consumer-contracts';

const ID = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const DIGEST = z.string().regex(/^[0-9a-f]{64}$/);
const NAME = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);
const file = z.strictObject({ name: NAME, mediaType: z.string().min(3).max(129),
  size: z.number().int().positive().max(8 * 1024 * 1024), sha256: DIGEST, locator: ID });
const projection = z.strictObject({ schemaVersion: z.literal(1), activityId: ID,
  files: z.array(file).max(16).refine(files => new Set(files.map(item => item.name)).size === files.length
    && new Set(files.map(item => item.locator)).size === files.length
    && files.reduce((total, item) => total + item.size, 0) <= 8 * 1024 * 1024) });

export type OperatorAttachmentProjection = z.infer<typeof projection>;

export function projectOperatorAttachments(input: unknown): OperatorAttachmentProjection {
  const invocation: OperatorConsumerInvocation = parseOperatorConsumerInvocation(input);
  return projection.parse({ schemaVersion: 1, activityId: invocation.activityId, files: invocation.attachments });
}

export function parseOperatorAttachmentProjection(input: unknown): OperatorAttachmentProjection {
  return projection.parse(input);
}

export function resolveOperatorAttachment(projectionInput: unknown,
  request: { locator: string; sha256: string; size: number }): { status: 'restored'; path: string } {
  const declared = parseOperatorAttachmentProjection(projectionInput).files.find(item => item.locator === request.locator
    && item.sha256 === request.sha256 && item.size === request.size);
  if (!declared) throw new Error('Attachment scope denied');
  return { status: 'restored', path: `/run/codeflare/operator-resources/input/${declared.name}` };
}
