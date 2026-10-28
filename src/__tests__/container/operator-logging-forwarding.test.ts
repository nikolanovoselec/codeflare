/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, describe, expect, it, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import type { Env } from '../../types';
import { createMockKV } from '../helpers/mock-kv';
import { forwardExisting } from '../../lib/container-helpers';

// Reuse the existing container test's external Containers SDK seam, but keep a
// genuine native DurableObjectState/SQLite owner. This fixture never starts a
// container, SDK application, session or Flue workload.
vi.mock('@cloudflare/containers', () => ({
  Container: class {
    constructor(public ctx: DurableObjectState, public env: Env) {}
    fetch(request: Request) { return this.ctx.container!.getTcpPort(8080).fetch(request); }
  },
  getContainer: () => { throw new Error('No container allocation permitted by this fixture'); },
}));
import { container as Container } from '../../container/index';

afterEach(() => { vi.restoreAllMocks(); });
// Intentional private transport contract: this header is reserved, stripped on
// ordinary HTTP input, and encoded as on/off only from the separate trusted RPC argument.
const reserved = 'x-codeflare-operator-logging';
const binding = { activityId: 'trusted-activity', generation: 7, loggingEnabled: true };
const token = 'synthetic-existing-container-token';
async function fixture(test: (f: { instance: Container; native: DurableObjectState; started: () => boolean }) => Promise<void>) {
  const ns = (env as unknown as { OPERATOR_ACTIVITY: DurableObjectNamespace }).OPERATOR_ACTIVITY;
  await runInDurableObject(ns.get(ns.newUniqueId()), async (_instance, native) => {
    await native.storage.put({ containerAuthToken: token, lifecycleGeneration: 11 });
    let started = false;
    Object.defineProperty(native, 'container', { configurable: true, value: {
      running: true,
      start: () => { started = true; throw new Error('Replacement container forbidden'); },
      getTcpPort: () => ({ fetch: async (request: Request) => Response.json({
        path: new URL(request.url).pathname, method: request.method, authorization: request.headers.get('authorization'),
        loggingContext: request.headers.get(reserved), body: request.body ? await request.text() : null,
      }) }),
    } });
    const initialization: Promise<unknown>[] = [];
    const block = native.blockConcurrencyWhile.bind(native);
    Object.defineProperty(native, 'blockConcurrencyWhile', { configurable: true, value: <T>(callback: () => Promise<T>) => {
      const promise = block(callback); initialization.push(promise); return promise;
    } });
    const instance = new Container(native as never, { KV: createMockKV(), R2_ACCOUNT_ID: 'fixture-account',
      R2_ENDPOINT: 'https://r2.example.test' } as unknown as Env);
    await Promise.all(initialization);
    await test({ instance, native, started: () => started });
  });
}
function request(path = '/operator-inference', method = 'POST', overrides: Record<string, string> = {}) {
  return new Request(`https://ordinary-ingress.example.test${path}`, { method,
    headers: { 'content-type': 'application/json', authorization: 'Bearer caller-forged',
      'x-codeflare-operator-activity': binding.activityId, 'x-codeflare-operator-generation': String(binding.generation),
      [reserved]: 'on', ...overrides },
    ...(method === 'GET' ? {} : { body: JSON.stringify({ loggingEnabled: true, payload: 'ORIGINAL_BODY_é🦊' }) }) });
}
async function forwarded(response: Response) {
  expect(response.status).toBe(200);
  return response.json() as Promise<{ path: string; method: string; authorization: string; loggingContext: string | null; body: string | null }>;
}

