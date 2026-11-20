import { z } from 'zod';

const commit = z.string().regex(/^[0-9a-f]{40}$/);
const id = z.number().int().positive().safe();
const citation = z.union([
  z.object({ kind: z.literal('release'), source: z.string().max(512), quote: z.string().max(1000) }),
  z.object({ kind: z.literal('guide'), source: z.string().max(512), quote: z.string().max(1000) }),
  z.object({ kind: z.literal('config'), ref: z.string().max(128) }),
]);
const assessmentSchema = z.object({ classification: z.enum(['safe', 'unsafe', 'unknown']),
  observedHead: commit, baseSha: commit, reasons: z.array(z.string().min(1).max(500)).min(1).max(5),
  compatibility: z.string().min(1).max(1000), citations: z.array(citation).max(42),
  gaps: z.array(z.string().max(300)).max(10),
  checks: z.object({ state: z.string(), observedHead: commit.nullable() }),
});
type RenovateAssessment = z.infer<typeof assessmentSchema>;
export function parsePublishableAssessment(value: unknown, target?: { repository: string; pullRequest: number }): RenovateAssessment {
  const envelope = z.object({ repository: z.string().min(1), pullRequest: id,
    observedHead: commit, readOnly: z.literal(true), assessment: assessmentSchema }).parse(value);
  if (Object.prototype.hasOwnProperty.call(value, 'classification')
    || envelope.observedHead !== envelope.assessment.observedHead
    || (target && (envelope.repository !== target.repository || envelope.pullRequest !== target.pullRequest))) {
    throw new Error('Contradictory Dispatcher assessment');
  }
  const result = envelope.assessment;
  // Historical assessment decoding is read-only; it grants no effect authority.
  if (result.classification === 'safe' && (result.gaps.length > 0 || result.citations.length === 0)) {
    throw new Error('Cited assessment unavailable');
  }
  return result;
}
