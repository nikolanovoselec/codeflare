import { z } from 'zod';
import { verifyOperatorSync, type OperatorSyncExpectation, type OperatorSyncReader } from './sync-verification';
import { REVIEW_LANES, parseReviewJson, reviewDigestSchema, reviewIdSchema, reviewLaneSchema,
  reviewPathSchema, reviewShaSchema, type PreparedReview } from './review-packet';

export const reviewFindingSchema = z.strictObject({
  id: reviewIdSchema, severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']), path: reviewPathSchema,
  line: z.number().int().positive().safe(), evidence: z.string().min(1).max(8192), message: z.string().min(1).max(4096),
});
export const reviewHistoryFindingSchema = reviewFindingSchema.extend({ lane: reviewLaneSchema });
export type ReviewFinding = z.infer<typeof reviewHistoryFindingSchema>;
export const reviewReportSchema = z.strictObject({
  schemaVersion: z.literal(1), lane: reviewLaneSchema, packetDigest: reviewDigestSchema, head: reviewShaSchema,
  generation: z.number().int().positive().safe(), complete: z.boolean(), omissions: z.array(z.string().min(1).max(2048)).max(64),
  findings: z.array(reviewFindingSchema).max(100),
}).refine(report => (!report.complete || report.omissions.length === 0)
  && new Set(report.findings.map(f => f.id)).size === report.findings.length);
export type ReviewReport = z.infer<typeof reviewReportSchema>;
export interface ReviewResults {
  status: 'complete' | 'incomplete'; cleanup: 'stopped' | 'unknown'; reports: ReviewReport[];
  manifestDigest: string | null;
}
export interface ReviewResultServices {
  authorize(): Promise<void>;
  /** Invoke the existing explicit sync service, then seal this owned operation against writes.
   * Expectation is parent-established, never a model-returned bucket/path/digest. */
  syncAndSeal(): Promise<OperatorSyncExpectation>;
  read: OperatorSyncReader;
  /** Existing owned-session service; cleanup is independent from report success/authority expiry. */
  stopOwnedSession(): Promise<'stopped' | 'unknown'>;
}

/** No task text or upload claim is accepted as a persisted report. */
export async function collectReviewReports(prepared: PreparedReview, services: ReviewResultServices): Promise<ReviewResults> {
  const result: ReviewResults = { status: 'incomplete', cleanup: 'unknown', reports: [], manifestDigest: null };
  try {
    await services.authorize();
    const expected = await services.syncAndSeal();
    if (expected.activityId !== prepared.admission.activityId || expected.requestDigest !== prepared.admission.inputDigest
      || expected.policyDigest !== prepared.admission.policyDigest) throw Error('Review sync scope mismatch');
    const objects = new Map<string, Uint8Array>();
    await verifyOperatorSync(expected, async (key, maxBytes) => {
      await services.authorize();
      const bytes = await services.read(key, maxBytes);
      await services.authorize();
      if (bytes) objects.set(key, Uint8Array.from(bytes));
      return bytes;
    });
    result.manifestDigest = expected.manifestDigest;
    for (const lane of REVIEW_LANES) {
      const bytes = objects.get(`${expected.filePrefix}reports/${lane}.json`);
      if (!bytes) continue;
      const report = reviewReportSchema.parse(parseReviewJson(bytes));
      if (report.lane !== lane || report.head !== prepared.context.head || report.packetDigest !== prepared.packetDigest
        || report.generation !== prepared.admission.generation) throw Error('Review report binding mismatch');
      result.reports.push(report);
    }
    await services.authorize();
    const findingIds = result.reports.flatMap(report => report.findings.map(finding => finding.id));
    if (new Set(findingIds).size !== findingIds.length) throw Error('Review finding identity collision');
    if (prepared.evidenceComplete && result.reports.length === REVIEW_LANES.length && result.reports.every(r => r.complete)) {
      result.status = 'complete';
    }
  } catch {
    // Keep independently verified partial reports, never elevate them to a complete round.
    result.status = 'incomplete';
  } finally {
    try { result.cleanup = await services.stopOwnedSession(); } catch { result.cleanup = 'unknown'; }
  }
  return result;
}
