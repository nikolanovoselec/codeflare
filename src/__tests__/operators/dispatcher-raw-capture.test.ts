/// <reference types="@cloudflare/vitest-plugin/types" />
import { Buffer } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';
import { fixture, start, type DispatcherFixture } from './fixtures/dispatcher-production';
import { normalCallback } from './fixtures/normal-dispatcher';
import { createOwnerRawCaptureStorage, readRawCapture } from '../../operators/raw-capture-storage';

const options = { normalHosting: true, repositoryOnly: true };
const captureId = 'sdk-raw-capture-1';
const payload = () => ({ stage: 'turn_request', value: {
  password: 'SYNTHETIC_RAW_PASSWORD', apiKey: 'SYNTHETIC_RAW_TOKEN', placeholder: 'CF_TOKEN',
  headers: { authorization: 'Bearer SYNTHETIC_RAW_AUTH' },
  messages: [{ role: 'user', content: '漢🦊é'.repeat(45_000) }],
  errorInfo: { message: 'SYNTHETIC_THROW_SITE', stack: 'Error: SYNTHETIC_THROW_SITE\n at original.ts:9:2',
    cause: { message: 'SYNTHETIC_NESTED_CAUSE' } },
} });
const upload = (f: DispatcherFixture, value: unknown = payload(), headers: Record<string, string> = {}) =>
  normalCallback(f.activityId, 'diagnostic/raw', value, { 'x-codeflare-raw-capture': captureId, ...headers });
async function retained(f: DispatcherFixture, id = captureId) {
  let result!: Awaited<ReturnType<typeof readRawCapture>>;
  await f.mutateEvidence(async storage => {
    result = await readRawCapture({ binding: { ownerKey: f.proof.ownerKey, installationId: 'installation',
      releaseId: 'release', captureId: id, scope: { kind: 'activity', activityId: f.activityId, generation: 1 } },
    storage: await createOwnerRawCaptureStorage(f.environment, storage, async () => {}) });
  });
  return result;
}
function recovered(records: Array<{ stage: string; value: unknown }>): Uint8Array {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  for (const record of records) if (record.stage === 'installed-sdk-chunk') {
    const value = record.value as { offset: number; bytes: string };
    const bytes = Buffer.from(value.bytes, 'base64');
    expect(value.offset).toBe(offset);
    chunks.push(bytes); offset += bytes.byteLength;
  }
  return new Uint8Array(Buffer.concat(chunks));
}
async function persistedState(f: DispatcherFixture) {
  let state = new Map<string, unknown>();
  await f.mutateEvidence(async storage => { state = structuredClone(await storage.list()); });
  return state;
}

