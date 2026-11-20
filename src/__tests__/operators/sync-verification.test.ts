/**
 * Test navigation: Independent manifest/file readback through bounded fixture storage; deployed R2 upload/sealing acceptance remains separate.
 * Fixtures are local/CI evidence, not production deployment or live Access acceptance.
 * Requirement IDs in describe blocks link each behavior to sdd/spec/operators.md.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ValidationError } from '../../lib/error-types';
import { verifyOperatorSync, type OperatorSyncExpectation } from '../../operators/sync-verification';

import { createOperatorSyncReader } from '../../operators/owned-session-production';
import type { Env } from '../../types';
import type { OperatorSessionBootstrap } from '../../operators/owned-session-runtime';

afterEach(() => vi.unstubAllGlobals());

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
async function sha256(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}
async function fixture(patch: Record<string, unknown> = {}) {
  const content = new TextEncoder().encode('durable marker');
  const expected: OperatorSyncExpectation = { activityId: 'activity', sessionId: 'session', operationId: 'sync',
    requestDigest: 'a'.repeat(64), policyDigest: 'b'.repeat(64), manifestDigest: '',
    prefix: '.codeflare/operators/activity/session/sync/', filePrefix: 'Operators/', deadline: Date.now() + 60_000 };
  const manifest = { schemaVersion: 1, activityId: expected.activityId, sessionId: expected.sessionId,
    operationId: expected.operationId, requestDigest: expected.requestDigest, policyDigest: expected.policyDigest,
    files: [{ path: 'result.txt', size: content.byteLength, sha256: await sha256(content) }], ...patch };
  const bytes = encode(manifest);
  expected.manifestDigest = await sha256(bytes);
  const objects = new Map<string, Uint8Array>([[`${expected.prefix}manifest.json`, bytes], [`${expected.filePrefix}result.txt`, content]]);
  const reads: string[] = [];
  const read = async (key: string, maxBytes: number) => {
    reads.push(key);
    const value = objects.get(key);
    if (value && value.byteLength > maxBytes) throw new Error('Fixture bounded reader rejected oversized object');
    return value ?? null;
  };
  return { expected, objects, read, reads, manifest };
}

describe('REQ-OPERATOR-024: independently verified sync bytes', () => {
  it('verifies the final manifest and actual stored file bytes for the exact operation', async () => {
    const f = await fixture();
    expect(await verifyOperatorSync(f.expected, f.read)).toEqual({ manifestDigest: f.expected.manifestDigest,
      filesVerified: 1, bytesVerified: new TextEncoder().encode('durable marker').byteLength });
    expect(f.reads).toEqual([`${f.expected.prefix}manifest.json`, `${f.expected.filePrefix}result.txt`]);
  });

  it.each(['activityId', 'sessionId', 'operationId', 'requestDigest', 'policyDigest'])
  ('rejects another %s before reading output objects', async field => {
    const f = await fixture({ [field]: field.endsWith('Digest') ? 'c'.repeat(64) : 'other' });
    await expect(verifyOperatorSync(f.expected, f.read)).rejects.toBeInstanceOf(ValidationError);
    expect(f.reads).toEqual([`${f.expected.prefix}manifest.json`]);
  });

  it.each(['../escape', '/absolute', 'a/../escape', 'a\\escape', 'a/%2e%2e/escape'])
  ('rejects unsafe relative output path %s before file reads', async path => {
    const f = await fixture({ files: [{ path, size: 0, sha256: 'a'.repeat(64) }] });
    await expect(verifyOperatorSync(f.expected, f.read)).rejects.toBeInstanceOf(ValidationError);
    expect(f.reads).toEqual([`${f.expected.prefix}manifest.json`]);
  });

  it.each(['manifest.json', 'result.txt'])('rejects missing stored %s instead of trusting daemon success', async path => {
    const f = await fixture();
    f.objects.delete(`${path === 'manifest.json' ? f.expected.prefix : f.expected.filePrefix}${path}`);
    await expect(verifyOperatorSync(f.expected, f.read)).rejects.toBeInstanceOf(ValidationError);
  });

  it.each(['manifest.json', 'result.txt'])('rejects changed stored %s bytes', async path => {
    const f = await fixture();
    f.objects.set(`${path === 'manifest.json' ? f.expected.prefix : f.expected.filePrefix}${path}`,
      new TextEncoder().encode('changed'));
    await expect(verifyOperatorSync(f.expected, f.read)).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects duplicate paths and excessive declared output before file reads', async () => {
    const file = { path: 'result.txt', size: 1, sha256: 'a'.repeat(64) };
    for (const files of [[file, file], [{ ...file, size: 8 * 1024 * 1024 + 1 }]]) {
      const f = await fixture({ files });
      await expect(verifyOperatorSync(f.expected, f.read)).rejects.toBeInstanceOf(ValidationError);
      expect(f.reads).toEqual([`${f.expected.prefix}manifest.json`]);
    }
  });

  it('rejects expired authority before protected storage reads', async () => {
    const f = await fixture();
    await expect(verifyOperatorSync({ ...f.expected, deadline: 1 }, f.read)).rejects.toBeInstanceOf(ValidationError);
    expect(f.reads).toEqual([]);
  });
});


describe('REQ-OPERATOR-024 AC1: production R2 reader bounds bytes while consuming', () => {
  async function reader(response: Response) {
    vi.stubGlobal('fetch', async () => response);
    return createOperatorSyncReader({ R2_ACCOUNT_ID: 'fixture-account' } as Env, 'owner', {
      r2AccessKeyId: 'fixture-access', r2SecretAccessKey: 'fixture-secret', r2SseDisabled: true,
    } as OperatorSessionBootstrap);
  }
  it.each([undefined, '1'])('cancels an oversized stream with content-length %s before EOF', async length => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(5)); },
      cancel() { cancelled = true; },
    });
    const read = await reader(new Response(body, { headers: length ? { 'content-length': length } : {} }));
    await expect(read('Operators/result.txt', 8)).rejects.toThrow();
    expect(cancelled).toBe(true);
  });
  it('accepts exact-limit bytes and distinguishes missing objects', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    expect(await (await reader(new Response(bytes)))('Operators/result.txt', 4)).toEqual(bytes);
    expect(await (await reader(new Response(null, { status: 404 })))('Operators/missing', 4)).toBeNull();
  });
});
