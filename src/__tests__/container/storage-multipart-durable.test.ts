/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, expect, it, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import type { Env } from '../../types';
import type { BucketMultipartOperation } from '../../routes/storage/upload';
import { createMockKV } from '../helpers/mock-kv';

// Same native-context / external SDK seam as operator-logging-forwarding.test.ts
// and mcp-portal-fixture.ts. No container, session or Operator workload is started.
vi.mock('@cloudflare/containers', () => ({
  Container: class {
    constructor(public ctx: DurableObjectState, public env: Env) {}
  },
  getContainer: () => { throw new Error('Container allocation forbidden in storage fixture'); },
}));
vi.mock('../../lib/r2-client', async importOriginal => ({
  ...await importOriginal<typeof import('../../lib/r2-client')>(),
  createR2Client: vi.fn(),
}));
import { createR2Client } from '../../lib/r2-client';
import { container as Container } from '../../container/index';

afterEach(() => { vi.restoreAllMocks(); });

it('REQ-STOR-008 AC1/AC2: native storage retains multipart binding across coordinator reconstruction and rejects a mismatched owner before part mutation', async () => {
  const bucketName = 'multipart-owner';
  const key = 'Uploads/bound.bin';
  const uploadId = 'native-upload-1';
  const receiptKey = `multipart:upload:${uploadId}`;
  const receipt = { key, generation: 5, regime: 'plain' };
  const kv = createMockKV();
  for (const bucket of [bucketName, 'other-owner']) {
    kv._set(`r2-regime:${bucket}`, { status: 'ready', regime: 'plain', generation: 5 });
  }
  const ownerEnv = { KV: kv, R2_ACCOUNT_ID: 'fixture-account', R2_ENDPOINT: 'https://r2.example.test' } as unknown as Env;
  let partBytes = new Uint8Array();
  // Controlled provider boundary, not the persistence under test. Binary bodies
  // are retained so a refused request cannot silently overwrite the earlier part.
  vi.mocked(createR2Client).mockReturnValue({ fetch: async (input: string, init: RequestInit) => {
    const url = new URL(input);
    expect(url.origin).toBe('https://r2.example.test');
    expect(url.pathname).toBe(`/${bucketName}/${key}`);
    if (init.method === 'POST' && url.search === '?uploads') {
      return new Response(`<InitiateMultipartUploadResult><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`);
    }
    expect(init.method).toBe('PUT');
    expect(url.searchParams.get('uploadId')).toBe(uploadId);
    expect(url.searchParams.get('partNumber')).toBe('1');
    partBytes = new Uint8Array(await new Response(init.body).arrayBuffer());
    return new Response('', { headers: { etag: '"part-etag"' } });
  } } as unknown as ReturnType<typeof createR2Client>);

  const ns = (env as unknown as { OPERATOR_ACTIVITY: DurableObjectNamespace }).OPERATOR_ACTIVITY;
  const stub = ns.get(ns.newUniqueId());
  async function reconstruct(native: DurableObjectState) {
    const initialization: Promise<unknown>[] = [];
    const block = native.blockConcurrencyWhile.bind(native);
    Object.defineProperty(native, 'blockConcurrencyWhile', { configurable: true, value: <T>(work: () => Promise<T>) => {
      const pending = block(work); initialization.push(pending); return pending;
    } });
    try {
      const coordinator = new Container(native as never, ownerEnv);
      await Promise.all(initialization);
      return coordinator;
    } finally {
      Object.defineProperty(native, 'blockConcurrencyWhile', { configurable: true, value: block });
    }
  }
  const request = (operation: BucketMultipartOperation) => new Request('http://container/bucket-multipart', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(operation),
  });
  const original = new Uint8Array([0, 255, 128, 13, 10, 65]);
  const replacement = new Uint8Array([66, 0, 254, 127]);
  const part = (bytes: Uint8Array, owner = bucketName) => request({
    action: 'part', bucketName: owner, key, uploadId, partNumber: 1,
    content: btoa(String.fromCharCode(...bytes)),
  });

  await runInDurableObject(stub, async (_platformInstance, native) => {
    const coordinator = await reconstruct(native);
    const initiated = await coordinator.runBucketMultipart(request({ action: 'initiate', bucketName, key }));
    expect(initiated.status).toBe(200);
    expect(await initiated.json()).toEqual({ uploadId, key });
    const uploaded = await coordinator.runBucketMultipart(part(original));
    expect(uploaded.status).toBe(200);
    expect(await uploaded.json()).toEqual({ etag: 'part-etag' });
    expect(partBytes).toEqual(original);
    // Persisted ownership and receipt are the intentional storage contract.
    expect(await native.storage.get('storage:owner')).toBe(bucketName);
    expect(await native.storage.get(receiptKey)).toEqual(receipt);
  });

  // A separate native invocation constructs a new production coordinator. No
  // old coordinator, copied values or Map-backed storage supplies its state.
  await runInDurableObject(stub, async (_platformInstance, native) => {
    const coordinator = await reconstruct(native);
    expect(await native.storage.get('storage:owner')).toBe(bucketName);
    expect(await native.storage.get(receiptKey)).toEqual(receipt);
    await expect(coordinator.runBucketMultipart(part(replacement, 'other-owner')))
      .rejects.toThrow('Bucket storage owner mismatch');
    expect(partBytes).toEqual(original);
    expect(await native.storage.get('storage:owner')).toBe(bucketName);
    expect(await native.storage.get(receiptKey)).toEqual(receipt);

    // Positive control: retained receipt admits a real part write after the
    // refusal, rather than a fixture that simply rejects every reconstructed call.
    const uploaded = await coordinator.runBucketMultipart(part(replacement));
    expect(uploaded.status).toBe(200);
    expect(await uploaded.json()).toEqual({ etag: 'part-etag' });
    expect(partBytes).toEqual(replacement);
    expect(await native.storage.get('storage:owner')).toBe(bucketName);
    expect(await native.storage.get(receiptKey)).toEqual(receipt);
  });
});