describe('REQ-OPERATOR-090/091: authenticated unredacted installed SDK retention', () => {
  it('independently reconstructs >256 KiB of complete private SDK data without redaction or new SDK execution', () => fixture(async f => {
    await start(f); await f.drainBackground();
    const original = await persistedState(f);
    const network = structuredClone(f.normalTransport!.networkRequests);
    const profiles = structuredClone(f.ownerPortRequests);
    const content = payload();
    const bytes = new TextEncoder().encode(JSON.stringify(content));
    expect(bytes.byteLength).toBeGreaterThan(256 * 1024);
    const output: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((line: unknown) => { output.push(String(line)); });
    try {
      const response = await f.installationCapability.fetch(upload(f, content));
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toMatchObject({ status: 'complete', captureId,
        counts: { records: expect.any(Number), segments: expect.any(Number), bytes: expect.any(Number) }, termination: 'eof' });
      const stored = await retained(f);
      expect(stored.status).toBe('complete');
      expect(recovered(stored.records)).toEqual(bytes);
      expect(JSON.parse(new TextDecoder().decode(recovered(stored.records)))).toEqual(content);
      expect(stored.records.find(record => record.stage === 'installed-sdk-eof')?.value).toMatchObject({ bytes: bytes.byteLength });
      const after = await persistedState(f);
      for (const [key, value] of original) expect(after.get(key)).toEqual(value);
      const artifacts = [...after].filter(([key]) => !original.has(key));
      expect(artifacts.length).toBeGreaterThan(1);
      expect(JSON.stringify(artifacts)).not.toMatch(/SYNTHETIC_RAW_PASSWORD|SYNTHETIC_RAW_TOKEN|SYNTHETIC_THROW_SITE/);
      expect(output.join('\n')).not.toMatch(/SYNTHETIC_RAW_PASSWORD|SYNTHETIC_RAW_TOKEN|SYNTHETIC_THROW_SITE/);
      expect(f.normalTransport!.networkRequests).toEqual(network);
      expect(f.ownerPortRequests).toEqual(profiles);
    } finally { log.mockRestore(); }
  }, options));

  it('OFF ignores caller logging overrides and never reads the optional raw body or writes capture data', () => fixture(async f => {
    await start(f); await f.drainBackground();
    f.setCurrentLogging(true);
    const before = await persistedState(f);
    const network = structuredClone(f.normalTransport!.networkRequests);
    let consumed = false;
    const body = new ReadableStream<Uint8Array>({ pull(controller) {
      consumed = true; controller.enqueue(new TextEncoder().encode(JSON.stringify({ loggingEnabled: true, ...payload() })));
      controller.close();
    } }, { highWaterMark: 0 });
    const response = await f.installationCapability.fetch(new Request(upload(f), { method: 'POST', body }));
    expect(response.status).toBe(204);
    expect(consumed).toBe(false);
    expect(await persistedState(f)).toEqual(before);
    expect(f.normalTransport!.networkRequests).toEqual(network);
  }, { ...options, loggingEnabled: false }));

  it.each(['running', 'completed', 'cancelled'] as const)('retains original ON %s observations without renewing or reopening execution', terminal => fixture(async f => {
    await start(f); await f.drainBackground();
    if (terminal === 'cancelled') await f.activity.cancelDrive();
    if (terminal === 'completed') {
      f.normalTransport!.settle('completed', [{ name: 'assessment', data: { repository: 'another/service', results: [] } }]);
      await f.activity.reconcileDispatcherLease();
      expect(await f.activity.collectBrowserResult()).toMatchObject({ ok: true, detail: { executionStatus: 'completed' } });
    }
    await f.drainBackground(); f.setCurrentLogging(false);
    const network = structuredClone(f.normalTransport!.networkRequests);
    const before = await persistedState(f);
    expect((await f.installationCapability.fetch(upload(f, { stage: 'submission_settled', value: { outcome: terminal } }))).status).toBe(200);
    const stored = await retained(f);
    expect(JSON.parse(new TextDecoder().decode(recovered(stored.records)))).toEqual({ stage: 'submission_settled', value: { outcome: terminal } });
    const after = await persistedState(f);
    for (const [key, value] of before) expect(after.get(key)).toEqual(value);
    expect(f.normalTransport!.networkRequests).toEqual(network);
  }, options));

  it.each<Record<string, string>>([
    { authorization: 'Bearer foreign' }, { 'x-codeflare-operator-installation': 'foreign' },
    { 'x-codeflare-operator-activity': 'foreign' }, { 'x-codeflare-operator-generation': '2' },
    { 'x-codeflare-operator-release': 'foreign' }, { 'x-codeflare-operator-worker-version': 'foreign' },
    { 'x-codeflare-operator-connection-revision': '2' }, { 'x-codeflare-raw-capture': '' },
    { 'content-type': 'text/plain' },
  ])('refuses foreign/malformed raw wire without protected writes: %j', headers => fixture(async f => {
    await start(f); await f.drainBackground();
    const before = await persistedState(f);
    const network = structuredClone(f.normalTransport!.networkRequests);
    const response = await f.installationCapability.fetch(upload(f, payload(), headers));
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await persistedState(f)).toEqual(before);
    expect(f.normalTransport!.networkRequests).toEqual(network);
  }, options));

  it('retains late timeout evidence after execution expiry while denying all renewed execution', () => fixture(async f => {
    await start(f); await f.drainBackground(); f.expire();
    const before = await persistedState(f);
    const network = structuredClone(f.normalTransport!.networkRequests);
    const terminal = { stage: 'submission_settled', value: { outcome: 'failed', password: 'SYNTHETIC_LATE_SECRET',
      errorInfo: { name: 'TimeoutError', message: 'SYNTHETIC_ORIGINAL_TIMEOUT', stack: 'original timeout stack' } } };
    expect((await f.installationCapability.fetch(upload(f, terminal))).status).toBe(200);
    const stored = await retained(f);
    expect(JSON.parse(new TextDecoder().decode(recovered(stored.records)))).toEqual(terminal);
    const after = await persistedState(f);
    for (const [key, value] of before) expect(after.get(key)).toEqual(value);
    expect(f.normalTransport!.networkRequests).toEqual(network);
    expect((await f.installationCapability.fetch(normalCallback(f.activityId, 'source', {
      operationId: 'logs-cannot-renew-work', url: 'https://api.github.com/repos/another/service',
    }))).status).toBe(403);
  }, options));

  it.each(['rotation', 'generation', 'owner'] as const)('identity %s during upload cannot yield a complete acknowledgement', change => fixture(async f => {
    await start(f); await f.drainBackground();
    const network = structuredClone(f.normalTransport!.networkRequests);
    let first = true;
    const body = new ReadableStream<Uint8Array>({ async pull(controller) {
      if (first) { first = false; controller.enqueue(new TextEncoder().encode('{"stage":"tool","value":"prefix')); return; }
      if (change === 'rotation') f.changeConnection({ connectionRevision: 2 });
      else await f.mutateEvidence(async storage => {
        if (change === 'generation') {
          const lease = await storage.get<Record<string, unknown>>('dispatcher:lease');
          await storage.put('dispatcher:lease', { ...lease, generation: 2 });
        } else {
          const state = await storage.get<Record<string, unknown>>('admission');
          await storage.put('admission', { ...state, ownerKey: 'different-owner' });
        }
      });
      controller.close();
    } }, { highWaterMark: 0 });
    const response = await f.installationCapability.fetch(new Request(upload(f), { method: 'POST', body }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ status: 'incomplete', captureId });
    expect(f.normalTransport!.networkRequests).toEqual(network);
  }, options));

  it('retains delivered prefix and original stream error but never acknowledges a failed upload as complete', () => fixture(async f => {
    await start(f); await f.drainBackground();
    const prefix = new TextEncoder().encode('{"stage":"tool","value":"delivered-prefix');
    const original = new Error('SYNTHETIC_UPLOAD_STREAM_ERROR', { cause: new Error('SYNTHETIC_UPLOAD_STREAM_CAUSE') });
    let delivered = false;
    const body = new ReadableStream<Uint8Array>({ pull(controller) {
      if (delivered) controller.error(original);
      else { delivered = true; controller.enqueue(prefix); }
    } }, { highWaterMark: 0 });
    const response = await f.installationCapability.fetch(new Request(upload(f), { method: 'POST', body }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ status: 'incomplete', captureId });
    const stored = await retained(f);
    expect(stored.receipt).toMatchObject({ termination: 'failed' });
    expect(recovered(stored.records)).toEqual(prefix);
    expect(stored.records.find(record => record.stage === 'installed-sdk-upload-error')?.value).toMatchObject({
      message: 'SYNTHETIC_UPLOAD_STREAM_ERROR', cause: { message: 'SYNTHETIC_UPLOAD_STREAM_CAUSE' },
    });
    expect(f.normalTransport!.networkRequests.some(request => request.url.includes('diagnostic/raw'))).toBe(false);
  }, options));

  it('native retention failure cannot mutate original business state or claim a complete capture', () => fixture(async f => {
    await start(f); await f.drainBackground();
    const before = await persistedState(f);
    const network = structuredClone(f.normalTransport!.networkRequests);
    await f.mutateEvidence(async storage => {
      const transaction = vi.spyOn(storage, 'transaction').mockRejectedValue(new Error('SYNTHETIC_RAW_STORAGE_FAILURE'));
      try {
        const response = await f.installationCapability.fetch(upload(f));
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({ status: 'incomplete', captureId });
      } finally { transaction.mockRestore(); }
    });
    expect(await persistedState(f)).toEqual(before);
    expect(f.normalTransport!.networkRequests).toEqual(network);
  }, options));
});
