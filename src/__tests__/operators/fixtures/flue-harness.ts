import { createHash } from 'node:crypto';
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
  const tracing = process.env.CI === 'true';
  let epoch = 0; // Harness correlation only, never an SDK identity or cessation receipt.
  const runtimeEvent = (stage: string, currentEpoch: number, event?: unknown) => {
    if (!tracing) return;
    try {
      const record = event && typeof event === 'object' ? event as { error?: unknown; cause?: unknown } : undefined;
      const error = record?.error ?? record?.cause;
      const name = error && typeof error === 'object' ? (error as { name?: unknown }).name : undefined;
      const errorClass = typeof name === 'string' && ['Error', 'TypeError', 'RangeError', 'AbortError', 'TimeoutError'].includes(name)
        ? name : error ? 'other' : null;
      console.info(`[native-flue] harness-runtime=${JSON.stringify({ shard: index, harnessEpoch: `${index}:${currentEpoch}`, stage,
        at: Date.now(), errorClass })}`);
    } catch { /* A diagnostic cannot change runtime ownership or the original error. */ }
  };
  async function disposeWorker() {
    if (!worker) return;
    runtimeEvent('dispose-start', epoch);
    await worker.dispose();
    runtimeEvent('dispose-completed', epoch);
  }
  async function startWorker() {
    const currentEpoch = ++epoch;
    runtimeEvent('start', currentEpoch);
    // Pinned unstable_dev ignores experimental.watch; this API honors dev.watch.
    worker = await unstable_startWorker({
      entrypoint: fileURLToPath(new URL('./loader-worker.ts', import.meta.url)),
      config: fileURLToPath(new URL('./wrangler.toml', import.meta.url)),
      dev: {
        remote: false, server: { hostname: '127.0.0.1', port: 0 }, inspector: { port: 0 },
        persist: false, logLevel: 'error', watch: false,
      },
    });
    // Public Worker.raw DevEnv EventEmitter; no controller import or override.
    if (tracing) {
      try {
        worker.raw.on('reloadComplete', () => runtimeEvent('reload-completed', currentEpoch));
        worker.raw.on('runtimeError', (event: unknown) => runtimeEvent('runtime-error', currentEpoch, event));
      } catch { runtimeEvent('public-hooks-unavailable', currentEpoch); }
    }
    await worker.ready;
    runtimeEvent('ready', currentEpoch);
  }
  afterAll(async () => { await disposeWorker(); });

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
      const headers = new Headers(init?.headers);
      const observationId = headers.get('x-codeflare-fixture-observation-id');
      let requestInit = init;
      if (tracing && observationId) {
        headers.set('x-codeflare-fixture-runtime-epoch', `${index}:${epoch}`);
        requestInit = { ...init, headers };
        try { console.info(`[native-flue] harness-observe=${JSON.stringify({ observationId,
          harnessEpoch: `${index}:${epoch}`, at: Date.now() })}`); } catch { /* Diagnostic only. */ }
      }
      return (await worker!.fetch(new URL(path, 'http://placeholder'),
        requestInit as unknown as Parameters<FixtureWorker['fetch']>[1])) as unknown as Response;
    },
    // No redundant beforeAll boot: the first owned case starts its fresh worker here.
    reset: async () => { await disposeWorker(); await startWorker(); },
    queuedActivity,
    activity,
  }, 'flue', { index, total: 3 });
}
