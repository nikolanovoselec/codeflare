import { z } from 'zod';
import { REVIEW_LANES, reviewDigest, reviewDigestSchema, reviewJson, sameReviewContext, validReviewContext,
  type PreparedReview } from './review-packet';
import { reviewReportSchema, type ReviewResults } from './review-results';
import { reviewRoundDigest, type ReviewHistory } from './review-history';

const idsSchema = z.strictObject({ checkId: z.number().int().positive().safe(), recordId: z.number().int().positive().safe() });
const receiptSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('pending'), digest: reviewDigestSchema }),
  z.strictObject({ state: z.literal('published'), digest: reviewDigestSchema, ...idsSchema.shape }),
]);
type ReviewPublicationReceipt = z.infer<typeof receiptSchema>;
export interface ReviewPublisherAuthority {
  /** Existing root serialization shared with generation admission, keyed by repository/PR.
   * This is NOT a package capability and must run in a separate credential-bearing trusted job. */
  serialize<T>(run: () => Promise<T>): Promise<T>;
  authorize(): Promise<void>;
  /** Read GitHub head/base/merge-base and root's latest admitted activity/generation together. */
  readCurrent(): Promise<unknown>;
  loadReceipt(externalId: string): Promise<unknown>;
  saveReceipt(receipt: ReviewPublicationReceipt, externalId: string): Promise<void>;
  /** Reconcile exact app/check/record IDs and immutable content digest; do not select by check name alone. */
  findPublication(externalId: string): Promise<unknown>;
  /** Write one generation-specific shadow check and immutable record; return their exact numeric IDs.
   * On partial/ambiguous write, reconciliation must recover both IDs or remain unknown. Never retry blindly. */
  writePublication(record: ReviewPublicationRecord): Promise<unknown>;
}
interface ReviewPublicationRecord {
  externalId: string; shadow: true; conclusion: 'success' | 'failure'; status: 'complete';
  repositoryId: number; pullRequest: number; activityId: string; generation: number;
  head: string; base: string; mergeBase: string; packetDigest: string; manifestDigest: string;
  inputDigest: string; packageDigest: string; resourceDigest: string; policyDigest: string;
  workflowId: number; runId: number; runAttempt: number; headPullRequests: number[]; mergeQueue: boolean;
  findings: ReviewHistory['findings']; rebuttals: ReviewHistory['rebuttals']; resolvedFindingIds: string[];
  historyDigest: string; reports: ReviewResults['reports'];
}
export type ReviewPublicationOutcome = { status: 'published'; checkId: number; recordId: number }
  | { status: 'stale' | 'incomplete' | 'unknown' | 'conflict' };

/** Inputs are restored parent-owned prepared/sync/history evidence, never HTTP request labels.
 * No reviewer or candidate execution occurs in this module or near its publisher authority. */
export async function publishReview(prepared: PreparedReview, result: ReviewResults, history: ReviewHistory,
  publisher: ReviewPublisherAuthority): Promise<ReviewPublicationOutcome> {
  if (!prepared.evidenceComplete || result.status !== 'complete' || result.cleanup !== 'stopped' || !result.manifestDigest
    || !reviewDigestSchema.safeParse(result.manifestDigest).success || !history.coverageAdvanced || !history.sourceDigest
    || result.reports.length !== REVIEW_LANES.length
    || history.roundDigest !== await reviewRoundDigest(prepared, result)) return { status: 'incomplete' };
  const reports = result.reports.map(report => reviewReportSchema.safeParse(report));
  if (reports.some((report, index) => !report.success || !report.data.complete || report.data.lane !== REVIEW_LANES[index]
    || report.data.head !== prepared.context.head || report.data.packetDigest !== prepared.packetDigest
    || report.data.generation !== prepared.admission.generation)) return { status: 'incomplete' };
  const externalId = `review-${prepared.admission.repositoryId}-${prepared.admission.pullRequest}-${prepared.admission.activityId}-generation-${prepared.admission.generation}`;
  const record: ReviewPublicationRecord = { ...prepared.admission, ...prepared.context,
    externalId, shadow: true, status: 'complete', conclusion: history.findings.length === 0 ? 'success' : 'failure',
    packetDigest: prepared.packetDigest, manifestDigest: result.manifestDigest, historyDigest: history.sourceDigest,
    findings: structuredClone(history.findings), rebuttals: structuredClone(history.rebuttals), resolvedFindingIds: [],
    reports: structuredClone(result.reports) };
  const bytes = reviewJson(record);
  if (bytes.byteLength > 8 * 1024 * 1024) return { status: 'incomplete' };
  const digest = await reviewDigest(bytes);
  const current = async () => {
    await publisher.authorize();
    const observed = await publisher.readCurrent();
    const parsed = z.object({ activityId: z.string(), generation: z.number() }).passthrough().parse(observed);
    const { activityId, generation, ...revision } = parsed;
    const context = validReviewContext(revision, prepared.admission);
    await publisher.authorize();
    return activityId === prepared.admission.activityId && generation === prepared.admission.generation
      && sameReviewContext(context, prepared.context);
  };
  try {
    return await publisher.serialize(async (): Promise<ReviewPublicationOutcome> => {
      if (!await current()) return { status: 'stale' };
      const previous = await publisher.loadReceipt(externalId);
      if (previous) {
        const receipt = receiptSchema.parse(previous);
        if (receipt.digest !== digest) return { status: 'conflict' };
        if (receipt.state === 'published') return await current()
          ? { status: 'published', checkId: receipt.checkId, recordId: receipt.recordId } : { status: 'stale' };
        const found = await publisher.findPublication(externalId);
        if (!found) return { status: 'unknown' };
        const recovered = idsSchema.extend({ digest: reviewDigestSchema }).parse(found);
        if (recovered.digest !== digest) return { status: 'conflict' };
        await publisher.saveReceipt({ state: 'published', ...recovered }, externalId);
        return await current() ? { status: 'published', checkId: recovered.checkId, recordId: recovered.recordId } : { status: 'stale' };
      }
      // Durable intent precedes the first write. A crash or lost response leaves a reconcilable
      // pending receipt, not permission to create another successful check.
      await publisher.saveReceipt({ state: 'pending', digest }, externalId);
      if (!await current()) return { status: 'stale' };
      const ids = idsSchema.parse(await publisher.writePublication(record));
      await publisher.saveReceipt({ state: 'published', digest, ...ids }, externalId);
      return await current() ? { status: 'published', ...ids } : { status: 'stale' };
    });
  } catch { return { status: 'unknown' }; }
}
