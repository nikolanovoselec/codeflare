/**
 * Deterministic Phase-1 platform caller fixtures. They compose public contracts
 * once, expose incomplete outcomes and never implement retries, schedules,
 * Review policy, publishing or provider calls.
 */
import { parseOperatorConsumerInvocation } from '../../../operators/consumer-contracts';

export async function runDirectFixture(input: unknown, runtime: { execute(input: ReturnType<typeof parseOperatorConsumerInvocation>):
  Promise<{ status: 'completed' | 'failed' | 'unknown'; result: unknown }> }) {
  const outcome = await runtime.execute(parseOperatorConsumerInvocation(input));
  return { execution: outcome.status, cleanup: 'not-required' as const,
    persistence: 'not-required' as const, result: outcome.result };
}

interface SessionFixtureRuntime {
  ensure(input: ReturnType<typeof parseOperatorConsumerInvocation>): Promise<{ sessionId: string }>;
  send(input: { sessionId: string; runId: string; input: unknown }): Promise<{ taskId: string }>;
  observe(input: { sessionId: string; taskId: string }): Promise<{ status: 'completed' | 'failed' | 'unknown'; result: unknown }>;
  sync(input: { sessionId: string; runId: string }): Promise<{ status: 'verified' | 'failed' | 'unknown' }>;
  stop(input: { sessionId: string }): Promise<{ status: 'stopped' | 'unknown' }>;
}
export async function runSessionFixture(input: unknown, runtime: SessionFixtureRuntime) {
  const invocation = parseOperatorConsumerInvocation(input);
  let sessionId: string | null = null;
  let execution: 'completed' | 'failed' | 'unknown' = 'unknown';
  let persistence: 'verified' | 'failed' | 'unknown' = 'unknown';
  let cleanup: 'stopped' | 'unknown' = 'unknown';
  let result: unknown = null;
  try {
    sessionId = (await runtime.ensure(invocation)).sessionId;
    const task = await runtime.send({ sessionId, runId: invocation.runId, input: invocation.input });
    const observed = await runtime.observe({ sessionId, taskId: task.taskId });
    execution = observed.status;
    result = observed.result;
    if (observed.status === 'completed') persistence = (await runtime.sync({ sessionId, runId: invocation.runId })).status;
  } catch { execution = 'unknown'; }
  finally {
    if (sessionId) {
      try { cleanup = (await runtime.stop({ sessionId })).status; } catch { cleanup = 'unknown'; }
    }
  }
  return { execution, persistence, cleanup, result, sessionId };
}

function webhookRequest(base: string, activityId: string, action: string, method: 'GET' | 'POST', token: string): Request {
  return new Request(`${base}/operator-webhook/v1/activities/${encodeURIComponent(activityId)}/${action}`, {
    method, headers: { authorization: `Bearer ${token}` },
  });
}
export async function runWebhookCallerFixture(base: string, activityId: string, startCapability: string,
  fetcher: (request: Request) => Promise<Response>) {
  const started = await fetcher(webhookRequest(base, activityId, 'start', 'POST', startCapability));
  if (!started.ok) return { status: 'start-rejected', result: 'unavailable' };
  const startBody = await started.json() as { readCapability?: unknown };
  if (typeof startBody.readCapability !== 'string') return { status: 'start-unknown', result: 'unavailable' };
  const statusResponse = await fetcher(webhookRequest(base, activityId, 'status', 'GET', startBody.readCapability));
  if (!statusResponse.ok) return { status: 'status-unknown', result: 'unavailable' };
  const status = await statusResponse.json() as { status?: unknown };
  const resultResponse = await fetcher(webhookRequest(base, activityId, 'result', 'POST', startBody.readCapability));
  return { status: typeof status.status === 'string' ? status.status : 'unknown',
    result: resultResponse.status === 202 ? 'not-ready' : resultResponse.ok ? 'collected' : 'unavailable' };
}
