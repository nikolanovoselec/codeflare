import { z } from 'zod';
import { reviewAdmissionSchema, reviewContextSchema, reviewDigest, reviewDigestSchema, reviewIdSchema, reviewJson,
  reviewShaSchema, sameReviewContext, validReviewContext, type PreparedReview } from './review-packet';
import { reviewHistoryFindingSchema, type ReviewFinding, type ReviewResults } from './review-results';

const rebuttalSchema = z.strictObject({ id: reviewIdSchema, findingId: reviewIdSchema,
  authorId: z.number().int().positive().safe(), body: z.string().min(1).max(16384), digest: reviewDigestSchema, head: reviewShaSchema });
type ReviewRebuttal = z.infer<typeof rebuttalSchema>;
const recordSchema = reviewAdmissionSchema.extend(reviewContextSchema.shape).extend({
  packetDigest: reviewDigestSchema, status: z.enum(['complete', 'incomplete', 'failed']),
  findings: z.array(reviewHistoryFindingSchema).max(300), resolvedFindingIds: z.array(reviewIdSchema).max(300),
  rebuttals: z.array(rebuttalSchema).max(300),
});
const snapshotSchema = z.strictObject({ complete: z.boolean(), records: z.array(recordSchema).max(100),
  rebuttals: z.array(rebuttalSchema).max(300) });
export interface ReviewHistoryServices {
  authorize(): Promise<void>;
  readContext(repositoryId: number, pullRequest: number): Promise<unknown>;
  /** GitHub is authoritative: fetch bounded, paginated records oldest-first from the configured
   * publisher app/workflow. Verify origin, immutable record bytes, check/run/attempt identities and
   * monotonic admitted ordering. Ordinary PR comments and package claims are NOT history records.
   * Return complete:false on missing pages, invalid provenance or insufficient permissions. */
  readHistory(repositoryId: number, pullRequest: number): Promise<unknown>;
  /** Re-fetch immutable GitHub comment identity/body/author and current authorized reviewer role. */
  authorizeRebuttal(rebuttal: ReviewRebuttal): Promise<boolean>;
}
export interface ReviewHistory {
  findings: ReviewFinding[]; rebuttals: ReviewRebuttal[]; clear: boolean; coverageAdvanced: boolean;
  sourceDigest: string | null; roundDigest: string | null;
}
export async function reviewRoundDigest(prepared: PreparedReview, result: ReviewResults): Promise<string> {
  return reviewDigest(reviewJson({ admission: prepared.admission, context: prepared.context,
    packetDigest: prepared.packetDigest, manifestDigest: result.manifestDigest, reports: result.reports }));
}

/** Pure domain reconciliation over a trusted GitHub reader; never a local completion file. */
export async function reconcileReviewHistory(prepared: PreparedReview, result: ReviewResults, github: ReviewHistoryServices): Promise<ReviewHistory> {
  const outcome: ReviewHistory = { findings: [], rebuttals: [], clear: false, coverageAdvanced: false, sourceDigest: null, roundDigest: null };
  const findings = new Map<string, ReviewFinding>();
  const rebuttals = new Map<string, ReviewRebuttal>();
  try {
    await github.authorize();
    const snapshotValue = await github.readHistory(prepared.admission.repositoryId, prepared.admission.pullRequest);
    if (reviewJson(snapshotValue).byteLength > 8 * 1024 * 1024) throw Error('Review history exceeds bound');
    const snapshot = snapshotSchema.parse(snapshotValue);
    let complete = snapshot.complete;
    for (const record of snapshot.records) {
      validReviewContext({ repositoryId: record.repositoryId, pullRequest: record.pullRequest, head: record.head,
        base: record.base, mergeBase: record.mergeBase, headPullRequests: record.headPullRequests, mergeQueue: record.mergeQueue }, prepared.admission);
      for (const finding of record.findings) {
        const original = findings.get(finding.id);
        if (original && JSON.stringify(original) !== JSON.stringify(finding)) throw Error('Finding evidence was rewritten');
        findings.set(finding.id, finding);
      }
      // Only authenticated, complete GitHub records can resolve earlier findings. Partial/failed records
      // may add evidence but can never advance coverage or erase the original unresolved evidence.
      if (record.status === 'complete') for (const id of record.resolvedFindingIds) findings.delete(id);
      for (const rebuttal of record.rebuttals) {
        const original = rebuttals.get(rebuttal.id);
        if (original && JSON.stringify(original) !== JSON.stringify(rebuttal)) throw Error('Rebuttal snapshot changed');
        rebuttals.set(rebuttal.id, rebuttal);
      }
    }
    for (const rebuttal of snapshot.rebuttals) {
      await github.authorize();
      if (!findings.has(rebuttal.findingId) || await reviewDigest(new TextEncoder().encode(rebuttal.body)) !== rebuttal.digest
        || !await github.authorizeRebuttal(rebuttal)) { complete = false; continue; }
      const original = rebuttals.get(rebuttal.id);
      if (original && JSON.stringify(original) !== JSON.stringify(rebuttal)) { complete = false; continue; }
      rebuttals.set(rebuttal.id, rebuttal);
    }
    for (const report of result.reports) for (const finding of report.findings) {
      const entry = { ...finding, lane: report.lane };
      // Repeated IDs retain their original evidence. New rounds cannot rewrite it to clear a defect.
      if (!findings.has(finding.id)) findings.set(finding.id, entry);
    }
    outcome.findings = [...findings.values()];
    outcome.rebuttals = [...rebuttals.values()];
    await github.authorize();
    const current = validReviewContext(await github.readContext(prepared.admission.repositoryId, prepared.admission.pullRequest), prepared.admission);
    await github.authorize();
    outcome.sourceDigest = await reviewDigest(reviewJson(snapshot));
    outcome.roundDigest = await reviewRoundDigest(prepared, result);
    outcome.coverageAdvanced = complete && result.status === 'complete' && sameReviewContext(prepared.context, current);
    outcome.clear = outcome.coverageAdvanced && outcome.findings.length === 0;
  } catch {
    outcome.findings = [...findings.values()]; outcome.rebuttals = [...rebuttals.values()];
    outcome.coverageAdvanced = false; outcome.clear = false;
  }
  return outcome;
}
