/// <reference types="@cloudflare/vitest-plugin/types" />
import { Buffer } from 'node:buffer';
import { getOrImportKey, decryptFromKV } from '../../lib/kv-crypto';
import { describe, expect, it, vi } from 'vitest';
import { fixture, start, type DispatcherFixture } from './fixtures/dispatcher-production';
import { normalCallback } from './fixtures/normal-dispatcher';
import { createOwnerRawCaptureStorage, readRawCapture, discoverRawCaptures } from '../../operators/raw-capture-storage';
import { OperatorOwnerInferenceAuthority } from '../../operators/dispatcher-owner-inference';
import { OperatorDispatcherCapability } from '../../operators/activity';
import type { InferenceArchiveBinding } from '../../lib/inference-archive-capability';
import * as access from '../../lib/access';
import { createMockKV } from '../helpers/mock-kv';
import type { RawCaptureBinding, RawCaptureReceipt } from '../../operators/raw-capture-storage';

type OwnerRawInput = { view: 'discover' | 'export'; scope: RawCaptureBinding['scope']; cursor?: string; captureId?: string };
type OwnerRawReader = { readOwnerRawCaptures(credential: { email: string; accessJwt: string }, input: OwnerRawInput): Promise<Response> };
type OwnerRawPage = { status: 'complete'; bindings: RawCaptureBinding[]; cursor: string | null };
const ownerCredential = { email: 'owner@example.test', accessJwt: 'PRIVATE_RAW_OWNER_JWT' };

// Reuse diagnosticsBrowser's existing requireOperatorHumanContext seam. JWT signature,
// issuer, audience and principal validation are covered by lib/jwt.test.ts and access tests.
// Here a token fixes the signed principal: changing email/owner/role cannot mint one.
function ownerReadAuth(f: DispatcherFixture) {
  const kv = createMockKV();
  kv._set('user:owner@example.test', { role: 'admin' });
  kv._set('user:foreign@example.test', { role: 'admin' });
  f.environment.KV = kv as unknown as KVNamespace;
  const human = vi.spyOn(access, 'requireOperatorHumanContext').mockImplementation(async (request, _environment, email) => {
    const accessJwt = request.headers.get('cf-access-jwt-assertion') ?? '';
    const signedEmail = accessJwt === ownerCredential.accessJwt ? ownerCredential.email
      : accessJwt === 'PRIVATE_RAW_FOREIGN_JWT' ? 'foreign@example.test' : null;
    if (!signedEmail || signedEmail !== email) throw new Error('Authentication rejected');
    return { human: { subject: signedEmail === ownerCredential.email ? 'owner' : 'foreign', email: signedEmail,
      issuer: 'https://access.example.test', audiences: ['audience'], issuedAt: Math.floor(Date.now() / 1000) - 1,
      expiresAt: Math.floor(Date.now() / 1000) + 600 }, accessJwt };
  });
  return { kv, restore: () => human.mockRestore() };
}
const activityScope = (f: DispatcherFixture, generation = 1): RawCaptureBinding['scope'] =>
  ({ kind: 'activity', activityId: f.activityId, generation });
const nativeOwnerRead = (f: DispatcherFixture, input: OwnerRawInput, credential = ownerCredential) =>
  f.inOwnContext(() => (f.activity as typeof f.activity & OwnerRawReader).readOwnerRawCaptures(credential, input));
