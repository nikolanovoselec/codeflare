import { describe, expect, it, vi } from 'vitest';
import { setLogLevel } from '../../lib/logger';
import * as activity from '../../operators/activity';

type Tail = { tail(events: unknown): Promise<void> };
const TailClass = (activity as unknown as { OperatorDispatcherTail: new (ctx: ExecutionContext, env: unknown) => Tail })
  .OperatorDispatcherTail;
const props = { activityId: 'trusted-activity', generation: 3 };
const diagnostic = (stage: string, status?: number) => ({ level: 'warn', message: [
  'Dispatcher inference boundary', status === undefined ? { stage } : { stage, status },
] });

async function capture(events: unknown, binding: unknown = props) {
  setLogLevel('warn');
  const output: string[] = [];
  const spy = vi.spyOn(console, 'warn').mockImplementation(value => { output.push(String(value)); });
  try {
    const tail = new TailClass({ props: binding } as unknown as ExecutionContext, {});
    await tail.tail(events);
  } finally {
    spy.mockRestore();
    setLogLevel('silent');
  }
  return output.map(value => JSON.parse(value) as { module: string; message: string; data: Record<string, unknown> });
}

describe('REQ-OPERATOR-048: filtered child diagnostic', () => {
  it('forwards only fixed warning codes with trusted Activity correlation', async () => {
    const output = await capture([{ logs: [diagnostic('fetch-rejected'), diagnostic('http-rejected', 422),
      diagnostic('http-rejected', 307)] }]);
    expect(output.map(value => value.data)).toEqual([
      { activityId: 'trusted-activity', generation: 3, stage: 'fetch-rejected' },
      { activityId: 'trusted-activity', generation: 3, stage: 'http-rejected', status: 422 },
      { activityId: 'trusted-activity', generation: 3, stage: 'http-rejected', status: 307 },
    ]);
    expect(output.every(value => value.module === 'dispatcher-inference-tail'
      && value.message === 'Dispatcher child inference diagnostic')).toBe(true);
  });

  it('drops arbitrary child logs, exceptions, extra fields and sensitive body text', async () => {
    const secret = 'PRIVATE_PROVIDER_BODY_SENTINEL';
    const output = await capture([{ logs: [
      { level: 'error', message: [secret] },
      { level: 'warn', message: [secret] },
      { ...diagnostic('fetch-rejected'), message: ['Dispatcher inference boundary', { stage: 'fetch-rejected', reason: secret }] },
      diagnostic('model-failed'), diagnostic('http-rejected', 200),
      diagnostic('http-rejected', 299), diagnostic('http-rejected', 600),
      { level: 'warn', message: ['Dispatcher inference boundary', { stage: 'http-rejected', status: '422' }] },
      { level: 'warn', message: ['Dispatcher inference boundary', { stage: 'fetch-rejected', activityId: 'forged' }] },
      { level: 'warn', message: ['Dispatcher inference boundary', { stage: 'fetch-rejected', extra: secret.repeat(1000) }] },
      { level: 'warn', message: ['Dispatcher inference boundary', { stage: 'fetch-rejected' }, secret] },
    ], exceptions: [{ message: secret }] }]);
    expect(output).toEqual([]);
    expect(JSON.stringify(output)).not.toContain(secret);
  });

  it('bounds work and forwarding even when a child floods valid-looking events', async () => {
    const logs = Array.from({ length: 200 }, () => diagnostic('fetch-rejected'));
    const output = await capture([{ logs }]);
    expect(output.length).toBeGreaterThan(0);
    expect(output.length).toBeLessThanOrEqual(8);
  });

  it('does not let observability failure change child execution', async () => {
    setLogLevel('warn');
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => { throw new Error('telemetry unavailable'); });
    try {
      const tail = new TailClass({ props } as unknown as ExecutionContext, {});
      await expect(tail.tail([{ logs: [diagnostic('fetch-rejected')] }])).resolves.toBeUndefined();
    } finally { spy.mockRestore(); setLogLevel('silent'); }
  });

  it('refuses malformed trusted bindings and malformed event envelopes', async () => {
    expect(await capture([{ logs: [diagnostic('fetch-rejected')] }],
      { activityId: '../other', generation: 1 })).toEqual([]);
    expect(await capture([{ logs: [diagnostic('fetch-rejected')] }],
      { activityId: 'trusted-activity', generation: 0 })).toEqual([]);
    expect(await capture([{ logs: 'PRIVATE_PROVIDER_BODY_SENTINEL' }])).toEqual([]);
  });
});
