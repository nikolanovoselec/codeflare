/// <reference types="@cloudflare/vitest-plugin/types" />
import { describe, expect, it, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import type { Env } from '../../types';
import { createMockKV } from '../helpers/mock-kv';

// Exercise Codeflare's new native Chat upgrade dispatch. The SDK auto-start
// transport is deliberately unavailable; its internals are not under test.
vi.mock('@cloudflare/containers', () => ({
  Container: class {
    constructor(public ctx: DurableObjectState, public env: Env) {}
    fetch() { throw Error('Auto-waking SDK transport is forbidden'); }
  },
  getContainer: () => { throw Error('No allocation permitted by this fixture'); },
}));
import { container as Container } from '../../container/index';

describe('REQ-AGENT-224: native Chat upgrades use the existing authenticated port', () => {
  it.each([true, false])('preserves a real upgrade with SDK running=%s, without SDK start/fetch', async running => {
    const ns = (env as unknown as { OPERATOR_ACTIVITY: DurableObjectNamespace }).OPERATOR_ACTIVITY;
    await runInDurableObject(ns.get(ns.newUniqueId()), async (_instance, native) => {
      await native.storage.put('containerAuthToken', 'private-container-bearer');
      let observed: Request | undefined;
      Object.defineProperty(native, 'container', { configurable: true, value: {
        running,
        start: () => { throw Error('Container start is forbidden'); },
        getTcpPort: () => ({ fetch: async (request: Request) => {
          observed = request.clone();
          const pair = new WebSocketPair();
          pair[1].accept();
          pair[1].close(1000, 'fixture');
          return new Response(null, { status: 101, webSocket: pair[0] });
        } }),
      } });
      const initialization: Promise<unknown>[] = [];
      const block = native.blockConcurrencyWhile.bind(native);
      Object.defineProperty(native, 'blockConcurrencyWhile', { configurable: true, value: <T>(callback: () => Promise<T>) => {
        const promise = block(callback); initialization.push(promise); return promise;
      } });
      const instance = new Container(native as never, { KV: createMockKV(),
        R2_ACCOUNT_ID: 'fixture-account', R2_ENDPOINT: 'https://r2.example.test' } as unknown as Env);
      await Promise.all(initialization);
      const response = await instance.fetch(new Request('https://codeflare.ch/api/chat/abcdef0123456789/ws?generation=7', {
        headers: { Upgrade: 'websocket', Authorization: 'Bearer browser-forged', 'X-Codeflare-Chat-Generation': '7' },
      }));
      expect(response.status).toBe(101);
      expect(response.webSocket).toBeTruthy();
      expect(observed!.url).toBe('http://container/api/chat/abcdef0123456789/ws?generation=7');
      expect(observed!.headers.get('Authorization')).toBe('Bearer private-container-bearer');
      expect(observed!.headers.get('X-Codeflare-Chat-Generation')).toBe('7');
      expect(observed!.headers.get('Upgrade')).toBe('websocket');
    });
  });
});
