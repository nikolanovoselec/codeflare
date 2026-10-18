import { z } from 'zod';
import { renovateRepositoryIdentity } from './renovate-run-settings';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const head = z.string().regex(/^[0-9a-f]{40}$/);
const positive = z.number().int().positive().safe();

/** Parent-only Activity projection, never a child result or browser-supplied retry grant. */
export const prospectiveRenovateRetryProof = renovateRepositoryIdentity.extend({
  activityId: id, generation: positive, pullRequest: positive, head,
  artifactDigest: digest, createdAt: z.string().datetime(), terminalAt: z.number().int().nonnegative().safe(),
  collected: z.literal(true), settled: z.literal(true), sdkSubmissionId: id,
  disposition: z.enum(['EXECUTION_FAILED', 'DEFERRED']),
}).strict();
export type ProspectiveRenovateRetryProof = z.infer<typeof prospectiveRenovateRetryProof>;

export type RetainedRenovateRetryTarget = {
  repositoryId: number; pullRequest: number; head: string; createdAt: string;
};
