import { fileURLToPath, URL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unstable_dev, type Unstable_DevWorker } from 'wrangler';

// Real pinned Wrangler/workerd, executed only in the Node CI suite. No deploy,
// provider requests, secrets, production config or production fixture exports.
let worker: Unstable_DevWorker | undefined;
beforeAll(async () => {
  worker = await unstable_dev(fileURLToPath(new URL('./fixtures/loader-worker.ts', import.meta.url)), {
    config: fileURLToPath(new URL('./fixtures/wrangler.toml', import.meta.url)),
    local: true, ip: '127.0.0.1', port: 0, inspectorPort: 0, persist: false, logLevel: 'none',
    experimental: { disableExperimentalWarning: true, disableDevRegistry: true, watch: false },
  });
}, 60_000);
afterAll(async () => { await worker?.stop(); });

describe('REQ-OPERATOR-003: Worker Loader runtime boundary', () => {
  it('loads fresh Workers rather than retaining isolate-local state', async () => {
    const response = await worker!.fetch('/fresh');
    expect(await response.json()).toEqual([{ counter: 1 }, { counter: 1 }]);
  });

  it('binds identity at the parent RPC capability and exposes no parent environment', async () => {
    const response = await worker!.fetch('/identity');
    expect(await response.json()).toEqual({ principal: 'fixture-owner', bindings: ['OPERATOR'] });
  });

  it('routes direct inference-shaped HTTP through the bound parent interceptor', async () => {
    const response = await worker!.fetch('/allowed');
    expect(await response.json()).toEqual({ principal: 'fixture-owner', intercepted: true });
  });

  it('returns the parent denial for unapproved direct egress', async () => {
    const response = await worker!.fetch('/denied');
    expect(response.status).toBe(403);
    expect(await response.text()).toBe('denied');
  });
});
