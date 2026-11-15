/// <reference types="@cloudflare/vitest-plugin/types" />
import { describe, expect, it, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { OperatorActivity, createOperatorIntentDigest } from '../../operators/activity';
import { createOperatorExecutionContext } from '../../operators/execution-context';
import { operatorOwnerKey } from '../../operators/browser-activity';
import type { Env } from '../../types';

const HEAD = 'b'.repeat(40);
const NOW = Date.now();
const human = { subject: 'owner', email: 'owner@example.test', issuer: 'https://owner.cloudflareaccess.com',
  audiences: ['audience'], issuedAt: Math.floor(NOW / 1000) - 10, expiresAt: Math.floor(NOW / 1000) + 300 };
const target = { repository: 'nikolanovoselec/komodo', pullRequest: 1299 };
const command = { bucket: 'owner-bucket', sessionId: 'session-1', sessionGeneration: 3, operationId: 'publication-1' };
const authority = { human, accessJwt: 'private.jwt', platformAdmin: true };
const safe = { ...target, observedHead: HEAD, readOnly: true,
  evidence: { complete: true, stale: false, truncated: false, bot: 'renovate[bot]' },
  assessment: { classification: 'safe', observedHead: HEAD, baseSha: 'a'.repeat(40),
    checks: { state: 'passing', observedHead: HEAD }, reasons: ['Compatible pinned release'],
    compatibility: 'Supported by immutable upstream guidance',
    citations: [
      { kind: 'release', source: 'https://github.com/amir20/dozzle/releases/tag/v11.1.2',
        quote: 'No changes are required for the default server or agent configuration.' },
      { kind: 'guide', source: `https://github.com/amir20/dozzle/blob/${'1'.repeat(40)}/docs/guide/agent.md`,
        quote: 'Start the agent with the agent subcommand and configure the remote server.' },
      { kind: 'config', ref: 'compose.yaml:dozzle:after' }, { kind: 'config', ref: 'compose.yaml:dozzle:before' },
      { kind: 'config', ref: 'agent/compose.yaml:dozzle-agent:after' }, { kind: 'config', ref: 'agent/compose.yaml:dozzle-agent:before' },
    ], gaps: [] } };

type Command = Parameters<OperatorActivity['publishRenovateAssessment']>[0];
type Authority = Parameters<OperatorActivity['publishRenovateAssessment']>[1];

/** No SDK drive: retain historical durable data and exercise only the retired RPC. */
async function fixture(test: (f: {
  publish: (input?: Command, actor?: Authority) => ReturnType<OperatorActivity['publishRenovateAssessment']>;
  restart: () => void; unchanged: () => Promise<void>;
}) => Promise<void>, result: unknown = safe, status = 'completed', publication?: unknown) {
  const namespace = (env as unknown as { OPERATOR_ACTIVITY: DurableObjectNamespace }).OPERATOR_ACTIVITY;
  await runInDurableObject(namespace.getByName(`retired-publisher-${crypto.randomUUID()}`), async (_instance, native) => {
    const effects: string[] = [];
    const forbidden = (effect: string): never => { effects.push(effect); throw Error(`Retired publisher attempted ${effect}`); };
    const encryption = { ENCRYPTION_KEY: btoa('a'.repeat(32)) };
    const environment = { ...encryption, ENTERPRISE_MODE: 'active',
      OPERATOR_REGISTRY: { getByName: () => forbidden('registry') },
      CONTAINER: { getByName: () => forbidden('container') },
      KV: { get: () => forbidden('identity lookup') },
      USAGE_DB: { prepare: () => forbidden('session lookup') },
    } as unknown as Env;
    Object.defineProperty(native, 'exports', { configurable: true, value: {
      GitHubInterceptor: () => ({ fetch: () => forbidden('GitHub request') }),
    } });
    const activityId = `activity-${crypto.randomUUID()}`;
    const invocationJson = JSON.stringify(target);
    const intent = { activityId, operatorId: 'operator', installationId: 'installation',
      intentDigest: await createOperatorIntentDigest('operator', activityId, invocationJson),
      expectedRevision: 1, expectedInstallationRevision: 1, expectedControlsRevision: 1,
      deadline: human.expiresAt * 1000, startExpiresAt: human.expiresAt * 1000, startVerifier: 'e'.repeat(64) };
    const context = await createOperatorExecutionContext({ activityId, operatorId: 'operator',
      artifactDigest: 'c'.repeat(64), policyDigest: 'd'.repeat(64), ...authority }, encryption);
    const retained = new Map<string, unknown>([
      ['admission', { intent, phase: 'queued', receipt: { ...intent, admittedAt: NOW, selection: {
        controlsRevision: 1, operator: { operatorId: 'operator', profile: 'dispatcher', revision: 1 },
        installation: { id: 'installation', revision: 1, releaseId: 'release' },
        release: { id: 'release', tagName: 'v0.1.47', bundleDigest: 'c'.repeat(64) }, manifestJson: '{}' } },
        executionContext: context, invocationJson, ownerKey: await operatorOwnerKey(human),
        drive: { generation: 1, status, checkpoint: null, result } }],
      ['dispatcher:journal', { generation: 1, count: 2, unresolved: 1, nextOrdinal: 2 }],
      ['dispatcher:operation:1:original-merge', { generation: 1, ordinal: 0, phase: 'unknown', requestDigest: 'f'.repeat(64),
        request: { method: 'PUT', url: `https://api.github.com/repos/${target.repository}/pulls/${target.pullRequest}/merge`,
          body: JSON.stringify({ sha: HEAD, merge_method: 'merge' }) } }],
      ['dispatcher:operation:1:original-comment', { generation: 1, ordinal: 1, phase: 'completed', requestDigest: 'e'.repeat(64),
        responseDigest: 'd'.repeat(64) }],
      ['dispatcher:response:1:original-comment', { status: 200, body: JSON.stringify({ status: 201,
        url: `https://api.github.com/repos/${target.repository}/issues/${target.pullRequest}/comments`,
        body: JSON.stringify({ id: 9001, body: 'Historical cited verdict' }) }) }],
      ...(publication === undefined ? [] : [['renovate:publication', publication] as [string, unknown]]),
    ]);
    for (const [key, value] of retained) await native.storage.put(key, value);
    let activity = new OperatorActivity(native, environment);
    const access = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => forbidden('network'));
    try {
      await test({
        publish: (input = command, actor = authority) => activity.publishRenovateAssessment(input, actor),
        restart: () => { activity = new OperatorActivity(native, environment); },
        unchanged: async () => {
          for (const [key, value] of retained) expect(await native.storage.get(key)).toEqual(value);
          expect(await native.storage.get('renovate:publication')).toEqual(publication);
          expect(effects).toEqual([]);
        },
      });
    } finally { access.mockRestore(); }
  });
}