async function ownerPage(response: Response): Promise<OwnerRawPage> {
  expect(response).toBeInstanceOf(Response);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const page = await response.json() as OwnerRawPage;
  expect(page).toEqual({ status: 'complete', bindings: expect.any(Array), cursor: page.cursor });
  if (page.cursor !== null) expect(page.cursor).toMatch(/^[a-f0-9]{64}$/);
  return page;
}
async function ownerExport(response: Response) {
  expect(response).toBeInstanceOf(Response);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('content-type')).toContain('application/x-ndjson');
  const text = await response.text();
  expect(text.endsWith('\n')).toBe(true);
  const frames = text.trimEnd().split('\n').map(line => JSON.parse(line));
  const last = frames.pop();
  expect(last).toEqual({ type: 'complete', receipt: expect.objectContaining({ status: 'complete' }) });
  for (const frame of frames) expect(frame).toStrictEqual({ type: 'record', stage: expect.any(String), value: frame.value });
  return { records: frames.map(frame => ({ stage: frame.stage as string, value: frame.value as unknown })),
    receipt: last.receipt as RawCaptureReceipt };
}
async function rawDenied(response: Response) {
  expect(response).toBeInstanceOf(Response);
  expect(response.ok).toBe(false);
  const text = await response.text();
  expect(text).not.toMatch(/SYNTHETIC_|PRIVATE_RAW_|"type":"record"|"type":"complete"|owner@example|foreign@example/);
}

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
async function discoverRetained(f: DispatcherFixture) {
  const archives: Array<Awaited<ReturnType<typeof readRawCapture>>> = [];
  await f.mutateEvidence(async native => {
    const scope = { ownerKey: f.proof.ownerKey, scope: { kind: 'activity' as const, activityId: f.activityId, generation: 1 } };
    const storage = await createOwnerRawCaptureStorage(f.environment, native, async () => {});
    let cursor: string | null = null;
    do {
      const page = await discoverRawCaptures({ scope, storage, cursor: cursor ?? undefined, authorize: async requested => {
        if (requested.ownerKey !== f.proof.ownerKey || requested.scope.kind !== 'activity'
          || requested.scope.activityId !== f.activityId || requested.scope.generation !== 1) throw new Error('Foreign scope');
      } });
      expect(page.status).toBe('complete');
      for (const binding of page.bindings) archives.push(await readRawCapture({ binding, storage }));
      cursor = page.cursor;
    } while (cursor);
  });
  return archives;
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

async function interceptorArchive(f: DispatcherFixture, patch: Partial<InferenceArchiveBinding> = {}) {
  const plan = await f.activity.getRuntimePlan();
  if (!plan) throw new Error('Missing original fixture plan');
  const receiptDigest = Buffer.from(await crypto.subtle.digest('SHA-256',
    new TextEncoder().encode(JSON.stringify(plan.receipt)))).toString('hex');
  const binding = { activityId: f.activityId, generation: 1, ownerKey: f.proof.ownerKey, receiptDigest, ...patch };
  const handle = new OperatorDispatcherCapability({ props: { ...binding, rawOnly: true } } as unknown as ExecutionContext,
    f.environment as unknown as ConstructorParameters<typeof OperatorDispatcherCapability>[1]);
  return { handle, binding };
}

it('REQ-OPERATOR-090/091: logging-only interceptor handle durably retains full private evidence without execution authority', () => fixture(async f => {
  await start(f); await f.drainBackground();
  const { handle } = await interceptorArchive(f);
  const before = await persistedState(f);
  const network = structuredClone(f.normalTransport!.networkRequests);
  const value = { password: 'SYNTHETIC_INTERCEPTOR_SECRET', bytes: '漢🦊'.repeat(40_000),
    error: new Error('SYNTHETIC_INTERCEPTOR_ERROR', { cause: new Error('SYNTHETIC_ORIGINAL_CAUSE') }) };
  await handle.record('interceptor-private-fixture', value);
  const records = (await discoverRetained(f)).flatMap(archive => archive.records);
  expect(records).toContainEqual({ stage: 'interceptor-private-fixture', value: expect.objectContaining({
    password: value.password, bytes: value.bytes, error: expect.objectContaining({ message: value.error.message,
      cause: expect.objectContaining({ message: 'SYNTHETIC_ORIGINAL_CAUSE' }) }) }) });
  expect((await handle.fetch(new Request('https://operator.internal/v1/dispatcher/inference', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: '{}' }))).status).toBe(403);
  await expect(handle._cf_listSchedulesForFacet([])).rejects.toThrow('Dispatcher binding unavailable');
  await expect(handle._cf_acquireFacetKeepAlive([])).rejects.toThrow('Dispatcher binding unavailable');
  await expect(f.capability.record('ungranted-archive', value)).rejects.toThrow('Dispatcher binding unavailable');
  const after = await persistedState(f);
  for (const [key, original] of before) expect(after.get(key)).toEqual(original);
  expect(f.normalTransport!.networkRequests).toEqual(network);
}, options));

it.each(['owner', 'receipt', 'generation'] as const)('REQ-OPERATOR-090/091: interceptor logging denies foreign %s', fault => fixture(async f => {
  await start(f); await f.drainBackground();
  const { handle } = await interceptorArchive(f, fault === 'owner' ? { ownerKey: 'f'.repeat(64) }
    : fault === 'receipt' ? { receiptDigest: 'e'.repeat(64) } : { generation: 2 });
  await f.drainBackground();
  const before = await persistedState(f);
  await expect(handle.record('foreign-interceptor-value', { password: 'SYNTHETIC_SECRET' })).rejects.toThrow('Raw capture unavailable');
  expect(await persistedState(f)).toEqual(before);
}, options));

it.each(['receipt', 'generation'] as const)('REQ-OPERATOR-090/091: previously issued interceptor logging denies replaced %s', fault => fixture(async f => {
  await start(f); await f.drainBackground();
  const { handle } = await interceptorArchive(f);
  let originalDigest: string | undefined;
  try {
    await f.mutateEvidence(async storage => {
      const state = await storage.get<{ receipt: { intentDigest: string }; drive: { generation: number } }>('admission');
      if (!state) throw new Error('Missing fixture admission');
      if (fault === 'receipt') {
        originalDigest = state.receipt.intentDigest;
        state.receipt.intentDigest = 'd'.repeat(64);
      } else state.drive.generation++;
      await storage.put('admission', state);
    });
    const before = await persistedState(f);
    await expect(handle.record('stale-interceptor-value', { password: 'SYNTHETIC_SECRET' })).rejects.toThrow('Raw capture unavailable');
    expect(await persistedState(f)).toEqual(before);
  } finally {
    // Existing authenticated teardown must still abort the original fixture job.
    const intentDigest = originalDigest;
    if (intentDigest !== undefined) await f.mutateEvidence(async storage => {
      const state = await storage.get<{ receipt: { intentDigest: string } }>('admission');
      if (!state) throw new Error('Missing fixture admission');
      await storage.put('admission', { ...state, receipt: { ...state.receipt, intentDigest } });
    });
  }
}, options));

