import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { afterAll, expect } from 'vitest';
import { unstable_startWorker } from 'wrangler';
import { registerNativeDispatcherCases } from './flue-native-cases';
import type { ActivityFixtureCommand } from './loader-worker';
import type { OperatorActivityPreparation } from '../../../operators/activity';

type FixtureWorker = Awaited<ReturnType<typeof unstable_startWorker>>;

/** Each test file owns a separate workerd; every owned case still resets it. */
export function registerFlueShard(index: number) {
  let worker: FixtureWorker | undefined;
  let traceArmed = false;
  async function startWorker() {
    // Pinned unstable_dev ignores experimental.watch; this API honors dev.watch.
    worker = await unstable_startWorker({
      entrypoint: fileURLToPath(new URL('./loader-worker.ts', import.meta.url)),
      config: fileURLToPath(new URL('./wrangler.toml', import.meta.url)),
      dev: {
        remote: false, server: { hostname: '127.0.0.1', port: 0 }, inspector: { port: 0 },
        persist: false, logLevel: 'error', watch: false,
      },
    });
    await worker.ready;
  }
  afterAll(async () => { await worker?.dispose(); });

  async function command(path: string, value: unknown): Promise<unknown> {
    const response = await worker!.fetch(new URL(path, 'http://placeholder'), {
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
    fetch: async (path, init): Promise<Response> => {
      // Temporary CI-only debugger setup, before the original large-case start.
      // Preserve its request, body, response construction and existing abort.
      if (index === 1 && !traceArmed && process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_TEMP
        && path.startsWith('/dispatcher-composed?activity=large-evidence-')) {
        traceArmed = true;
        const arm = join(process.env.RUNNER_TEMP, 'native-close-arm.json');
        const ready = join(process.env.RUNNER_TEMP, 'native-close-ready.json');
        writeFileSync(`${arm}.tmp`, JSON.stringify({ nodePid: process.pid }), { flag: 'wx' });
        renameSync(`${arm}.tmp`, arm);
        const deadline = Date.now() + 10_000;
        while (!existsSync(ready) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
        if (!existsSync(ready)) throw new Error('Native closure trace did not attach');
        const status = (JSON.parse(readFileSync(ready, 'utf8')) as { status: unknown }).status;
        if (status !== 'ready') throw new Error('Native closure trace setup failed');
      }
      return (await worker!.fetch(new URL(path, 'http://placeholder'), init as unknown as Parameters<FixtureWorker['fetch']>[1])) as unknown as Response;
    },
    // No redundant beforeAll boot: the first owned case starts its fresh worker here.
    reset: async () => { await worker?.dispose(); await startWorker(); },
    queuedActivity,
    activity,
  }, 'flue', { index, total: 3 });
}
