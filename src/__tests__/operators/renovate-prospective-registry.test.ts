// Ownership migration: execution fences/ledger/bootstrap -> application-execution.test.ts;
// exact-head layouts/election/retry -> SDK test/renovate/legacy-admission-parity.test.ts.
// Generic timer/authority delivery stays in application-schedule.test.ts. This
// file retains original-byte capture and historical preparation/read contracts.
/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { env, reset, runInDurableObject } from 'cloudflare:test';
import { OperatorRegistry, type ManagementExecutionSelection } from '../../operators/registry';
import { OperatorActivity, createOperatorIntentDigest } from '../../operators/activity';
import { operatorOwnerKey } from '../../operators/browser-activity';
import { createOperatorExecutionContext } from '../../operators/execution-context';
import { createMockKV } from '../helpers/mock-kv';
import { setLogLevel } from '../../lib/logger';
import { captureError, hashDiagnostic } from '../../operators/dispatcher-diagnostics-wire';
import * as access from '../../lib/access';
import { captureRawInteraction, createRawCapture, exportRawCapture, createOwnerRawCaptureStorage, discoverRawCaptures, type RawCaptureBinding } from '../../operators/raw-capture-storage';
import type { Env } from '../../types';
import { prospectiveReconciliationStream, consumeProspectiveReconciliation } from '../../operators/prospective-reconciliation';

const repoId = 424242, head = 'a'.repeat(40);
const at = new Date().toISOString();
// Manually driven fixtures must not leave backing objects or alarms for later cases.
afterEach(async () => { await reset(); });
const claims = (email: string, lifetimeSeconds = 300) => ({ subject: email, email, issuer: 'https://owner.cloudflareaccess.com',
  audiences: ['audience'], issuedAt: Math.floor(Date.now() / 1000) - 20,
  expiresAt: Math.floor(Date.now() / 1000) + lifetimeSeconds });
async function fixture(run: (context: { registry: OperatorRegistry;
  native: DurableObjectState; environment: Env; selection: object;
  state: { sessions: Map<string, { generation: number; status: string }>;
    roles: Map<string, string>; revoked: Set<string>; enabled: boolean;
    identityFault: 'valid' | 'revoked' | 'forbidden' | 'unavailable' | 'malformed' | 'transport-error' | 'timeout' } }) => Promise<void>) {
  const namespace = (env as unknown as { OPERATOR_REGISTRY: DurableObjectNamespace }).OPERATOR_REGISTRY;
  await runInDurableObject(namespace.getByName(`prospective-registry-${crypto.randomUUID()}`), async (_instance, native) => {
    const state = { sessions: new Map([['asession01', { generation: 3, status: 'running' }],
      ['zsession01', { generation: 4, status: 'running' }]]),
      roles: new Map([['a@example.test', 'admin'], ['z@example.test', 'admin']]),
      revoked: new Set<string>(), enabled: true,
      identityFault: 'valid' as 'valid' | 'revoked' | 'forbidden' | 'unavailable' | 'malformed' | 'transport-error' | 'timeout' };
    const kv = createMockKV();
    const database = { prepare: () => ({ bind: (...args: unknown[]) => ({ first: async () => {
      const session = state.sessions.get(String(args[1]));
      return session && args[0] === 'owner-bucket' ? {
        owner_key: 'owner-bucket', session_id: args[1], lifecycle_state: session.status,
        lifecycle_generation: session.generation, name: 'Admin session', workspace: 'default',
        terminal_mode: 'terminal', created_at: at, last_accessed_at: at, response_revision: 0,
        observation_sequence: 0, editor_ready: 1, editor_ready_error: 0,
      } : null;
    } }) }) };
    kv.get = vi.fn(async (key: string, type?: string) => {
      const value = key.startsWith('user:') ? JSON.stringify({ role: state.roles.get(key.slice(5)) ?? 'user' })
        : kv._store.get(key) ?? null;
      return type === 'json' && value !== null ? JSON.parse(value) : value;
    }) as typeof kv.get;
    const environment = { ENCRYPTION_KEY: btoa('k'.repeat(32)), USAGE_DB: database, KV: kv } as unknown as Env;
    const registry = new OperatorRegistry(native, environment);
    const selection = { controlsRevision: 1, installation: { id: 'dispatcher-install', operatorId: 'dispatcher',
      enabled: true, revision: 1, releaseId: 'release',
      configurationJson: JSON.stringify({ renovate: { repository: 'acme/updates', automaticRuns: true, repetitionIntervalSeconds: 900 } }), policy: { capabilities: ['fetch'], resourceProfileId: null } },
      operator: { id: 'dispatcher', operatorId: 'dispatcher', profile: 'dispatcher', revision: 1,
        policy: { capabilities: ['fetch'], resourceProfileId: null },
        invokers: { users: ['a@example.test', 'z@example.test'], groups: [] } },
      release: { id: 'release', bundleDigest: 'c'.repeat(64) }, manifestJson: JSON.stringify({
        id: 'renovate-dispatcher', profile: 'dispatcher', intentVersion: '3' }) };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_request, init) => {
      const cookie = new Headers(init?.headers).get('Cookie') ?? '';
      const token = cookie.replace(/^CF_Authorization=/, '');
      if (state.revoked.has(token) || state.identityFault === 'revoked') return new Response(null, { status: 401 });
      if (state.identityFault === 'forbidden') return new Response(null, { status: 403 });
      if (state.identityFault === 'unavailable') return new Response(null, { status: 503 });
      if (state.identityFault === 'timeout') throw new DOMException('Timed out', 'TimeoutError');
      if (state.identityFault === 'transport-error') throw new Error('Identity transport unavailable');
      return Response.json({ id: `${token.slice(0, 1)}@example.test`,
        email: `${token.slice(0, 1)}@example.test`,
        ...(state.identityFault === 'malformed' ? { groups: null } : {}) });
    };
    try { await run({ registry, native, environment, selection, state }); }
    finally { globalThis.fetch = originalFetch; }
  });
}
type NativeRawInput = { view: 'discover' | 'export'; scope: RawCaptureBinding['scope']; cursor?: string; captureId?: string };
type NativeRawReader = { readOwnerRawCaptures(credential: { email: string; accessJwt: string }, input: NativeRawInput): Promise<Response> };
// Existing authenticated native owner-read boundary; no scheduler activation.
// Tokens fix their typed verified claims; the DO must still check live Access and KV admin.
function registryReadAuth() {
  return vi.spyOn(access, 'requireOperatorHumanContext').mockImplementation(async (request, _environment, email) => {
    const accessJwt = request.headers.get('cf-access-jwt-assertion') ?? '';
    const signedEmail = accessJwt === 'a-jwt' ? 'a@example.test' : accessJwt === 'z-jwt' ? 'z@example.test' : null;
    if (!signedEmail || signedEmail !== email) throw new Error('Authentication rejected');
    return { human: claims(signedEmail, 3600), accessJwt };
  });
}
async function registryRawPage(response: Response) {
  expect(response).toBeInstanceOf(Response);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const page = await response.json() as { status: 'complete'; bindings: RawCaptureBinding[]; cursor: string | null };
  expect(page).toEqual({ status: 'complete', bindings: expect.any(Array), cursor: page.cursor });
  if (page.cursor !== null) expect(page.cursor).toMatch(/^[a-f0-9]{64}$/);
  return page;
}
// Export consumers can reconstruct full logical records; production persistence
// deliberately never allocates a history/record reconstruction buffer.
function reconciliationRecords(records: Array<{ stage: string; value: unknown }>) {
  const decoded: Array<{ stage: string; value: unknown }> = [];
  let sequence = 0; let part = 0; let text = '';
  for (const record of records) {
    if (record.stage !== 'reconciliation-record-part') { decoded.push(record); continue; }
    const frame = record.value as { type: string; sequence: number; part: number; text: string; last: boolean; digest?: string };
    expect(frame).toMatchObject({ type: 'record', sequence, part });
    expect(frame.text.length).toBeLessThanOrEqual(4096);
    text += frame.text;
    if (frame.last) {
      // The private framing contract checksums the reconstructed original UTF-8.
      expect(frame.digest).toBe(createHash('sha256').update(text).digest('hex'));
      decoded.push(JSON.parse(text)); text = ''; part = 0; sequence++;
    } else part++;
  }
  expect(text).toBe(''); expect(part).toBe(0);
  return decoded;
}
async function registryRawExport(response: Response) {
  expect(response).toBeInstanceOf(Response);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('content-type')).toContain('application/x-ndjson');
  const text = await response.text();
  expect(text.endsWith('\n')).toBe(true);
  const frames = text.trimEnd().split('\n').map(line => JSON.parse(line));
  expect(frames.pop()).toEqual({ type: 'complete', receipt: expect.objectContaining({ status: 'complete' }) });
  for (const frame of frames) expect(frame).toStrictEqual({ type: 'record', stage: expect.any(String), value: frame.value });
  return reconciliationRecords(frames.map(frame => ({ stage: frame.stage as string, value: frame.value as unknown })));
}
async function registryRawDenied(response: Response) {
  expect(response).toBeInstanceOf(Response);
  expect(response.ok).toBe(false);
  expect(await response.text()).not.toMatch(/SYNTHETIC_|a-jwt|z-jwt|"type":"record"|"type":"complete"|@example.test/);
}