describe('trusted prelookup logging context on existing authenticated owner port', () => {
  it.each(['/operator-inference', '/operator-inference/profile'])(
    'REQ-OPERATOR-003/007/047: %s trusted RPC logging context crosses the helper and replaces forged headers without changing body', path => fixture(async f => {
      const source = request(path);
      const expectedBody = await source.clone().text();
      // Existing helper must carry the optional RPC argument, not synthesize it from HTTP.
      const response: Response = await Reflect.apply(forwardExisting, undefined, [f.instance, source, binding]);
      const wire = await forwarded(response);
      expect(wire).toMatchObject({ path, method: 'POST', authorization: `Bearer ${token}`, body: expectedBody });
      expect(wire.loggingContext).toBe('on');
      expect(await f.native.storage.get('lifecycleGeneration')).toBe(11);
      expect(f.started()).toBe(false);
    }));

  it.each(['fetch', 'forwardExisting'] as const)(
    'REQ-OPERATOR-003/047/079: ordinary %s header and body booleans cannot enable raw capture', entry => fixture(async f => {
      const source = request(); const expectedBody = await source.clone().text();
      const response = entry === 'fetch' ? await f.instance.fetch(source) : await f.instance.forwardExisting(source);
      expect(await forwarded(response)).toEqual({ path: '/operator-inference', method: 'POST', authorization: `Bearer ${token}`,
        loggingContext: null, body: expectedBody });
      expect(f.started()).toBe(false); expect(await f.native.storage.get('lifecycleGeneration')).toBe(11);
    }));

  it('REQ-OPERATOR-079: AC4 authenticated RPC carries explicit original OFF rather than trusting a forged ON header or body', () => fixture(async f => {
    const response: Response = await Reflect.apply(f.instance.forwardExisting, f.instance, [request(), { ...binding, loggingEnabled: false }]);
    const wire = await forwarded(response);
    expect(wire.loggingContext).toBe('off');
    expect(wire.authorization).toBe(`Bearer ${token}`);
    expect(wire.body).toBe(JSON.stringify({ loggingEnabled: true, payload: 'ORIGINAL_BODY_é🦊' }));
  }));

  it.each([
    { name: 'wrong Activity header', path: '/operator-inference', method: 'POST', headers: { 'x-codeflare-operator-activity': 'foreign-activity' }, context: binding },
    { name: 'wrong generation header', path: '/operator-inference/profile', method: 'POST', headers: { 'x-codeflare-operator-generation': '8' }, context: binding },
    { name: 'ambiguous generation header', path: '/operator-inference', method: 'POST', headers: { 'x-codeflare-operator-generation': '7, 7' }, context: binding },
    { name: 'ordinary path', path: '/health', method: 'POST', headers: {}, context: binding },
    { name: 'path suffix', path: '/operator-inference/profile/extra', method: 'POST', headers: {}, context: binding },
    { name: 'wrong method', path: '/operator-inference', method: 'GET', headers: {}, context: binding },
    { name: 'missing Activity', path: '/operator-inference', method: 'POST', headers: {}, context: { generation: 7, loggingEnabled: true } },
    { name: 'zero generation', path: '/operator-inference', method: 'POST', headers: {}, context: { ...binding, generation: 0 } },
    { name: 'nonboolean setting', path: '/operator-inference', method: 'POST', headers: {}, context: { ...binding, loggingEnabled: 'true' } },
    { name: 'extra authority', path: '/operator-inference', method: 'POST', headers: {}, context: { ...binding, owner: 'foreign-owner' } },
  ])('REQ-OPERATOR-003/047: $name cannot inject trusted logging context into the private port', ({ path, method, headers, context }) => fixture(async f => {
    const source = request(path, method, headers);
    const response: Response = await Reflect.apply(f.instance.forwardExisting, f.instance, [source, context]);
    const wire = await forwarded(response);
    expect(wire.loggingContext).toBeNull();
    expect(wire.authorization).toBe(`Bearer ${token}`);
    expect(f.started()).toBe(false); expect(await f.native.storage.get('lifecycleGeneration')).toBe(11);
  }));

  it('REQ-OPERATOR-003/047: missing existing private-port authentication cannot be replaced by a caller logging context', () => fixture(async f => {
    await f.native.storage.delete('containerAuthToken');
    const response: Response = await Reflect.apply(f.instance.forwardExisting, f.instance, [request(), binding]);
    expect(response.status).toBe(503); expect(await response.text()).toBe('Existing container unavailable');
    expect(f.started()).toBe(false); expect(await f.native.storage.get('lifecycleGeneration')).toBe(11);
  }));
});
