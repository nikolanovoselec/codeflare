/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { OperatorActivity } from '../../operators/activity';
import type { Env } from '../../types';

const activityId = '9024a801-8bbd-426a-8330-59fdf5b8d688';
const artifactDigest = 'f6dd11afab3bf35f32fefd160d9d899d3d14fcb2c12690a79fca82c7760d7309';
const reason = 'SYNTHETIC_PRIVATE_EXCEPTION';
async function inspect(change: string) {
  const namespace = (env as unknown as { OPERATOR_ACTIVITY: DurableObjectNamespace }).OPERATOR_ACTIVITY;
  await runInDurableObject(namespace.getByName(`inspection-${crypto.randomUUID()}`), async (_instance, ctx) => {
    const admission = { ownerKey: 'owner', phase: 'queued', intent: { activityId },
      drive: { generation: 2, status: 'unknown' }, executionContext: { artifactDigest },
      receipt: { intentDigest: 'a'.repeat(64), selection: { operator: { profile: 'dispatcher' }, release: { bundleDigest: artifactDigest } } } };
    const lease = { generation: 1, status: 'unknown', sdkReleased: true, artifactDigest, inputDigest: 'a'.repeat(64), submissionId: 'original',
      projection: { outcome: 'failed', error: { type: 'operation_failed', meta: { operation: 'direct(original)', reason } } } };
    const bindings = { ...env, ENTERPRISE_MODE: 'active', CLOUDFLARE_WORKER_NAME: 'codeflare-enterprise-integration' } as unknown as Env;
    if (change === 'activity') admission.intent.activityId = 'foreign';
    if (change === 'owner') admission.ownerKey = 'foreign';
    if (change === 'running') admission.drive.status = 'running';
    if (change === 'generation') admission.drive.generation = 3;
    if (change === 'input') lease.inputDigest = 'b'.repeat(64);
    if (change === 'artifact') lease.artifactDigest = 'b'.repeat(64);
    if (change === 'release') admission.receipt.selection.release.bundleDigest = 'b'.repeat(64);
    if (change === 'outcome') lease.projection.outcome = 'completed';
    if (change === 'submission') lease.projection.error.meta.operation = 'direct(foreign)';
    if (change === 'error-type') lease.projection.error.type = 'internal_error';
    if (change === 'empty') lease.projection.error.meta.reason = '';
    if (change === 'environment') bindings.CLOUDFLARE_WORKER_NAME = 'codeflare-enterprise';
    if (change === 'mode') bindings.ENTERPRISE_MODE = undefined;
    await ctx.storage.put('admission', admission);
    if (change !== 'missing') await ctx.storage.put('dispatcher:lease', lease);
    const activity = new OperatorActivity(ctx, bindings);
    expect(await activity.inspectDispatcherFailure('owner')).toEqual(change === 'eligible' ? { reason } : null);
  });
}

it.each(['eligible', 'activity', 'owner', 'running', 'generation', 'input', 'artifact', 'release', 'outcome',
  'submission', 'error-type', 'empty', 'environment', 'mode', 'missing'])(
  'REQ-OPERATOR-079: stored private failure inspection respects %s evidence boundaries', inspect);