// Caller-side fault/race seam only: never wrap the Activity's native readable
// before Response transfers it out of the transaction's parent input gate.
function adaptReconciliationResult(stream: ReadableStream<Uint8Array>, onResult: (line: string) => Promise<string | null>) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  const TEXT = 4096, LINE = 64 * 1024;
  const reader = stream.getReader();
  // closed is a parallel notification; read() below still exposes source errors.
  void reader.closed.catch(() => {});
  let pending = ''; let chunk: Uint8Array | undefined; let at = 0; let finished = false;
  const cleanup = async (reason?: unknown) => {
    try { await reader.cancel(reason); } catch { /* Preserve the original read/decoder/callback error. */ }
    finally { reader.releaseLock(); chunk = undefined; pending = ''; }
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (!finished) {
          if (!chunk || at === chunk.length) {
            const next = await reader.read();
            if (finished) return;
            if (next.done) {
              pending += decoder.decode();
              if (pending) throw Error('RECONCILIATION_INTERRUPTED');
              finished = true; controller.close();
              await cleanup(); return;
            }
            chunk = next.value; at = 0;
          }
          // Decode at most TEXT bytes, stopping at the next physical newline.
          // Keep only the current input chunk and one bounded partial line.
          const slice = chunk.subarray(at, at + TEXT);
          const newline = slice.indexOf(10);
          const end = at + (newline < 0 ? slice.length : newline + 1);
          pending += decoder.decode(chunk.subarray(at, end), { stream: true });
          at = end;
          if (at === chunk.length) chunk = undefined;
          if (newline < 0) {
            if (pending.length > LINE) throw Error('RECONCILIATION_FRAME_INVALID');
            continue;
          }
          const line = pending.slice(0, -1); pending = '';
          if (line.length > LINE) throw Error('RECONCILIATION_FRAME_INVALID');
          const frame: unknown = JSON.parse(line);
          const replacement = frame !== null && typeof frame === 'object' && 'type' in frame && frame.type === 'result'
            ? await onResult(line) : line;
          if (finished) return;
          if (replacement !== null) controller.enqueue(encoder.encode(`${replacement}\n`));
          // Dropped/corrupted footers cancel the source; an unchanged footer
          // must keep reading so genuine EOF, trailing data and failures survive.
          if (replacement !== line) {
            finished = true; controller.close();
            await cleanup();
          }
          return;
        }
      } catch (error) {
        if (finished) return;
        finished = true; controller.error(error);
        await cleanup(error);
      }
    },
    async cancel(reason) {
      if (finished) return;
      finished = true;
      await cleanup(reason);
    },
  }, { highWaterMark: 0 });
}