it('REQ-OPERATOR-090/091: original logging OFF denies a logging-only interceptor handle', () => fixture(async f => {
  await start(f); await f.drainBackground();
  const { handle } = await interceptorArchive(f);
  const before = await persistedState(f);
  await expect(handle.record('disabled-interceptor-value', { password: 'SYNTHETIC_SECRET' })).rejects.toThrow('Raw capture unavailable');
  expect(await persistedState(f)).toEqual(before);
}, { ...options, loggingEnabled: false }));

it('REQ-OPERATOR-090/091: original logging survives terminal expiry without renewing work', () => fixture(async f => {
  await start(f); await f.drainBackground();
  const { handle } = await interceptorArchive(f);
  await f.mutateEvidence(async storage => {
    const state = await storage.get<{ intent: { deadline: number }; drive: { status: string } }>('admission');
    if (!state) throw new Error('Missing fixture admission');
    state.intent.deadline = Date.now() - 1; state.drive.status = 'failed';
    await storage.put('admission', state);
  });
  const before = await persistedState(f);
  await handle.record('expired-interceptor-value', { cause: 'SYNTHETIC_ORIGINAL_ERROR' });
  expect((await discoverRetained(f)).flatMap(archive => archive.records)).toContainEqual({
    stage: 'expired-interceptor-value', value: { cause: 'SYNTHETIC_ORIGINAL_ERROR' } });
  const after = await persistedState(f);
  for (const [key, original] of before) expect(after.get(key)).toEqual(original);
}, options));

