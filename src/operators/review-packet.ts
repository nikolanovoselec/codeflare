import { z } from 'zod';

export const REVIEW_LANES = ['code-reviewer', 'spec-reviewer', 'doc-updater'] as const;
export const reviewLaneSchema = z.enum(REVIEW_LANES);
export type ReviewLane = typeof REVIEW_LANES[number];
export const reviewDigestSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const reviewIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const reviewShaSchema = z.string().regex(/^[0-9a-f]{40}$/);
const positive = z.number().int().positive().safe();
export const reviewAdmissionSchema = z.strictObject({
  repositoryId: positive, pullRequest: positive, activityId: reviewIdSchema, generation: positive,
  inputDigest: reviewDigestSchema, packageDigest: reviewDigestSchema, resourceDigest: reviewDigestSchema,
  policyDigest: reviewDigestSchema, workflowId: positive, runId: positive, runAttempt: positive,
});
export type ReviewAdmission = z.infer<typeof reviewAdmissionSchema>;
export const reviewContextSchema = z.strictObject({
  repositoryId: positive, pullRequest: positive, head: reviewShaSchema, base: reviewShaSchema, mergeBase: reviewShaSchema,
  headPullRequests: z.array(positive).max(100), mergeQueue: z.boolean(),
});
export type ReviewContext = z.infer<typeof reviewContextSchema>;
export interface ReviewResource { role: string; path: string; digest: string; bytes: Uint8Array }
export interface PreparedReview {
  admission: ReviewAdmission; context: ReviewContext; packetDigest: string; evidenceComplete: boolean;
  packets: Array<{ lane: ReviewLane; bytes: Uint8Array }>;
  resources: ReviewResource[];
}
export interface ReviewPreparationServices {
  /** Recheck current human, captured generation, deadline, cancellation and installation before/after I/O. */
  authorize(): Promise<void>;
  readContext(repositoryId: number, pullRequest: number): Promise<unknown>;
  /** Private approved release storage only; never caller-selected files or candidate configuration. */
  readApprovedResources(packageDigest: string, resourceDigest: string): Promise<ReviewResource[]>;
  /** Trusted host invokes the platform-owned script in an isolated, hook-free, exact-revision checkout.
   * Enforce maxBytes/deadline before buffering; never execute a candidate's copy of the script. */
  runCanonicalPacket(input: { context: ReviewContext; lane: ReviewLane; script: string; args: readonly string[]; maxBytes: number }): Promise<Uint8Array>;
}
const MAX_BYTES = 8 * 1024 * 1024;
export const REVIEW_PACKET_SCRIPT = 'preseed/agents/claude/skills/review-scope/scripts/build-review-packet.mjs';
export async function reviewDigest(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes))))
    .map(b => b.toString(16).padStart(2, '0')).join('');
}
export function reviewJson(value: unknown): Uint8Array { return new TextEncoder().encode(JSON.stringify(value)); }
export function parseReviewJson(bytes: Uint8Array, maxBytes = 64 * 1024): unknown {
  if (bytes.byteLength > maxBytes) throw Error('Review data exceeds bound');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}
export function validReviewContext(value: unknown, admission: Pick<ReviewAdmission, 'repositoryId' | 'pullRequest'>): ReviewContext {
  const context = reviewContextSchema.parse(value);
  if (context.repositoryId !== admission.repositoryId || context.pullRequest !== admission.pullRequest
    || context.mergeQueue || context.headPullRequests.length !== 1 || context.headPullRequests[0] !== context.pullRequest) {
    throw Error('Review context is ambiguous or outside admission');
  }
  return context;
}
export function sameReviewContext(a: ReviewContext, b: ReviewContext): boolean {
  return a.repositoryId === b.repositoryId && a.pullRequest === b.pullRequest && a.head === b.head
    && a.base === b.base && a.mergeBase === b.mergeBase;
}
export const reviewPathSchema = z.string().min(1).max(1024).refine(path => !/[\\%\x00-\x1f\x7f]/.test(path)
  && path.split('/').every(part => part !== '' && part !== '.' && part !== '..'));