describe('REQ-OPERATOR-061 AC2/6/7 /090/091: reconciliation consumer wire integrity', () => {
  const encoder = new TextEncoder();
  const privateText = 'PRIVATE_秘密🧪';
  const texts = ['{"stage":"boundary","value":"', privateText, '"}'];
  // Hand-authored wire frames, independent of the production stream producer.
  // Recompute checksums after part edits so ordering failures stand alone.
  const records = (order = [0, 1, 2], sequence = 0) => {
    const digest = createHash('sha256').update(order.map(part => texts[part]).join('')).digest('hex');
    return order.map((part, index) => ({ type: 'record', sequence, part, text: texts[part],
      last: index === order.length - 1, ...(index === order.length - 1 ? { digest } : {}) }));
  };
  const result = (count = 1) => ({ type: 'result', value: { retired: true, text: privateText },
    evidenceComplete: true, records: count });
  const wire = (frames: unknown[]) => encoder.encode(frames.map(frame => `${JSON.stringify(frame)}\n`).join(''));
  const stream = (chunks: Uint8Array[], failure?: Error) => {
    let index = 0;
    return new ReadableStream<Uint8Array>({ pull(controller) {
      if (index < chunks.length) controller.enqueue(chunks[index++]);
      else if (failure) controller.error(failure);
      else controller.close();
    } }, { highWaterMark: 0 });
  };
  const valid = () => wire([...records(), result()]);
  const malformed: Array<{ name: string; chunks: Uint8Array[]; failure?: Error }> = [
    { name: 'altered record text with its original checksum', chunks: [wire([
      ...records().map(frame => frame.part === 1 ? { ...frame, text: 'ALTERED' } : frame), result()])] },
    { name: 'altered checksum with original record text', chunks: [wire([
      ...records().map(frame => frame.last ? { ...frame, digest: '0'.repeat(64) } : frame), result()])] },
    { name: 'duplicate part with a matching recomputed checksum', chunks: [wire([...records([0, 1, 1, 2]), result()])] },
    { name: 'reordered parts with a matching recomputed checksum', chunks: [wire([...records([1, 0, 2]), result()])] },
    { name: 'missing middle part with a matching recomputed checksum', chunks: [wire([...records([0, 2]), result()])] },
    { name: 'wrong final part number with a valid checksum', chunks: [wire([
      ...records().map(frame => frame.last ? { ...frame, part: 3 } : frame), result()])] },
    { name: 'skipped record sequence with valid parts and checksums', chunks: [wire([
      ...records(), ...records([0, 1, 2], 2), result(2)])] },
    { name: 'underreported record count', chunks: [wire([...records(), result(0)])] },
    { name: 'overreported record count', chunks: [wire([...records(), result(2)])] },
    { name: 'valid result followed by another valid record', chunks: [valid(), wire(records([0, 1, 2], 1))] },
    { name: 'valid result followed by another result', chunks: [valid(), wire([result()])] },
    { name: 'valid result followed by a stream error', chunks: [valid()], failure: Error('Transport failed after result') },
    { name: 'unfinished record before a result with a matching completed-record count',
      chunks: [wire([...records().slice(0, 2), result(0)])] },
    { name: 'missing final result after a complete record', chunks: [wire(records())] },
    { name: 'incomplete final result frame', chunks: [wire(records()), encoder.encode('{"type":"result","value":')] },
    { name: 'final result without its terminating newline', chunks: [valid().slice(0, -1)] },
    // Invalid bytes inside the result string would otherwise become replacement
    // characters in an accepted result; record checksums cannot mask this guard.
    { name: 'invalid UTF-8 inside an otherwise valid result', chunks: [wire(records()),
      encoder.encode('{"type":"result","value":{"retired":true,"text":"'), Uint8Array.of(0xff),
      encoder.encode('"},"evidenceComplete":true,"records":1}\n')] },
    { name: 'unfinished UTF-8 sequence at EOF after a valid result', chunks: [valid(), Uint8Array.of(0xe7)] },
  ];

  it.each(malformed)('$name rejects rather than returning retirement eligibility', async ({ chunks, failure }) => {
    await expect(consumeProspectiveReconciliation(stream(chunks, failure), value => value)).rejects.toThrow();
    await expect(consumeProspectiveReconciliation(
      adaptReconciliationResult(stream(chunks, failure), async line => line), value => value)).rejects.toThrow();
  });

  it.each(['bytewise', 'coalesced'] as const)(
    'caller footer faults/races preserve physical evidence across %s UTF-8 chunks', async chunking => {
      // Deliberately noncanonical whitespace must survive, not just parsed values.
      const evidence = records().map(frame => ` ${JSON.stringify(frame)} \r\n`).join('');
      const footer = ` ${JSON.stringify(result())} \r\n`;
      const bytes = encoder.encode(evidence + footer);
      const chunks = chunking === 'bytewise' ? Array.from(bytes, byte => Uint8Array.of(byte)) : [bytes];
      let revision = 1;
      const raced = adaptReconciliationResult(stream(chunks), async line => {
        await Promise.resolve(); revision++; return line;
      });
      const [physical, checked] = raced.tee();
      const [forwarded, outcome] = await Promise.all([
        new Response(physical).arrayBuffer(),
        consumeProspectiveReconciliation(checked, value => ({ value, revision })),
      ]);
      expect(new Uint8Array(forwarded)).toEqual(bytes);
      expect(outcome).toEqual({ value: { value: { retired: true, text: privateText }, revision: 2 }, evidenceComplete: true });
      for (const replacement of [null, '{"type":"result","value":true}']) {
        const damaged = new Uint8Array(await new Response(adaptReconciliationResult(
          stream(chunks), async () => replacement)).arrayBuffer());
        expect(damaged).toEqual(encoder.encode(evidence + (replacement === null ? '' : `${replacement}\n`)));
        await expect(consumeProspectiveReconciliation(stream([damaged]), value => value)).rejects.toThrow();
      }
    });

  it('caller footer callback rejection stays reader-visible and cancels the source', async () => {
    const failure = Error('Caller footer callback failed');
    let cancellation: unknown;
    const source = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(valid()); },
      cancel(reason) { cancellation = reason; },
    }, { highWaterMark: 0 });
    await expect(consumeProspectiveReconciliation(adaptReconciliationResult(source, async () => {
      await Promise.resolve(); throw failure;
    }), value => value)).rejects.toBe(failure);
    expect(cancellation).toBe(failure);
    expect(source.locked).toBe(false);
  });

  it('caller cancellation cancels and releases the adapted source', async () => {
    const reason = Error('Caller stopped reading');
    let cancellation: unknown;
    const source = new ReadableStream<Uint8Array>({
      cancel(value) { cancellation = value; },
    }, { highWaterMark: 0 });
    const reader = adaptReconciliationResult(source, async line => line).getReader();
    const pendingRead = reader.read();
    await reader.cancel(reason);
    expect(await pendingRead).toEqual({ done: true, value: undefined });
    expect(cancellation).toBe(reason);
    expect(source.locked).toBe(false);
    reader.releaseLock();
  });

  it('decodes exact Unicode evidence and outcome when every UTF-8 byte is a separate chunk', async () => {
    const captured: Array<{ stage: string; value: unknown }> = [];
    const bytes = wire([...records(), ...records([0, 1, 2], 1), result(2)]);
    const outcome = await consumeProspectiveReconciliation(stream(Array.from(bytes, byte => Uint8Array.of(byte))), value => value, {
      record(stage, lazy) { captured.push({ stage, value: lazy() }); },
      finish: async () => { throw Error('Stream-only fixture has no archive to finalize'); },
    });
    expect(outcome).toEqual({ value: { retired: true, text: privateText }, evidenceComplete: true });
    expect(reconciliationRecords(captured)).toEqual([
      { stage: 'boundary', value: privateText }, { stage: 'boundary', value: privateText },
    ]);
  });
});

