/** CI-only fresh read probe. Root exports/SDK remain real; no admission or workload. */
import { DurableObject } from 'cloudflare:workers';
import rootWorker from '../../../index';
export * from '../../../index';
import type { OperatorActivity } from '../../../index';
import { bounded, rejected, returned, type AlarmResult, type PlanResult } from './dispatcher-plan-rpc-result';

interface ProbeEnv {
  OPERATOR_ACTIVITY: DurableObjectNamespace<OperatorActivity>;
  PLAN_RPC_PARENT: DurableObjectNamespace<PlanRpcAlarmParent>;
}
const activityName = /^scan-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const parentName = /^caller-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

/** Only the platform alarm scheduler calls alarm(); no helper manually invokes it. */
export class PlanRpcAlarmParent extends DurableObject<ProbeEnv> {
  async arm(child: string, initialization: PlanResult | null): Promise<void> {
    if (!activityName.test(child)) throw new Error('Invalid fixture child');
    await this.ctx.storage.put('request', { child, initialization });
    await this.ctx.storage.setAlarm(Date.now() + 1);
  }

  async alarm(): Promise<void> {
    const request = await this.ctx.storage.get<{ child: string; initialization: PlanResult | null }>('request');
    if (!request) return;
    let result: PlanResult;
    try {
      // The namespace AND stub come from this parent's own environment in the
      // native alarm event, not cloudflare:test's global env or a receiver helper.
      const plan = await bounded(this.env.OPERATOR_ACTIVITY.getByName(request.child).getRuntimePlan(), 8000);
      result = returned(plan);
    } catch (error) { result = rejected(error); }
    await this.ctx.storage.put<AlarmResult>('result', {
      alarmEntered: true, initialization: request.initialization, result,
    });
    // Catching the business RPC failure above prevents automatic alarm retries.
  }

  async snapshot(): Promise<AlarmResult | null> {
    return await this.ctx.storage.get<AlarmResult>('result') ?? null;
  }
}

export default {
  ...rootWorker,
  async fetch(request: Request, env: ProbeEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/result' && request.method === 'GET') {
      const parent = url.searchParams.get('parent') ?? '';
      if (!parentName.test(parent)) return new Response(null, { status: 400 });
      return Response.json(await env.PLAN_RPC_PARENT.getByName(parent).snapshot());
    }
    if (request.method !== 'POST' || !['/worker', '/alarm-fresh', '/alarm-warm'].includes(url.pathname)) {
      return new Response(null, { status: 404 });
    }
    const child = `scan-${crypto.randomUUID()}`;
    let initialization: PlanResult | null = null;
    if (url.pathname !== '/alarm-fresh') {
      try {
        // First-ever call from a real Worker event to the real root export.
        const plan = await bounded(env.OPERATOR_ACTIVITY.getByName(child).getRuntimePlan(), 8000);
        initialization = returned(plan);
      } catch (error) { initialization = rejected(error); }
      if (url.pathname === '/worker' || initialization.error?.kind === 'retired-transport') {
        return Response.json({ alarmEntered: false, initialization: null, result: initialization });
      }
    }
    const parent = `caller-${crypto.randomUUID()}`;
    await env.PLAN_RPC_PARENT.getByName(parent).arm(child, initialization);
    return Response.json({ parent });
  },
};