describe('REQ-OPERATOR-090/091: authenticated unredacted installed SDK retention', () => {
  it.each([true, false])('failed profile evidence has exact private readback with original logging=%s', loggingEnabled => {
    const body = JSON.stringify({ password: 'SYNTHETIC_PROFILE_SECRET', detail: '漢🦊'.repeat(40_000) });
    return fixture(async f => {
      const ids: string[] = [], consoleLines: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
        if (typeof line !== 'string') return;
        consoleLines.push(line);
        try { const record = JSON.parse(line); if (record.message === 'raw-capture-receipt') ids.push(record.data.captureId); } catch { /* Other logs. */ }
      });
      await start(f); await f.drainBackground();
      expect(f.normalTransport!.admissions.size).toBe(0);
      const records = (await Promise.all(ids.map(id => retained(f, id)))).flatMap(result => result.records);
      if (loggingEnabled) {
        expect(records).toContainEqual({ stage: 'owner-response', value: expect.objectContaining({ status: 502, body }) });
      } else { expect(records).toEqual([]); expect(ids).toEqual([]); }
      expect(consoleLines.join('\n')).not.toContain('SYNTHETIC_PROFILE_SECRET');
      for (const line of consoleLines) {
        let record;
        try { record = JSON.parse(line); } catch { continue; }
        if (record.module === 'operator-execution' && record.message === 'owner-chunk') {
          expect(record.data.value).toEqual({ type: 'chunk', wireCaptured: true });
        }
      }
    }, { ...options, loggingEnabled, normalProfileTransport: async request =>
      new URL(request.url).pathname === '/control/profile' ? new Response(body, { status: 502 }) : undefined });
  });

  it.each([true, false])('ordinary Host observations require original logging=%s and retain full values without execution renewal', loggingEnabled => fixture(async f => {
    await start(f); await f.drainBackground(); f.expire();
    const before = structuredClone(f.normalTransport!.networkRequests);
    const value = { password: 'SYNTHETIC_HOST_SECRET', provider: { body: '漢🦊'.repeat(45_000) },
      error: { message: 'SYNTHETIC_HOST_STREAM_FAILURE', cause: { message: 'SYNTHETIC_ORIGINAL_PROVIDER_CAUSE' } } };
    const uploadOwner = (bucket: string, generation = 1) => new OperatorOwnerInferenceAuthority({ props: {
      bucket, sessionId: 'ownerhost123', email: 'owner@example.test' } } as unknown as ExecutionContext, f.environment)
      .fetch(new Request('https://operator.internal/v1/dispatcher/owner-raw', { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ activityId: f.activityId,
          generation, stage: 'configured-owner-observations', value }) }));
    expect((await uploadOwner('foreign-owner')).status).toBe(403);
    expect((await uploadOwner('owner-bucket', 2)).status).toBe(403);
    const response = await uploadOwner('owner-bucket');
    expect(response.status).toBe(loggingEnabled ? 200 : 403);
    if (loggingEnabled) {
      const receipt = await response.json() as { captureId: string };
      expect((await retained(f, receipt.captureId)).records).toEqual([{ stage: 'configured-owner-observations', value }]);
    }
    expect(f.normalTransport!.networkRequests).toEqual(before);
    expect((await f.installationCapability.fetch(normalCallback(f.activityId, 'source', {
      operationId: 'host-log-cannot-renew-work', url: 'https://api.github.com/repos/another/service',
    }))).status).toBe(403);
  }, { ...options, loggingEnabled }));

  it('opaque SDK credentials remain exact privately but unrecoverable from console on refused model work', () => fixture(async f => {
    await start(f); await f.drainBackground();
    const ids: string[] = [], output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      if (typeof line !== 'string') return;
      output.push(line);
      try { const record = JSON.parse(line); if (record.message === 'raw-capture-receipt') ids.push(record.data.captureId); } catch { /* Other logs. */ }
    });
    const secret = 'SYNTHETIC_OPAQUE_SDK_SECRET';
    const bodyBase64 = Buffer.from(JSON.stringify({ password: secret })).toString('base64');
    const body = { operationId: 'unadmitted-opaque-request', permitId: 'missing-permit', request: {
      url: 'https://custom.example.test/native/stream', method: 'POST', headers: [['x-api-key', secret]], bodyBase64 } };
    const before = structuredClone(f.normalTransport!.networkRequests);
    expect((await f.installationCapability.fetch(normalCallback(f.activityId, 'model-fetch', body))).ok).toBe(false);
    await f.drainBackground();
    const records = (await Promise.all(ids.map(id => retained(f, id)))).flatMap(result => result.records);
    expect(records).toContainEqual({ stage: 'sdk-service-request', value: {
      path: '/v1/dispatcher/model-fetch', body } });
    expect(output.join('\n')).not.toContain(secret);
    expect(output.join('\n')).not.toContain(bodyBase64);
    for (const line of output) {
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (record.message === 'sdk-service-request') expect(record.data.value)
        .toEqual({ path: '/v1/dispatcher/model-fetch', wireCaptured: true });
    }
    expect(f.normalTransport!.networkRequests).toEqual(before);
  }, options));

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

  it('persists each diagnostic input chunk before requesting the next and reconstructs all large bytes', () => fixture(async f => {
    await start(f); await f.drainBackground();
    const bytes = new TextEncoder().encode(JSON.stringify(payload()));
    const context = JSON.stringify(['codeflare-operator-raw-v1', f.proof.ownerKey, 'installation', 'release',
      captureId, 'activity', f.activityId, 1]);
    const prefix = `operator-raw:v1:${Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(context))).toString('hex')}/`;
    const key = (await getOrImportKey(f.environment))!;
    let offset = 0;
    const body = new ReadableStream<Uint8Array>({ async pull(controller) {
      if (offset) {
        // Private v1 frame contract, observed by the diagnostic sender before it yields more bytes.
        const persisted: Array<{ stage: string; value: { offset: number; bytes: string } }> = [];
        await f.mutateEvidence(async storage => {
          for (const [name, ciphertext] of await storage.list<string>({ prefix })) {
            const frame = /\/segment-(\d+)-(\d+)-0$/.exec(name);
            if (!frame) continue;
            const plaintext = await decryptFromKV(ciphertext.slice(3), key,
              JSON.stringify([context, Number(frame[1]), Number(frame[2]), 0]));
            try { persisted.push(...JSON.parse(Buffer.from(plaintext, 'base64').toString('utf8'))); }
            catch { /* A partial multi-frame batch is not durable input evidence. */ }
          }
        });
        expect(persisted.some(record => record.stage === 'installed-sdk-chunk'
          && record.value.offset + Buffer.from(record.value.bytes, 'base64').length === offset)).toBe(true);
      }
      if (offset === bytes.length) { controller.close(); return; }
      const part = bytes.slice(offset, offset + 8192);
      offset += part.length;
      controller.enqueue(part);
    } }, { highWaterMark: 0 });
    const response = await f.installationCapability.fetch(new Request(upload(f), { method: 'POST', body }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'complete', termination: 'eof' });
    const stored = await retained(f);
    expect(stored.status).toBe('complete');
    expect(recovered(stored.records)).toEqual(bytes);
  }, options));

  it('discovers and decrypts a real SDK upload after discarding its local ID and response with console unavailable', () => fixture(async f => {
    await start(f); await f.drainBackground();
    const content = payload();
    const before = structuredClone(f.normalTransport!.networkRequests);
    const log = vi.spyOn(console, 'log').mockImplementation(() => { throw new Error('Synthetic console loss'); });
    try {
      await (async () => {
        const localId = crypto.randomUUID();
        const response = await f.installationCapability.fetch(normalCallback(f.activityId, 'diagnostic/raw', content,
          { 'x-codeflare-raw-capture': localId }));
        expect(response.status).toBe(200);
        await response.body?.cancel(); // Neither the producer ID nor the receipt is retained.
      })();
      await f.drainBackground();
      const archives = await discoverRetained(f);
      const sdk = archives.filter(archive => archive.records.some(record => record.stage === 'installed-sdk-upload'));
      expect(sdk).toHaveLength(1);
      expect(sdk[0].status).toBe('complete');
      expect(recovered(sdk[0].records)).toEqual(new TextEncoder().encode(JSON.stringify(content)));
      expect(JSON.parse(new TextDecoder().decode(recovered(sdk[0].records)))).toEqual(content);
      expect(f.normalTransport!.networkRequests).toEqual(before);
    } finally { log.mockRestore(); }
  }, options));

  it('discovers ordinary Host observations without their random ID or response despite console loss', () => fixture(async f => {
    await start(f); await f.drainBackground();
    const value = { password: 'SYNTHETIC_HOST_RECOVERY_SECRET', authorization: 'Bearer SYNTHETIC_HOST_RECOVERY_TOKEN',
      body: '漢🦊é'.repeat(45_000), error: { message: 'original failure', cause: { stack: 'original private stack' } } };
    const log = vi.spyOn(console, 'log').mockImplementation(() => { throw new Error('Synthetic console loss'); });
    try {
      await (async () => {
        const response = await new OperatorOwnerInferenceAuthority({ props: { bucket: 'owner-bucket',
          sessionId: 'ownerhost123', email: 'owner@example.test' } } as unknown as ExecutionContext, f.environment)
          .fetch(new Request('https://operator.internal/v1/dispatcher/owner-raw', { method: 'POST',
            headers: { 'content-type': 'application/json' }, body: JSON.stringify({ activityId: f.activityId,
              generation: 1, stage: 'configured-owner-observations', value }) }));
        expect(response.status).toBe(200);
        await response.body?.cancel(); // The Host never consumes the generated capture ID.
      })();
      await f.drainBackground();
      const archives = await discoverRetained(f);
      const host = archives.filter(archive => archive.records.some(record => record.stage === 'configured-owner-observations'));
      expect(host).toHaveLength(1);
      expect(host[0]).toMatchObject({ status: 'complete', records: [{ stage: 'configured-owner-observations', value }] });
      const auth = ownerReadAuth(f);
      try {
        const before = await persistedState(f), alarm = await f.nextAlarm();
        const network = structuredClone(f.normalTransport!.networkRequests), profiles = structuredClone(f.ownerPortRequests);
        const page = await ownerPage(await nativeOwnerRead(f, { view: 'discover', scope: activityScope(f) }));
        const exported: Array<{ stage: string; value: unknown }> = [];
        for (const binding of page.bindings) exported.push(...(await ownerExport(await nativeOwnerRead(f,
          { view: 'export', scope: activityScope(f), captureId: binding.captureId }))).records);
        expect(exported).toContainEqual({ stage: 'configured-owner-observations', value });
        expect(await persistedState(f)).toEqual(before);
        expect(await f.nextAlarm()).toBe(alarm);
        expect(f.normalTransport!.networkRequests).toEqual(network);
        expect(f.ownerPortRequests).toEqual(profiles);
      } finally { auth.restore(); }
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

  it.each(['write', 'read'] as const)('locator %s failure refuses the SDK acknowledgement even with the archive persisted', fault => fixture(async f => {
    await start(f); await f.drainBackground();
    const before = await persistedState(f);
    const network = structuredClone(f.normalTransport!.networkRequests);
    await f.mutateEvidence(async storage => {
      // Fault only the private locator namespace, leaving actual payload retention functional.
      const get = storage.get.bind(storage);
      const transaction = storage.transaction.bind(storage);
      const read = vi.spyOn(storage, 'get').mockImplementation((async (key: string) => {
        if (fault === 'read' && key.startsWith('operator-raw-index:')) throw new Error('Synthetic locator read failure');
        return get(key);
      }) as typeof storage.get);
      const write = vi.spyOn(storage, 'transaction').mockImplementation(closure => transaction(async tx => {
        const originalPut = tx.put.bind(tx);
        const put = vi.spyOn(tx, 'put').mockImplementation((async (key: string, value: unknown) => {
          if (fault === 'write' && key.startsWith('operator-raw-index:')) throw new Error('Synthetic locator write failure');
          return originalPut(key, value);
        }) as typeof tx.put);
        try { return await closure(tx); }
        finally { put.mockRestore(); }
      }));
      try {
        const response = await f.installationCapability.fetch(upload(f));
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({ status: 'incomplete', captureId });
      } finally { read.mockRestore(); write.mockRestore(); }
    });
    // Failure is locator durability, not a silently lost or redacted payload.
    const stored = await retained(f);
    expect(stored.status).toBe('complete');
    expect(JSON.parse(new TextDecoder().decode(recovered(stored.records)))).toEqual(payload());
    const after = await persistedState(f);
    for (const [key, value] of before) expect(after.get(key)).toEqual(value);
    expect(f.normalTransport!.networkRequests).toEqual(network);
  }, options));

  it('REQ-OPERATOR-091 AC6/7: native owner Response exports every authenticated SDK byte after current OFF and generation advance without renewing execution', () => fixture(async f => {
    await start(f); await f.drainBackground();
    const auth = ownerReadAuth(f);
    const output: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((line: unknown) => { output.push(String(line)); });
    try {
      const content = payload(), bytes = new TextEncoder().encode(JSON.stringify(content));
      expect(bytes.byteLength).toBeGreaterThan(256 * 1024);
      expect((await f.installationCapability.fetch(upload(f, content))).status).toBe(200);
      await f.drainBackground();
      f.setCurrentLogging(false); f.expire();
      // Read history, not a lease/current-generation/deadline grant. Preserve the original receipt.
      let originalLease: unknown, originalAdmission: unknown;
      await f.mutateEvidence(async storage => {
        originalLease = await storage.get('dispatcher:lease');
        originalAdmission = await storage.get('admission');
        const admission = originalAdmission as { drive: Record<string, unknown> };
        await storage.put('dispatcher:lease', { ...originalLease as object, generation: 2 });
        await storage.put('admission', { ...admission, drive: { ...admission.drive, generation: 2 } });
      });
      try {
        const before = await persistedState(f), alarm = await f.nextAlarm();
        const users = [...auth.kv._store];
        const network = structuredClone(f.normalTransport!.networkRequests), profiles = structuredClone(f.ownerPortRequests);
        const page = await ownerPage(await nativeOwnerRead(f, { view: 'discover', scope: activityScope(f), cursor: '0'.repeat(64) }));
        const binding = page.bindings.find(value => value.captureId === captureId);
        expect(binding).toEqual({ ownerKey: f.proof.ownerKey, installationId: 'installation', releaseId: 'release',
          captureId, scope: activityScope(f) });
        // Only the ID from scoped discovery crosses the public read boundary, not a full binding/storage callback.
        const archive = await ownerExport(await nativeOwnerRead(f, { view: 'export', scope: activityScope(f),
          cursor: '0'.repeat(64), captureId: binding!.captureId }));
        expect(recovered(archive.records)).toEqual(bytes);
        expect(JSON.parse(new TextDecoder().decode(recovered(archive.records)))).toEqual(content);
        expect(archive.receipt).toMatchObject({ status: 'complete', captureId, termination: 'eof' });
        expect(archive.records.find(record => record.stage === 'installed-sdk-eof')?.value).toMatchObject({ bytes: bytes.byteLength });
        expect(await persistedState(f)).toEqual(before);
        expect(await f.nextAlarm()).toBe(alarm);
        expect(f.normalTransport!.networkRequests).toEqual(network);
        expect(f.ownerPortRequests).toEqual(profiles);
        expect([...auth.kv._store]).toEqual(users);
        expect(JSON.stringify([...before])).not.toMatch(/SYNTHETIC_RAW_PASSWORD|SYNTHETIC_RAW_TOKEN|SYNTHETIC_THROW_SITE/);
        expect(output.join('\n')).not.toMatch(/SYNTHETIC_RAW_PASSWORD|SYNTHETIC_RAW_TOKEN|SYNTHETIC_THROW_SITE/);
      } finally {
        await f.mutateEvidence(async storage => {
          await storage.put('admission', originalAdmission);
          await storage.put('dispatcher:lease', originalLease);
        });
      }
    } finally { log.mockRestore(); auth.restore(); }
  }, options));

  it.each(['revoked-session', 'lost-admin', 'expired-reader', 'replaced-owner'] as const)(
    'REQ-OPERATOR-091 AC7: native export cannot seal completion after %s while its Response is backpressured', fault => fixture(async f => {
      await start(f); await f.drainBackground();
      expect((await f.installationCapability.fetch(upload(f))).status).toBe(200);
      const auth = ownerReadAuth(f);
      let originalAdmission: unknown;
      try {
        const response = await nativeOwnerRead(f, { view: 'export', scope: activityScope(f), captureId });
        expect(response.status).toBe(200);
        expect(response.body).not.toBeNull();
        if (fault === 'revoked-session') f.revokeSession();
        if (fault === 'lost-admin') auth.kv._set('user:owner@example.test', { role: 'user' });
        if (fault === 'expired-reader') f.advanceClock(660_000);
        if (fault === 'replaced-owner') await f.mutateEvidence(async storage => {
          originalAdmission = await storage.get('admission');
          await storage.put('admission', { ...originalAdmission as object, ownerKey: 'f'.repeat(64) });
        });
        const before = await persistedState(f), alarm = await f.nextAlarm();
        const network = structuredClone(f.normalTransport!.networkRequests), profiles = structuredClone(f.ownerPortRequests);
        const reader = response.body!.getReader(), decoder = new TextDecoder();
        let text = '';
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            text += decoder.decode(chunk.value, { stream: true });
          }
        } catch { /* An errored private stream is not a completed export. */ }
        finally { reader.releaseLock(); }
        text += decoder.decode();
        // Local guards must deny delivery itself, not merely omit the footer, after role/expiry/owner changes.
        if (fault !== 'revoked-session') expect(text).toBe('');
        // The NDJSON completion frame, not HTTP headers or a partial prefix, certifies the full export.
        expect(text.split('\n').filter(Boolean).some(line => {
          try { return JSON.parse(line).type === 'complete'; } catch { return false; }
        })).toBe(false);
        expect(await persistedState(f)).toEqual(before);
        expect(await f.nextAlarm()).toBe(alarm);
        expect(f.normalTransport!.networkRequests).toEqual(network);
        expect(f.ownerPortRequests).toEqual(profiles);
      } finally {
        if (originalAdmission !== undefined) await f.mutateEvidence(storage => storage.put('admission', originalAdmission));
        auth.restore();
      }
    }, options));

  it('REQ-OPERATOR-091 AC6: reads an original zero-controls-revision archive without changing retained work', () => fixture(async f => {
    await start(f); await f.drainBackground();
    const content = { stage: 'original-zero-controls', value: { text: '秘密🦊' } };
    expect((await f.installationCapability.fetch(upload(f, content))).status).toBe(200);
    const auth = ownerReadAuth(f);
    let original: unknown;
    try {
      await f.mutateEvidence(async storage => {
        original = await storage.get('admission');
        const state = structuredClone(original) as { intent: { expectedControlsRevision: number };
          receipt: { expectedControlsRevision: number; selection: { controlsRevision: number } } };
        state.intent.expectedControlsRevision = 0;
        state.receipt.expectedControlsRevision = 0;
        state.receipt.selection.controlsRevision = 0;
        await storage.put('admission', state);
      });
      const before = await persistedState(f), alarm = await f.nextAlarm();
      const network = structuredClone(f.normalTransport!.networkRequests);
      const archive = await ownerExport(await nativeOwnerRead(f, { view: 'export', scope: activityScope(f), captureId }));
      expect(JSON.parse(new TextDecoder().decode(recovered(archive.records)))).toEqual(content);
      expect(await persistedState(f)).toEqual(before);
      expect(await f.nextAlarm()).toBe(alarm);
      expect(f.normalTransport!.networkRequests).toEqual(network);
    } finally {
      await f.mutateEvidence(storage => storage.put('admission', original));
      auth.restore();
    }
  }, options));

  it.each(['foreign-owner', 'forged-email', 'unsigned-admin', 'missing-credential', 'revoked-session', 'non-admin'] as const)(
    'REQ-OPERATOR-090/091: native owner read refuses %s without private partial data or work', fault => fixture(async f => {
      await start(f); await f.drainBackground();
      expect((await f.installationCapability.fetch(upload(f))).status).toBe(200);
      const auth = ownerReadAuth(f);
      try {
        const credential = fault === 'foreign-owner' ? { email: 'foreign@example.test', accessJwt: 'PRIVATE_RAW_FOREIGN_JWT' }
          : fault === 'forged-email' ? { email: 'owner@example.test', accessJwt: 'PRIVATE_RAW_FOREIGN_JWT' }
          : fault === 'unsigned-admin' ? { ...ownerCredential, accessJwt: 'UNSIGNED_ADMIN', ownerKey: f.proof.ownerKey, role: 'admin', human: true }
          : fault === 'missing-credential' ? { ...ownerCredential, accessJwt: '' } : ownerCredential;
        if (fault === 'revoked-session') f.revokeSession();
        if (fault === 'non-admin') auth.kv._set('user:owner@example.test', { role: 'user' });
        const before = await persistedState(f), alarm = await f.nextAlarm();
        const network = structuredClone(f.normalTransport!.networkRequests), profiles = structuredClone(f.ownerPortRequests);
        for (const view of ['discover', 'export'] as const) await rawDenied(await nativeOwnerRead(f,
          { view, scope: activityScope(f), ...(view === 'export' ? { captureId } : {}) }, credential));
        expect(await persistedState(f)).toEqual(before);
        expect(await f.nextAlarm()).toBe(alarm);
        expect(f.normalTransport!.networkRequests).toEqual(network);
        expect(f.ownerPortRequests).toEqual(profiles);
      } finally { auth.restore(); }
    }, options));

  it.each(['activity', 'generation', 'observation', 'capture', 'malformed-capture', 'cursor', 'malformed-cursor'] as const)(
    'REQ-OPERATOR-091 AC6/7: native export cannot resolve another %s or a capture outside its discovery page', fault => fixture(async f => {
      await start(f); await f.drainBackground();
      expect((await f.installationCapability.fetch(upload(f))).status).toBe(200);
      const auth = ownerReadAuth(f);
      try {
        const page = await ownerPage(await nativeOwnerRead(f, { view: 'discover', scope: activityScope(f) }));
        expect(page.bindings.some(binding => binding.captureId === captureId)).toBe(true);
        const input: OwnerRawInput = { view: 'export', scope: activityScope(f), captureId };
        if (fault === 'activity') input.scope = { kind: 'activity', activityId: 'foreign-activity', generation: 1 };
        if (fault === 'generation') input.scope = activityScope(f, 2);
        if (fault === 'observation') input.scope = { kind: 'observation', observationId: f.activityId };
        if (fault === 'capture') input.captureId = 'foreign-capture';
        if (fault === 'malformed-capture') input.captureId = '../foreign/capture';
        if (fault === 'cursor') input.cursor = 'f'.repeat(64); // After every capture on this scope's page.
        if (fault === 'malformed-cursor') input.cursor = 'not-a-native-cursor';
        const before = await persistedState(f), alarm = await f.nextAlarm();
        const network = structuredClone(f.normalTransport!.networkRequests);
        await rawDenied(await nativeOwnerRead(f, input));
        // Native cursors work in both views; discovery isn't a whole-run certificate.
        const end = await ownerPage(await nativeOwnerRead(f, { view: 'discover', scope: activityScope(f), cursor: 'f'.repeat(64) }));
        expect(end.bindings).toEqual([]);
        expect(end.cursor).toBeNull();
        expect(await persistedState(f)).toEqual(before);
        expect(await f.nextAlarm()).toBe(alarm);
        expect(f.normalTransport!.networkRequests).toEqual(network);
      } finally { auth.restore(); }
    }, options));

  it('REQ-OPERATOR-091 AC6/7: native owner read cannot materialize original OFF history after current ON', () => fixture(async f => {
    await start(f); await f.drainBackground(); f.setCurrentLogging(true);
    expect((await f.installationCapability.fetch(upload(f))).status).toBe(204);
    const auth = ownerReadAuth(f);
    try {
      const before = await persistedState(f), alarm = await f.nextAlarm();
      const network = structuredClone(f.normalTransport!.networkRequests);
      await rawDenied(await nativeOwnerRead(f, { view: 'discover', scope: activityScope(f) }));
      await rawDenied(await nativeOwnerRead(f, { view: 'export', scope: activityScope(f), captureId }));
      expect(await persistedState(f)).toEqual(before);
      expect(await f.nextAlarm()).toBe(alarm);
      expect(f.normalTransport!.networkRequests).toEqual(network);
    } finally { auth.restore(); }
  }, { ...options, loggingEnabled: false }));

  it.each(['receipt', 'owner', 'activity', 'installation', 'release'] as const)(
    'REQ-OPERATOR-091 AC6/7: native owner read checks actual retained %s binding rather than caller claims', fault => fixture(async f => {
      await start(f); await f.drainBackground();
      expect((await f.installationCapability.fetch(upload(f))).status).toBe(200);
      const auth = ownerReadAuth(f);
      let original: unknown;
      try {
        await f.mutateEvidence(async storage => {
          original = await storage.get('admission');
          const state = structuredClone(original) as { ownerKey: string; intent: { activityId: string };
            receipt?: { selection: { installation: { id: string }; release: { id: string } } } };
          if (fault === 'receipt') delete state.receipt;
          if (fault === 'owner') state.ownerKey = 'f'.repeat(64);
          if (fault === 'activity') state.intent.activityId = 'foreign-activity';
          if (fault === 'installation') state.receipt!.selection.installation.id = 'foreign-installation';
          if (fault === 'release') state.receipt!.selection.release.id = 'foreign-release';
          await storage.put('admission', state);
        });
        const before = await persistedState(f), alarm = await f.nextAlarm();
        const network = structuredClone(f.normalTransport!.networkRequests);
        await rawDenied(await nativeOwnerRead(f, { view: 'discover', scope: activityScope(f) }));
        await rawDenied(await nativeOwnerRead(f, { view: 'export', scope: activityScope(f), captureId }));
        expect(await persistedState(f)).toEqual(before);
        expect(await f.nextAlarm()).toBe(alarm);
        expect(f.normalTransport!.networkRequests).toEqual(network);
      } finally {
        await f.mutateEvidence(storage => storage.put('admission', original));
        auth.restore();
      }
    }, options));

  it.each(['missing', 'locator', 'segment', 'receipt', 'incomplete'] as const)(
    'REQ-OPERATOR-091 AC6/7: %s private SDK archive never produces a native success or partial private response', fault => fixture(async f => {
      await start(f); await f.drainBackground();
      if (fault !== 'missing') expect((await f.installationCapability.fetch(upload(f))).status).toBe(200);
      const auth = ownerReadAuth(f);
      try {
        if (fault !== 'missing') await f.mutateEvidence(async storage => {
          const context = JSON.stringify(['codeflare-operator-raw-v1', f.proof.ownerKey, 'installation', 'release',
            captureId, 'activity', f.activityId, 1]);
          const prefix = `operator-raw:v1:${Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(context))).toString('hex')}/`;
          const indexContext = JSON.stringify(['codeflare-operator-raw-index-v1', f.proof.ownerKey, 'activity', f.activityId, 1]);
          const indexPrefix = `operator-raw-index:v1:${Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(indexContext))).toString('hex')}/`;
          // Existing encrypted v1 artifact coordinates, also used by the incremental-upload fixture above.
          const entries = await storage.list<string>({ prefix: fault === 'locator' ? indexPrefix : prefix });
          const name = [...entries.keys()].find(key => fault === 'locator' ? key.endsWith(prefix.slice('operator-raw:v1:'.length, -1))
            : fault === 'segment' ? key.includes('/segment-') : key.endsWith('/receipt'));
          expect(name).toBeDefined();
          if (fault === 'incomplete') await storage.delete(name!);
          else await storage.put(name!, 'v1:AAAA');
        });
        const before = await persistedState(f), alarm = await f.nextAlarm();
        const network = structuredClone(f.normalTransport!.networkRequests);
        await rawDenied(await nativeOwnerRead(f, { view: 'export', scope: activityScope(f), captureId }));
        if (fault === 'locator') await rawDenied(await nativeOwnerRead(f, { view: 'discover', scope: activityScope(f) }));
        expect(await persistedState(f)).toEqual(before);
        expect(await f.nextAlarm()).toBe(alarm);
        expect(f.normalTransport!.networkRequests).toEqual(network);
      } finally { auth.restore(); }
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