describe('REQ-OPERATOR-090/091 AC6/7: Registry-native private observation reads', () => {
  it.each(['on', 'off', 'writer-failure'] as const)(
    'REQ-OPERATOR-061/090/091: %s bounded exchange preserves business outcome and complete multi-batch private bytes/error chains or explicit incompleteness',
    policy => fixture(async ({ native, environment }) => {
      const binding: RawCaptureBinding = { ownerKey: 'a'.repeat(64), installationId: 'dispatcher-install', releaseId: 'release',
        captureId: crypto.randomUUID(), scope: { kind: 'observation', observationId: crypto.randomUUID() } };
      const storage = await createOwnerRawCaptureStorage(environment, native.storage, async () => {});
      const capture = createRawCapture({ enabled: policy !== 'off', binding,
        storage: async () => { if (policy === 'writer-failure') throw Error('Owner writer unavailable'); return storage; },
        schedule: work => native.waitUntil(work) });
      const privateText = 'UNREDACTED_PRIVATE_秘密🧪\n"\\'.repeat(3000);
      const error = Error(`Outer ${privateText}`, { cause: Error(`Inner ${privateText}`) });
      const pages = Array.from({ length: 3 }, (_, page) => Array.from({ length: 128 }, (_, row) => ({ page, row, body: privateText.slice(row, row + 40) })));
      let evaluated = false;
      const activityNamespace = (env as unknown as { OPERATOR_ACTIVITY: DurableObjectNamespace }).OPERATOR_ACTIVITY;
      const activityName = `multi-batch-${crypto.randomUUID()}`;
      const response = await runInDurableObject(activityNamespace.getByName(activityName), (_instance, state) =>
        new Response(prospectiveReconciliationStream(policy !== 'off', async raw => {
          raw?.record('retained-history-start', () => ({ pages: pages.length }));
          try { await raw?.flush?.(); } catch { /* Preserve business I/O when evidence fails. */ }
          return state.storage.transaction(async tx => {
            await captureRawInteraction(raw, 'transaction-write', () => ({ key: 'reconciliation-ready', value: true }),
              () => tx.put('reconciliation-ready', true));
            for (const page of pages) {
              raw?.record('retained-history-page', () => { evaluated = true; return page; }); await raw?.flush?.();
            }
            raw?.record('retained-history-error', () => error); await raw?.flush?.();
            const retired = await captureRawInteraction(raw, 'transaction-read', () => 'reconciliation-ready',
              () => tx.get<boolean>('reconciliation-ready'));
            return { retired: retired === true };
          });
        })));
      if (!response.body) throw Error('Missing reconciliation response body');
      const outcome = await consumeProspectiveReconciliation(response.body, value => value, policy === 'off' ? undefined : capture);
      expect(outcome.value).toEqual({ retired: true });
      expect(await runInDurableObject(activityNamespace.getByName(activityName), (_instance, state) =>
        state.storage.get('reconciliation-ready'))).toBe(true);
      expect(evaluated).toBe(policy !== 'off');
      const receipt = await capture.finish('complete');
      expect(receipt.status).toBe(policy === 'off' ? 'disabled' : policy === 'writer-failure' ? 'incomplete' : 'complete');
      expect(outcome.evidenceComplete).toBe(policy !== 'writer-failure');
      if (policy === 'on') {
        const exported = await registryRawExport(await exportRawCapture({ binding, storage }));
        expect(exported.filter(record => record.stage === 'retained-history-page').map(record => record.value)).toEqual(pages);
        expect(exported.find(record => record.stage === 'retained-history-error')?.value).toMatchObject({ name: 'Error',
          message: error.message, stack: error.stack, cause: { name: 'Error', message: (error.cause as Error).message, stack: (error.cause as Error).stack } });
      } else expect(await discoverRawCaptures({ scope: { ownerKey: binding.ownerKey, scope: binding.scope }, storage, authorize: async () => {} }))
        .toMatchObject({ status: 'complete', bindings: [] });
    }));

  it('exports all 538181 retained pre-admission bytes and nested errors without an Activity or current registration', () => fixture(async ({ registry, native, environment, selection, state }) => {
    environment.ENTERPRISE_MODE = 'active';
    const body = new TextEncoder().encode('SYNTHETIC_PRE_ADMISSION_BODY;'.repeat(20_000)).slice(0, 538181);
    const cause = new TypeError('SYNTHETIC_PRE_ADMISSION_CAUSE', { cause: new Error('SYNTHETIC_DEEPEST_CAUSE') });
    const original = new Error('SYNTHETIC_PRE_ADMISSION_STREAM_ERROR', { cause });
    const binding: RawCaptureBinding = { ownerKey: await operatorOwnerKey(claims('a@example.test')),
      installationId: 'dispatcher-install', releaseId: 'release', captureId: crypto.randomUUID(),
      scope: { kind: 'observation', observationId: crypto.randomUUID() } };
    const records: Array<{ stage: string; value: unknown }> = [{ stage: 'discovery-observation', value: { accessJwt: 'a-jwt' } }];
    for (let offset = 0; offset < body.length; offset += 8192) records.push({ stage: 'discovery-response-chunk',
      value: { bytes: Array.from(body.subarray(offset, offset + 8192)) } });
    records.push({ stage: 'discovery-response-error', value: { error: original } });
    // Generic owner persistence consumes original producer bytes, without
    // resurrecting Registry's retired discovery/alarm implementation.
    const receipt = await registry.retainRawObservation({ binding, records, termination: 'failed', failed: false });
    expect(receipt).toMatchObject({ status: 'complete', termination: 'failed' });
    environment.OPERATOR_ACTIVITY = { getByName: () => { throw Error('No Activity exists for this observation'); } } as never;
    (selection as ManagementExecutionSelection).operator.policy.loggingEnabled = false;
    state.enabled = false; state.sessions.clear();
    const before = structuredClone(await native.storage.list()), alarm = await native.storage.getAlarm();
    const users = await environment.KV.list();
    const auth = registryReadAuth();
    try {
      const namespace = (env as unknown as { OPERATOR_REGISTRY: DurableObjectNamespace }).OPERATOR_REGISTRY;
      const read = (input: NativeRawInput) => runInDurableObject(namespace.get(native.id), () =>
        (new OperatorRegistry(native, environment) as OperatorRegistry & NativeRawReader)
          .readOwnerRawCaptures({ email: 'a@example.test', accessJwt: 'a-jwt' }, input));
      let cursor: string | undefined;
      const exported: Array<{ stage: string; value: unknown }> = [];
      do {
        const page = await registryRawPage(await read({ view: 'discover', scope: binding.scope, cursor }));
        for (const capture of page.bindings) exported.push(...await registryRawExport(await read({
          view: 'export', scope: binding.scope, cursor, captureId: capture.captureId })));
        cursor = page.cursor ?? undefined;
      } while (cursor);
      expect(exported.find(record => record.stage === 'discovery-observation')?.value).toEqual({ accessJwt: 'a-jwt' });
      expect(Uint8Array.from(exported.filter(record => record.stage === 'discovery-response-chunk')
        .flatMap(record => (record.value as { bytes: number[] }).bytes))).toEqual(body);
      expect(exported.find(record => record.stage === 'discovery-response-error')?.value).toMatchObject({ error: {
        name: original.name, message: original.message, stack: original.stack, cause: {
          name: cause.name, message: cause.message, stack: cause.stack,
          cause: { message: 'SYNTHETIC_DEEPEST_CAUSE', stack: (cause.cause as Error).stack } } } });
      expect(await native.storage.list()).toEqual(before);
      expect(await native.storage.getAlarm()).toBe(alarm);
      expect(await environment.KV.list()).toEqual(users);
      expect(JSON.stringify([...before])).not.toMatch(/SYNTHETIC_PRE_ADMISSION_|SYNTHETIC_DEEPEST_CAUSE/);
    } finally { auth.mockRestore(); }
  }));

  it.each(['foreign-owner', 'forged-email', 'unsigned-admin', 'revoked', 'non-admin', 'scope', 'capture', 'page', 'corrupt'] as const)(
    'native Registry %s read is generic non-success without private output or mutation', fault => fixture(async ({ native, environment, state }) => {
      environment.ENTERPRISE_MODE = 'active';
      const owner = new OperatorRegistry(native, environment);
      const binding: RawCaptureBinding = { ownerKey: await operatorOwnerKey(claims('a@example.test')),
        installationId: 'dispatcher-install', releaseId: 'original-release', captureId: 'registry-private-capture',
        scope: { kind: 'observation', observationId: 'registry-private-observation' } };
      expect(await owner.retainRawObservation({ binding, records: [{ stage: 'private-native-read-fixture',
        value: { password: 'SYNTHETIC_REGISTRY_PRIVATE_PASSWORD', error: 'SYNTHETIC_REGISTRY_PRIVATE_ERROR' } }],
      termination: 'failed', failed: false })).toMatchObject({ status: 'complete' });
      const auth = registryReadAuth();
      try {
        const credential = fault === 'foreign-owner' ? { email: 'z@example.test', accessJwt: 'z-jwt' }
          : fault === 'forged-email' ? { email: 'a@example.test', accessJwt: 'z-jwt' }
          : fault === 'unsigned-admin' ? { email: 'a@example.test', accessJwt: 'UNSIGNED_ADMIN', role: 'admin', ownerKey: binding.ownerKey, human: true }
          : { email: 'a@example.test', accessJwt: 'a-jwt' };
        if (fault === 'revoked') state.revoked.add('a-jwt');
        if (fault === 'non-admin') state.roles.set('a@example.test', 'user');
        if (fault === 'corrupt') {
          const entries = await native.storage.list({ prefix: 'operator-raw:' });
          const segment = [...entries.keys()].find(key => key.includes('/segment-'));
          expect(segment).toBeDefined();
          await native.storage.put(segment!, 'v1:AAAA');
        }
        const before = structuredClone(await native.storage.list()), alarm = await native.storage.getAlarm();
        const namespace = (env as unknown as { OPERATOR_REGISTRY: DurableObjectNamespace }).OPERATOR_REGISTRY;
        const scope = fault === 'scope' ? { kind: 'observation' as const, observationId: 'foreign-observation' } : binding.scope;
        const response = await runInDurableObject(namespace.get(native.id), () => (owner as OperatorRegistry & NativeRawReader)
          .readOwnerRawCaptures(credential, { view: 'export', scope,
            captureId: fault === 'capture' ? 'foreign-capture' : binding.captureId, ...(fault === 'page' ? { cursor: 'f'.repeat(64) } : {}) }));
        await registryRawDenied(response);
        expect(await native.storage.list()).toEqual(before);
        expect(await native.storage.getAlarm()).toBe(alarm);
      } finally { auth.mockRestore(); }
    }));
});

