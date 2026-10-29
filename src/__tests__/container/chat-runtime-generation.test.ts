/// <reference types="@cloudflare/vitest-plugin/types" />
import { describe, expect, it, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import type { Env } from '../../types';
import { createMockKV } from '../helpers/mock-kv';
import { createMockSessionD1 } from '../helpers/mock-session-d1';
import { buildEnvVars } from '../../container/container-env';

// Observe the first-party startup environment at the existing SDK boundary,
// without starting compute or testing SDK behavior.
vi.mock('@cloudflare/containers', () => ({
  Container: class {
    envVars: Record<string, string> = {};
    startedEnvironments: Record<string, string>[] = [];
    constructor(public ctx: DurableObjectState, public env: Env) {}
    async startAndWaitForPorts() { this.startedEnvironments.push({ ...this.envVars }); }
  },
  getContainer: () => { throw Error('No allocation permitted by this fixture'); },
}));
import { container as Container } from '../../container/index';

describe('REQ-AGENT-224: immutable Host generation originates in owner-scoped D1 before process start', () => {
  const bucket = 'chat-owner';
  const sid = 'abcdef0123456789';
  type Fixture = {
    instance: Container;
    kv: ReturnType<typeof createMockKV>;
    workerEnv: Env;
    started: () => Record<string, string>[];
  };
  async function fixture(test: (f: Fixture) => Promise<void>) {
    const ns = (env as unknown as { OPERATOR_ACTIVITY: DurableObjectNamespace }).OPERATOR_ACTIVITY;
    await runInDurableObject(ns.get(ns.newUniqueId()), async (_instance, native) => {
      // A cached/previous DO generation must not become startup authority.
      await native.storage.put({ bucketName: bucket, _sessionId: sid, lifecycleGeneration: 900,
        containerAuthToken: 'private-bearer' });
      Object.defineProperty(native, 'container', { configurable: true, value: { running: false } });
      const kv = createMockKV();
      kv._set(`session:${bucket}:${sid}`, { id: sid, userId: bucket, name: 'Pi', agentType: 'pi',
        status: 'starting', lifecycleGeneration: 7, workspace: 'terminal', terminalMode: 'classic' });
      const workerEnv = { KV: kv, USAGE_DB: createMockSessionD1(kv),
        R2_ACCOUNT_ID: 'fixture-account', R2_ENDPOINT: 'https://r2.example.test' } as unknown as Env;
      const initialization: Promise<unknown>[] = [];
      const block = native.blockConcurrencyWhile.bind(native);
      Object.defineProperty(native, 'blockConcurrencyWhile', { configurable: true, value: <T>(callback: () => Promise<T>) => {
        const promise = block(callback); initialization.push(promise); return promise;
      } });
      const instance = new Container(native as never, workerEnv);
      await Promise.all(initialization);
      const started = () => (instance as unknown as { startedEnvironments: Record<string, string>[] }).startedEnvironments;
      await test({ instance, kv, workerEnv, started });
    });
  }

  it('passes the claimed D1 generation to the process environment, not a cached value or preference', () => fixture(async f => {
    f.kv._set(`preferences:${bucket}`, { chatGeneration: 800, sessionMode: 'default' });
    f.instance.envVars.CODEFLARE_CHAT_GENERATION = '900';
    await f.instance.startAndWaitForPorts();
    expect(f.started().at(-1)).toMatchObject({ CODEFLARE_CHAT_GENERATION: '7', SESSION_ID: sid,
      CONTAINER_AUTH_TOKEN: 'private-bearer' });
  }));

  it('uses the replacement D1 generation at the next start without persisting browser authority', () => fixture(async f => {
    await f.instance.startAndWaitForPorts();
    f.kv._set(`session:${bucket}:${sid}`, { id: sid, userId: bucket, name: 'Pi', agentType: 'pi',
      status: 'starting', lifecycleGeneration: 8, workspace: 'vscode', terminalMode: 'herdr' });
    await f.instance.startAndWaitForPorts();
    expect(f.started().map(vars => vars.CODEFLARE_CHAT_GENERATION)).toEqual(['7', '8']);
  }));

  it('does not emit generation without explicit trusted runtime context', () => fixture(async f => {
    // Ordinary preference/config rebuilding is not an authority source.
    const vars = buildEnvVars(f.instance, f.workerEnv);
    expect(vars.CODEFLARE_CHAT_GENERATION).toBeUndefined();
  }));

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid trusted runtime generation %s', generation => fixture(async f => {
    expect(() => buildEnvVars(f.instance, f.workerEnv, { lifecycleGeneration: generation })).toThrow();
  }));

  it.each(['stopped', 'stopping'])('does not authorize Chat from a %s D1 generation', status => fixture(async f => {
    f.kv._set(`session:${bucket}:${sid}`, { id: sid, userId: bucket, name: 'Pi', agentType: 'pi',
      status, lifecycleGeneration: 7, workspace: 'terminal', terminalMode: 'classic' });
    await f.instance.startAndWaitForPorts();
    expect(f.started().at(-1)?.CODEFLARE_CHAT_GENERATION).toBeUndefined();
  }));

  it('does not fall back to a previous generation when the current owner row is absent', () => fixture(async f => {
    await f.kv.delete(`session:${bucket}:${sid}`);
    await f.instance.startAndWaitForPorts();
    expect(f.started().at(-1)?.CODEFLARE_CHAT_GENERATION).toBeUndefined();
  }));
});
