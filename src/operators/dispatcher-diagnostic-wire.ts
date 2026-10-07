import { z } from 'zod';

/** Private, non-authorizing producer wire. No free text, values, URLs or caller identity. */
const producerRoles = ['discover', 'research', 'decide', 'seal', 'comment', 'merge', 'finish', 'agent', 'provider'] as const;
export const producerCodes = ['none', 'unknown', 'schema-validation', 'target-admission', 'persisted-target',
  'repository-scope', 'immutable-ref', 'discovery-incomplete', 'source-incomplete', 'source-http', 'source-redirect',
  'source-transport', 'source-format', 'source-secret', 'source-provenance', 'decision-missing', 'decision-conflict',
  'already-sealed', 'not-sealed', 'citation-provenance', 'upgrade-evidence', 'decisions-incomplete', 'receipt-unavailable',
  'capacity', 'result-size', 'merge-decision', 'comment-receipt', 'results-incomplete', 'effect-unknown',
  'effect-denied', 'provider-token-bound', 'provider-fetch', 'provider-http', 'runtime-shape'] as const;
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const flag = z.boolean();
export const producerDiagnosticSchema = z.object({
  stage: z.literal('producer'), role: z.enum(producerRoles), phase: z.enum(['input', 'serialize', 'digest', 'fetch', 'response', 'tool', 'finish']).optional(), outcome: z.enum(['started', 'completed', 'failed', 'unavailable']),
  code: z.enum(producerCodes), errorKind: z.enum(['none', 'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ValidationError',
    'TransportDenied', 'DefiniteEffectFailure', 'other']).optional(),
  errorDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(), inputBytes: count.optional(), elapsedMs: count.optional(),
  targetCount: count.optional(), decisionCount: count.optional(), artifactCount: count.optional(), commentCount: count.optional(),
  resultCount: count.optional(), unknownOperationCount: count.optional(), sourceOperationCount: count.optional(),
  discovered: flag.optional(), sealed: flag.optional(), status: z.number().int().min(100).max(599).optional(),
  claimIndex: count.optional(), claimCount: count.optional(), artifactFound: flag.optional(), artifactComplete: flag.optional(),
  quoteMatched: flag.optional(), commentContainsSource: flag.optional(), repositoryEvidence: flag.optional(),
  upstreamEvidence: flag.optional(), analysisComplete: flag.optional(), gapCount: count.optional(),
  requestBytes: count.optional(), messages: count.optional(), tools: count.optional(), completionTokens: count.optional(),
  completionTokenLimit: count.optional(), tokenValueType: z.enum(['absent', 'number', 'string', 'object', 'array', 'boolean', 'null', 'other']).optional(), tokenFields: z.enum(['none', 'alias', 'canonical', 'both', 'invalid']).optional(),
  argumentFields: z.array(z.enum(['target', 'decision', 'comment', 'claims', 'bindings', 'analysis', 'url', 'kind', 'offset'])).max(9).optional(),
}).strict();
export type ProducerDiagnostic = z.infer<typeof producerDiagnosticSchema>;

/** Only exact public implementation errors receive readable codes; unknown text stays a digest. */
export function sdkPublicReasonCode(reason: string): typeof producerCodes[number] {
  const publicReasons: Record<string, typeof producerCodes[number]> = {
    'Unadmitted target': 'target-admission', 'Persisted targets differ from parent admission': 'persisted-target',
    'Repository scope required': 'repository-scope', 'Immutable repository ref required': 'immutable-ref',
    'Discovery incomplete within whole-journey budget': 'discovery-incomplete',
    'GitHub evidence unavailable or incomplete': 'source-incomplete', 'Decision not recorded': 'decision-missing',
    'Decision already recorded': 'decision-conflict', 'Journey already sealed': 'already-sealed',
    'Aggregate journey must be sealed before effects': 'not-sealed', 'Citation provenance unavailable': 'citation-provenance',
    'Applicable upgrade safety evidence incomplete; choose DO_NOT_MERGE': 'upgrade-evidence',
    'Decisions incomplete': 'decisions-incomplete', 'Actual ledger receipt unavailable': 'receipt-unavailable',
    'Submission result oversized before effects': 'result-size', 'Submission result oversized': 'result-size',
    'MERGE decision not recorded': 'merge-decision', 'Posted comment receipt required': 'comment-receipt',
    'Results incomplete or effect unknown': 'results-incomplete',
    'Dispatcher effect unknown; completion cannot continue': 'effect-unknown',
    'Dispatcher inference token limit denied': 'provider-token-bound',
  };
  const value = reason.startsWith('Error: ') ? reason.slice(7) : reason;
  if (Object.hasOwn(publicReasons, value)) return publicReasons[value];
  if (/^Parent inference denied: [345]\d{2}$/.test(value)) return 'provider-http';
  return 'unknown';
}