describe('REQ-OPERATOR-063 AC1/5/6: one-round prospective admission diagnostic wire', () => {
  const message = 'Prospective Renovate admission boundary';
  type Entry = { message: string; data: Record<string, unknown> };
  // Intentional closed diagnostic wire contract, always paired below with real return/storage outcomes.
  const assertBoundaryWire = (entries: Entry[]) => {
    for (const { data } of entries.filter(entry => entry.message === message)) {
      expect(['activity-proof-rpc', 'registry-proof-storage', 'activity-bind-storage']).toContain(data.boundary);
      expect(['started', 'completed', 'failed']).toContain(data.outcome);
      expect(data.admissionDigest).toMatch(/^[a-f0-9]{64}$/);
      const completionField = data.boundary === 'activity-bind-storage' ? 'accepted' : 'proofPresent';
      expect(Object.keys(data).sort()).toEqual(['boundary', 'outcome', 'admissionDigest',
        ...(data.outcome === 'completed' ? [completionField] : []),
        ...(data.outcome === 'failed' ? ['error'] : []),
      ].sort());
      if (data.outcome === 'completed') expect(typeof data[completionField]).toBe('boolean');
    }
  };

  async function preparation(environment: Env, activityId: string) {
    const human = claims('a@example.test');
    const invocationJson = JSON.stringify({ repository: 'acme/updates' });
    const executionContext = await createOperatorExecutionContext({ activityId, operatorId: 'dispatcher',
      artifactDigest: 'c'.repeat(64), policyDigest: 'd'.repeat(64), human, accessJwt: 'a-jwt' }, environment);
    const intent = { installationId: 'dispatcher-install', activityId, operatorId: 'dispatcher',
      intentDigest: await createOperatorIntentDigest('dispatcher', activityId, invocationJson),
      expectedRevision: 1, expectedInstallationRevision: 1, expectedControlsRevision: 1,
      deadline: human.expiresAt * 1000, startExpiresAt: human.expiresAt * 1000, startVerifier: 'e'.repeat(64) };
    return { intent, executionContext, invocationJson };
  }

  it.each(['success', 'same-binding', 'missing-proof', 'foreign-proof', 'previous-binding', 'foreign-admission',
    'same-admission', 'rpc-error', 'unsafe-rpc-error', 'registry-storage-error', 'bind-transaction-error', 'bind-write-error',
    'admission-write-error', 'invalid-id', 'foreign-id', 'foreign-object', 'missing-namespace'] as const)(
    'REQ-OPERATOR-063 AC1/5/6 /061 AC3/7: %s traces only validated boundaries and preserves proof, binding and original errors with working and throwing loggers',
    fault => fixture(async ({ registry, native, environment }) => {
      const namespace = (env as unknown as { OPERATOR_ACTIVITY: DurableObjectNamespace }).OPERATOR_ACTIVITY;
      await runInDurableObject(namespace.getByName(`admission-boundary-${crypto.randomUUID()}`), async (_instance, activityNative) => {
        const activityId = 'private-admission-activity', otherId = 'private-other-activity';
        const registryNamespace = (env as unknown as { OPERATOR_REGISTRY: DurableObjectNamespace }).OPERATOR_REGISTRY;
        const inRegistry = <T>(action: () => Promise<T>) => runInDurableObject(registryNamespace.get(native.id), () => action());
        const first = { registrationId: 'historical-registration' };
        // Historical records are fixtures, not a request to the refusal-only
        // business controller. The still-supported read/bind boundary owns this test.
        if (fault !== 'missing-proof') await inRegistry(async () => native.storage.put(`renovate-activity:${activityId}`, {
          activityId, installationId: 'dispatcher-install', repository: 'acme/updates', repositoryId: repoId,
          baseBranch: 'trunk', pullRequest: 1300, head, createdAt: new Date(Date.parse(at) + 1).toISOString(),
          activatedAt: at, ownerKey: await operatorOwnerKey(claims('a@example.test')),
          controlsRevision: 1, installationRevision: 1, operatorRevision: 1, releaseId: 'release', bundleDigest: 'c'.repeat(64),
          actor: { registrationId: first.registrationId, bucket: 'owner-bucket', sessionId: '', sessionGeneration: 0,
            subject: 'a@example.test', email: 'a@example.test', issuer: claims('a@example.test').issuer, audiences: ['audience'] },
        }));
        const journal = await inRegistry(() => registry.readProspectiveRenovateAdmission(activityId));
        const originalError = Error('private-provider-body Authorization=private-token', {
          cause: Error('private-cause https://private.invalid/provider'),
        });
        if (fault === 'unsafe-rpc-error') Object.defineProperty(originalError, 'message', {
          get: () => { throw Error('private-getter-body'); },
        });
        const host = { ...environment,
          OPERATOR_ACTIVITY: fault === 'missing-namespace' ? undefined
            : { idFromName: () => fault === 'foreign-object' ? namespace.idFromName(otherId) : activityNative.id },
          OPERATOR_REGISTRY: { getByName: () => ({ readProspectiveRenovateAdmission: async (id: string) => {
            if (fault === 'rpc-error' || fault === 'unsafe-rpc-error') throw originalError;
            if (fault === 'foreign-proof') return { ...journal as object, activityId: otherId };
            return inRegistry(() => registry.readProspectiveRenovateAdmission(id));
          } }) },
        } as unknown as Env;
        const activity = new OperatorActivity(activityNative, host);
        const { intent, executionContext, invocationJson } = await preparation(host, activityId);
        if (fault === 'previous-binding' || fault === 'same-binding') {
          await activityNative.storage.put('prospective-admission', fault === 'same-binding' ? activityId : otherId);
        }
        if (fault === 'foreign-admission' || fault === 'same-admission') {
          await activityNative.storage.put('admission', { intent: { ...intent,
            activityId: fault === 'same-admission' ? activityId : otherId }, phase: 'prepared', receipt: null });
        }
        const beforeAdmission = await activityNative.storage.get('admission');
        const beforeBinding = await activityNative.storage.get('prospective-admission');
        const read = native.storage.get.bind(native.storage);
        let storageOutage = fault === 'registry-storage-error';
        const unavailable = vi.spyOn(native.storage, 'get').mockImplementation((async (key: string) => {
          if (storageOutage && key === `renovate-activity:${activityId}`) throw originalError;
          return read(key);
        }) as typeof native.storage.get);
        const transaction = activityNative.storage.transaction.bind(activityNative.storage);
        const persist = vi.spyOn(activityNative.storage, 'transaction').mockImplementation(callback => {
          if (fault === 'bind-transaction-error') return Promise.reject(originalError);
          return transaction(tx => callback(new Proxy(tx, { get(target, property) {
            const member = Reflect.get(target, property);
            if (property === 'put') return (...args: unknown[]) => {
              const key = fault === 'bind-write-error' ? 'prospective-admission'
                : fault === 'admission-write-error' ? 'admission' : null;
              if (key && (args[0] === key || typeof args[0] === 'object'
                && args[0] !== null && key in args[0])) throw originalError;
              return Reflect.apply(member, target, args);
            };
            return typeof member === 'function' ? member.bind(target) : member;
          } })));
        });
        const outputs: Entry[] = [];
        let loggerOutage = false;
        const output = (line: unknown) => {
          outputs.push(JSON.parse(String(line)));
          if (loggerOutage) throw Error('private-logger-body');
        };
        setLogLevel('info');
        const logs = vi.spyOn(console, 'log').mockImplementation(output);
        const warnings = vi.spyOn(console, 'warn').mockImplementation(output);
        const errors = vi.spyOn(console, 'error').mockImplementation(output);
        let firstDigest: unknown;
        try {
          // Repeat fresh preparation under a throwing logger; a second prepare is not a successful replay.
          for (const outage of [false, true]) {
            const accepted = fault === 'success' || fault === 'same-binding';
            if (outage && accepted) {
              await activityNative.storage.delete('admission');
              if (beforeBinding === undefined) await activityNative.storage.delete('prospective-admission');
            }
            loggerOutage = outage; outputs.length = 0;
            const input = fault === 'invalid-id' ? 'private/invalid?Authorization=private-token'
              : fault === 'foreign-id' ? otherId : activityId;
            const throws = ['rpc-error', 'unsafe-rpc-error', 'registry-storage-error', 'bind-transaction-error',
              'bind-write-error', 'admission-write-error'].includes(fault);
            const result = activity.prepareAuthorized(intent, executionContext, invocationJson, undefined, input);
            if (throws) await expect(result).rejects.toBe(originalError);
            else await expect(result).resolves.toEqual(accepted ? { ok: true, phase: 'prepared' }
              : { ok: false, reason: fault === 'same-admission' || fault === 'foreign-admission'
                ? 'already-prepared' : 'admission-denied' });
            const boundaries = outputs.filter(entry => entry.message === message);
            assertBoundaryWire(outputs);
            const proofRead = !['invalid-id', 'foreign-id', 'foreign-object', 'missing-namespace'].includes(fault);
            const storageRead = proofRead && !['rpc-error', 'unsafe-rpc-error', 'foreign-proof'].includes(fault);
            const bind = proofRead && !['rpc-error', 'unsafe-rpc-error', 'foreign-proof', 'registry-storage-error', 'missing-proof'].includes(fault);
            expect(boundaries.map(({ data }) => `${data.boundary}:${data.outcome}`)).toEqual([
              ...(proofRead ? ['activity-proof-rpc:started'] : []),
              ...(storageRead ? ['registry-proof-storage:started', `registry-proof-storage:${fault === 'registry-storage-error' ? 'failed' : 'completed'}`] : []),
              ...(proofRead ? [`activity-proof-rpc:${['rpc-error', 'unsafe-rpc-error', 'registry-storage-error'].includes(fault) ? 'failed' : 'completed'}`] : []),
              ...(bind ? ['activity-bind-storage:started', `activity-bind-storage:${['bind-transaction-error', 'bind-write-error', 'admission-write-error'].includes(fault) ? 'failed' : 'completed'}`] : []),
            ]);
            const digests = new Set(boundaries.map(({ data }) => data.admissionDigest));
            expect(digests.size).toBe(proofRead ? 1 : 0);
            // Domain separation is required; the plan deliberately does not pin the choice of prefix.
            if (proofRead) {
              expect([...digests][0]).not.toBe(hashDiagnostic(activityId));
              if (outage) expect([...digests][0]).toBe(firstDigest);
              else firstDigest = [...digests][0];
            }
            for (const { data } of boundaries) {
              if (data.outcome === 'failed') expect(data.error).toEqual(captureError(originalError));
              if (data.outcome === 'completed') expect(data).toMatchObject(data.boundary === 'activity-bind-storage'
                ? { accepted } : { proofPresent: fault !== 'missing-proof' });
            }
            expect(await activityNative.storage.get('prospective-admission')).toBe(accepted ? activityId : beforeBinding);
            if (accepted) {
              expect(await activityNative.storage.get('admission')).toMatchObject({ intent, executionContext,
                invocationJson, phase: 'prepared', receipt: null });
              expect(await activity.getAdmission()).toEqual({ activityId, phase: 'prepared', receipt: null });
              expect(await activity.getRuntimePlan()).toBeNull(); // Prepared never masquerades as queued.
            } else expect(await activityNative.storage.get('admission')).toEqual(beforeAdmission);
            // Registry failure is transient; removing the injected storage outage reveals the same immutable proof.
            storageOutage = false;
            expect(await inRegistry(() => registry.readProspectiveRenovateAdmission(activityId))).toEqual(journal);
            storageOutage = fault === 'registry-storage-error';
            if (fault === 'invalid-id') {
              const beforeInvalidRead = [...outputs];
              await expect(inRegistry(() => registry.readProspectiveRenovateAdmission(input))).resolves.toBeNull();
              expect(outputs).toEqual(beforeInvalidRead);
            }
            for (const value of [activityId, otherId, input, first.registrationId, 'owner-bucket', 'a@example.test',
              'a-jwt', head, 'private-provider-body', 'private-token', 'private-cause', 'private-getter-body',
              'private-logger-body', 'https://private.invalid/provider', 'Authorization']) {
              expect(JSON.stringify(outputs)).not.toContain(value);
            }
          }
        } finally {
          persist.mockRestore(); unavailable.mockRestore(); logs.mockRestore(); warnings.mockRestore(); errors.mockRestore(); setLogLevel('silent');
        }
      });
    }));

  it.each(['manual', 'boundary'] as const)(
    'REQ-OPERATOR-016 AC2 /061 AC3: %s preparation retains its existing authority without prospective proof',
    mode => fixture(async ({ native, environment }) => {
      const activityId = 'manual-preparation';
      const { intent, executionContext, invocationJson } = await preparation(environment, activityId);
      const boundary = { repositoryId: repoId, pullRequest: 1300, contextDigest: 'f'.repeat(64),
        session: { bucket: 'owner-bucket', sessionId: 'asession01', generation: 3 } };
      const activity = new OperatorActivity(native, { ...environment,
        OPERATOR_REGISTRY: { getByName: () => ({ readProspectiveRenovateAdmission: async () => null }) },
      } as unknown as Env);
      const result = mode === 'manual'
        ? await activity.prepareAuthorized(intent, executionContext, invocationJson)
        : await activity.prepareAuthorized(intent, executionContext, invocationJson, boundary);
      expect(result).toEqual({ ok: true, phase: 'prepared' });
      expect(await native.storage.get('prospective-admission')).toBeUndefined();
      expect(await native.storage.get('admission')).toMatchObject({ intent, executionContext, invocationJson,
        phase: 'prepared', receipt: null, ...(mode === 'boundary' ? { boundary } : {}) });
      expect(await activity.getBoundaryStartBinding(activityId)).toEqual(mode === 'boundary' ? boundary : null);
      expect(await activity.getAdmission()).toEqual({ activityId, phase: 'prepared', receipt: null });
      expect(await activity.getRuntimePlan()).toBeNull();
    }));

  it.each(['expired', 'mismatched-context'] as const)(
    'REQ-OPERATOR-016 AC2 /061 AC3: refused %s preparation cannot leave a prospective link or admission',
    fault => fixture(async ({ native, environment }) => {
      const activityId = 'refused-preparation';
      const { intent, executionContext, invocationJson } = await preparation(environment, activityId);
      const host = { ...environment, OPERATOR_ACTIVITY: { idFromName: () => native.id },
        OPERATOR_REGISTRY: { getByName: () => ({ readProspectiveRenovateAdmission: async () => ({ activityId }) }) },
      } as unknown as Env;
      const activity = new OperatorActivity(native, host);
      await expect(activity.prepareAuthorized(fault === 'expired' ? { ...intent, deadline: Date.now() - 1 } : intent,
        fault === 'mismatched-context' ? { ...executionContext, activityId: 'different-activity' } : executionContext,
        invocationJson, undefined, activityId)).resolves.toEqual({ ok: false,
        reason: fault === 'expired' ? 'authority-expired' : 'admission-denied' });
      expect(await native.storage.get('prospective-admission')).toBeUndefined();
      expect(await activity.getAdmission()).toBeNull();
      expect(await activity.getRuntimePlan()).toBeNull();
    }));

});