// REQ-OPERATOR-060 is operator-owned. Root's compatibility contract is refusal,
// not a fallback approval, comment, merge, reconciliation or history rewrite.
describe('retired explicit Renovate publisher', () => {
  it.each([
    ['cited safe', safe, 'completed'],
    ['waiting safe', safe, 'waiting'],
    ['unsafe', { ...safe, assessment: { ...safe.assessment, classification: 'unsafe' } }, 'completed'],
    ['unknown', { ...safe, assessment: { ...safe.assessment, classification: 'unknown', gaps: ['Unproved migration'] } }, 'completed'],
    ['missing', null, 'completed'],
    ['flattened', safe.assessment, 'completed'],
    ['foreign target', { ...safe, repository: 'foreign/repository', pullRequest: 99 }, 'completed'],
    ['contradictory head', { ...safe, observedHead: 'f'.repeat(40) }, 'completed'],
  ])('refuses %s results without protected I/O or changing retained state', async (_name, result, status) => {
    await fixture(async f => {
      expect(await f.publish()).toEqual({ ok: false, reason: 'application-owned' });
      await f.unchanged();
    }, result, status as string);
  });

  it.each([
    ['current owner', command, authority],
    ['foreign session', { ...command, bucket: 'foreign-bucket', sessionId: 'foreign', sessionGeneration: 4 }, authority],
    ['foreign owner', command, { ...authority, human: { ...human, subject: 'foreign', email: 'foreign@example.test' } }],
    ['nonadmin', command, { ...authority, platformAdmin: false }],
    ['expired', command, { ...authority, human: { ...human, expiresAt: 1 } }],
    ['missing credential', command, { ...authority, accessJwt: '' }],
    ['forged command', { ...command, repository: 'foreign/repository', pullRequest: 99, head: HEAD }, authority],
    ['malformed command', {} as Command, authority],
  ] as const)('refuses %s input even across concurrent requests and reconstruction', async (_name, input, actor) => {
    await fixture(async f => {
      expect(await Promise.all([f.publish(input, actor), f.publish(input, actor)]))
        .toEqual([{ ok: false, reason: 'application-owned' }, { ok: false, reason: 'application-owned' }]);
      await f.unchanged();
      f.restart();
      expect(await f.publish(input, actor)).toEqual({ ok: false, reason: 'application-owned' });
      await f.unchanged();
    });
  });

  it.each([
    { phase: 'reserved', effect: 'merge', head: HEAD, operationId: 'original-merge' },
    { phase: 'unknown', effect: 'comment', head: HEAD, operationId: 'original-comment' },
    { phase: 'completed', effect: 'merge', mergeSha: HEAD, operationId: 'original-merge' },
    { phase: 'completed', effect: 'comment', commentId: 9001, operationId: 'original-comment' },
    { phase: 'completed', effect: 'approval', reviewId: 9002, operationId: 'original-approval' },
  ])('retains historical $phase $effect without reconciliation or replay', async publication => {
    await fixture(async f => {
      expect(await f.publish()).toEqual({ ok: false, reason: 'application-owned' });
      f.restart();
      expect(await f.publish({ ...command, operationId: publication.operationId })).toEqual({ ok: false, reason: 'application-owned' });
      await f.unchanged();
    }, safe, 'completed', publication);
  });
});