// Preserve canonical evidence verbatim. Explicit omission/truncation anywhere blocks completeness.
function requiredEvidence(lane: ReviewLane, evidence: Record<string, unknown> | undefined): boolean {
  if (!evidence || evidence.lane !== lane || 'error' in evidence) return false;
  const fields = lane === 'code-reviewer' ? ['callSites', 'anchorsCitingChanged']
    : lane === 'spec-reviewer' ? ['indexIntegrity', 'dependencyGraph', 'anchors']
    : ['indexIntegrity', 'references', 'anchors', 'docsCitingChanged'];
  return fields.every(key => evidence[key] !== null && evidence[key] !== undefined && typeof evidence[key] === 'object');
}
function incompleteEvidence(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(incompleteEvidence);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, item]) =>
    ((/omitted|truncated/i.test(key)) && item !== false && item !== null && item !== '') || incompleteEvidence(item));
}

/** Trusted admission is passed by the parent, not deserialized from the public Review request. */
export async function prepareReview(input: ReviewAdmission, services: ReviewPreparationServices): Promise<PreparedReview> {
  const admission = reviewAdmissionSchema.parse(input);
  await services.authorize();
  const context = validReviewContext(await services.readContext(admission.repositoryId, admission.pullRequest), admission);
  await services.authorize();
  const resources = structuredClone(await services.readApprovedResources(admission.packageDigest, admission.resourceDigest));
  const roles = ['parent', ...REVIEW_LANES];
  if (resources.length !== roles.length || new Set(resources.map(r => r.path)).size !== resources.length) throw Error('Missing approved Review resources');
  let total = 0;
  for (const [index, resource] of resources.entries()) {
    if (resource.role !== roles[index] || !reviewPathSchema.safeParse(resource.path).success
      || !reviewDigestSchema.safeParse(resource.digest).success || !(resource.bytes instanceof Uint8Array)
      || resource.bytes.byteLength === 0 || resource.bytes.byteLength > MAX_BYTES - total
      || await reviewDigest(resource.bytes) !== resource.digest) throw Error('Invalid approved Review resource');
    new TextDecoder('utf-8', { fatal: true }).decode(resource.bytes);
    total += resource.bytes.byteLength;
  }
  const descriptors = resources.map(({ role, path, digest }) => ({ role, path, digest }));
  if (await reviewDigest(reviewJson(descriptors)) !== admission.resourceDigest) throw Error('Review resource set mismatch');
  const packets: PreparedReview['packets'] = [];
  let evidenceComplete = true;
  const range = `${context.mergeBase}..${context.head}`;
  for (const lane of REVIEW_LANES) {
    await services.authorize();
    const bytes = Uint8Array.from(await services.runCanonicalPacket({ context: structuredClone(context), lane,
      script: REVIEW_PACKET_SCRIPT, args: ['--scope', 'diff', '--range', range, '--lane', lane, '--with-evidence'], maxBytes: MAX_BYTES - total }));
    total += bytes.byteLength;
    if (total > MAX_BYTES) throw Error('Review attachments exceed bound');
    const packet = z.object({ scope: z.literal('diff'), workSet: z.literal('changed-hunks-and-direct-invalidations'),
      lane: reviewLaneSchema, range: z.string(), files: z.array(reviewPathSchema), changedInputs: z.array(z.unknown()),
      patch: z.string(), evidence: z.record(z.string(), z.unknown()).optional(), evidenceOmitted: z.string().optional(),
    }).passthrough().parse(parseReviewJson(bytes, MAX_BYTES));
    if (packet.range !== range || packet.lane !== lane) throw Error('Canonical packet context mismatch');
    if (!requiredEvidence(lane, packet.evidence) || incompleteEvidence(packet)) evidenceComplete = false;
    packets.push({ lane, bytes });
  }
  await services.authorize();
  if (!sameReviewContext(context, validReviewContext(await services.readContext(admission.repositoryId, admission.pullRequest), admission))) {
    throw Error('Review revision changed during preparation');
  }
  await services.authorize();
  const packetDigest = await reviewDigest(reviewJson({ admission, context,
    packets: await Promise.all(packets.map(async p => ({ lane: p.lane, digest: await reviewDigest(p.bytes) }))) }));
  return { admission, context, packetDigest, evidenceComplete, packets, resources };
}