describe('legacy controller compatibility does not own application policy', () => {
  it('refuses new business authority without erasing historical admissions or registration bytes', () => fixture(async ({ registry, native }) => {
    const actor = { registrationId: 'original-registration', bucket: 'owner-bucket', sessionId: 'asession01', sessionGeneration: 3,
      subject: 'a@example.test', email: 'a@example.test', issuer: claims('a@example.test').issuer, audiences: ['audience'] };
    const original = { activityId: 'original-activity', installationId: 'dispatcher-install', repositoryId: repoId,
      repository: 'acme/updates', pullRequest: 1300, head, baseBranch: 'trunk', actor,
      activatedAt: at, createdAt: new Date(Date.parse(at) + 1).toISOString(),
      ownerKey: await operatorOwnerKey(claims('a@example.test')), controlsRevision: 1,
      installationRevision: 1, operatorRevision: 1, releaseId: 'release', bundleDigest: 'c'.repeat(64),
      privateEvidence: { historical: 'SYNTHETIC_ORIGINAL_BYTES' } };
    await native.storage.put({ [`renovate-activity:${original.activityId}`]: original,
      [`renovate-admission:${repoId}:1300:${head}`]: original,
      [`renovate-registration:${actor.registrationId}`]: { ...actor, activatedAt: at } });
    const before = structuredClone(await native.storage.list()), alarm = await native.storage.getAlarm();
    expect(await registry.activateProspectiveRenovate({ installationId: 'dispatcher-install', human: claims(actor.email), accessJwt: 'a-jwt' }))
      .toEqual({ ok: false, reason: 'application-upgrade-required' });
    expect(await registry.reserveProspectiveRenovateActivity({ registrationId: actor.registrationId,
      repositoryId: repoId, pullRequest: 1300, head, createdAt: original.createdAt, activityId: 'replacement' }))
      .toEqual({ ok: false, reason: 'application-upgrade-required' });
    expect(await registry.currentProspectiveRenovateRegistration(actor.registrationId)).toBeNull();
    expect(await registry.observeProspectiveRenovateRegistration(actor.registrationId)).toEqual({ status: 'denied' });
    expect(await registry.retainedProspectiveRenovateRetryTargets(actor.registrationId)).toEqual([]);
    expect(await registry.prospectiveRenovateStatus(original.installationId, original.ownerKey)).toBe('inactive');
    expect(await registry.readProspectiveRenovateAdmission(original.activityId)).toEqual(original);
    expect(await registry.readProspectiveRenovateAdmission('replacement')).toBeNull();
    expect(await native.storage.list()).toEqual(before);
    expect(await native.storage.getAlarm()).toBe(alarm);
  }));
});
