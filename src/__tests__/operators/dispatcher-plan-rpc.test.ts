/** CI-only method/context reproducer; not cron/business or live-fix acceptance. */
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { unstable_startWorker } from 'wrangler';
import { bounded, projectError, type AlarmResult, type PlanResult } from './fixtures/dispatcher-plan-rpc-result';

const cases = ['fresh-worker', 'fresh-parent-alarm', 'worker-initialized-parent-alarm'] as const;
type Record = {
  case: typeof cases[number];
  outcome: string;
  alarmEntered: boolean;
  initialization: PlanResult | null;
  error: ReturnType<typeof projectError> | null;
};

it('fresh exported getRuntimePlan returns null from Worker and scheduled parent alarm events', async () => {
  // Reuse flue-harness.ts's existing native Wrangler API/configuration, without
  // its composed workload, fixtures, reset logic, SDK controls or generated child.
  let worker: Awaited<ReturnType<typeof unstable_startWorker>> | undefined;
  const records: Record[] = cases.map(name => ({
    case: name, outcome: 'not-run', alarmEntered: false, initialization: null, error: null,
  }));
  const end = performance.now() + 75_000;
  const remaining = (maximum: number) => Math.max(1, Math.min(maximum, end - performance.now()));
  let cleanup = 'not-started';
  let stage: Record = records[0]!;
  let stop = false;
  try {
    worker = await bounded(unstable_startWorker({
      entrypoint: fileURLToPath(new URL('./fixtures/dispatcher-plan-rpc-worker.ts', import.meta.url)),
      config: fileURLToPath(new URL('./fixtures/wrangler.plan-rpc.toml', import.meta.url)),
      dev: { remote: false, server: { hostname: '127.0.0.1', port: 0 }, inspector: { port: 0 },
        persist: false, logLevel: 'none', watch: false },
    }), 10_000);
    await bounded(worker.ready, 15_000);

    async function command(path: string, method: 'GET' | 'POST'): Promise<unknown> {
      const milliseconds = Math.floor(remaining(12_000));
      const response = await bounded(worker!.fetch(new URL(path, 'http://placeholder'), {
        method, signal: AbortSignal.timeout(milliseconds),
      }), milliseconds);
      // A broken native transport retires the probe: no debug/retry/replacement.
      if (response.status >= 500) { stop = true; throw new Error('HTTP 500'); }
      if (response.status !== 200) throw new Error('Fixture HTTP refusal');
      return bounded(response.json(), remaining(2000));
    }

    for (const [index, path] of ['/worker', '/alarm-fresh', '/alarm-warm'].entries()) {
      if (stop) break;
      stage = records[index]!;
      try {
        const started = await command(path, 'POST') as AlarmResult | { parent: string };
        let observation: AlarmResult;
        if ('parent' in started) {
          // Bounded observation only; never manually deliver or retry an alarm.
          const observationEnd = Math.min(end, performance.now() + 10_000);
          let result: AlarmResult | null = null;
          while (performance.now() < observationEnd) {
            result = await command(`/result?parent=${encodeURIComponent(started.parent)}`, 'GET') as AlarmResult | null;
            if (result) break;
            await new Promise(resolve => setTimeout(resolve, 50));
          }
          if (!result) throw new Error('Native alarm observation deadline');
          observation = result;
        } else { observation = started; }
        stage.outcome = observation.result.outcome;
        stage.alarmEntered = observation.alarmEntered;
        stage.initialization = observation.initialization;
        stage.error = observation.result.error;
        if (stage.error?.kind === 'retired-transport') stop = true;
      } catch (error) {
        stage.outcome = 'harness-rejected';
        stage.error = projectError(error);
        // Any transport exception stops further cases; do not retry the workload.
        stop = true;
      }
    }
  } catch (error) {
    stage.outcome = 'startup-rejected';
    stage.error = projectError(error);
  } finally {
    try {
      if (worker) { await bounded(worker.dispose(), 5000); cleanup = 'disposed'; }
    } catch (error) {
      cleanup = 'dispose-rejected';
      console.info('plan-rpc-cleanup', JSON.stringify({ kind: cleanup, error: projectError(error) }));
    }
  }

  // Always emit all cases BEFORE business assertions. No raw exceptions, plans,
  // names, headers, provider data, identities or private user data are printed.
  for (const record of records) console.info('plan-rpc-probe', JSON.stringify({
    schema: 'dispatcher-plan-rpc-ci.v1', ...record,
  }));
  expect(records.map(record => record.outcome)).toEqual(['returned-null', 'returned-null', 'returned-null']);
  expect(records.map(record => record.alarmEntered)).toEqual([false, true, true]);
  expect(records[2]!.initialization?.outcome).toBe('returned-null');
  expect(cleanup).toBe('disposed');
}, 90_000);
