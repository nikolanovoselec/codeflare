import { createHash } from 'node:crypto';
import { fileURLToPath, URL } from 'node:url';
import { afterAll, expect } from 'vitest';
import { unstable_dev, type Unstable_DevWorker } from 'wrangler';
import { registerNativeDispatcherCases } from './flue-native-cases';
import type { ActivityFixtureCommand } from './loader-worker';
import type { OperatorActivityPreparation } from '../../../operators/activity';

/** Each test file owns a separate workerd; every owned case still resets it. */
export function registerFlueShard(index: number) {
  let worker: Unstable_DevWorker | undefined;
  async function startWorker() {
    worker = await unstable_dev(fileURLToPath(new URL('./loader-worker.ts', import.meta.url)), {
      config: fileURLToPath(new URL('./wrangler.toml', import.meta.url)),
      local: true, ip: '127.0.0.1', port: 0, inspectorPort: 0, persist: false, logLevel: 'error',
      experimental: { disableExperimentalWarning: true, disableDevRegistry: true, watch: false },
    });
  }
  afterAll(async () => { await worker?.stop(); });

  async function command(path: string, value: unknown): Promise<unknown> {
    const response = await worker!.fetch(path, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value),
    });
    const result = await response.json();
    expect(response.status, JSON.stringify(result)).toBe(200);
    return result;
  }
  const activity = (id: string, value: ActivityFixtureCommand) =>
    command(`/activity?activity=${id}`, value);

  async function queuedActivity(patch: Partial<OperatorActivityPreparation> = {}): Promise<OperatorActivityPreparation> {
    const operatorId = `operator-${crypto.randomUUID()}`;
    const artifactDigest = 'a'.repeat(64);
    const fixture = 'registry';
    expect(await command(`/registry?fixture=${fixture}`, { action: 'create', operatorId })).toMatchObject({ ok: true });
    expect(await command(`/registry?fixture=${fixture}`, {
      action: 'approve', operatorId, artifactDigest, expectedRevision: 1,
    })).toMatchObject({ ok: true });
    expect(await command(`/registry?fixture=${fixture}`, {
      action: 'enable', operatorId, enabled: true, expectedRevision: 2,
    })).toMatchObject({ ok: true });
    const startToken = 's'.repeat(43);
    const intent: OperatorActivityPreparation = {
      operatorId, activityId: crypto.randomUUID(), intentDigest: 'b'.repeat(64),
      expectedRevision: 3, deadline: Date.now() + 60_000,
      startVerifier: createHash('sha256').update(startToken).digest('hex'),
      startExpiresAt: Date.now() + 60_000, ...patch,
    };
    expect(await activity(intent.activityId, { action: 'prepare', intent }))
      .toEqual({ ok: true, phase: 'prepared' });
    expect(await activity(intent.activityId, { action: 'start', capability: startToken }))
      .toEqual({ ok: true, phase: 'queued' });
    return intent;
  }

  registerNativeDispatcherCases({
    fetch: async (path, init): Promise<Response> =>
      (await worker!.fetch(path, init as unknown as Parameters<Unstable_DevWorker['fetch']>[1])) as unknown as Response,
    // No redundant beforeAll boot: the first owned case starts its fresh worker here.
    reset: async () => { await worker?.stop(); await startWorker(); },
    queuedActivity,
    activity,
  }, 'flue', { index, total: 3 });
}
