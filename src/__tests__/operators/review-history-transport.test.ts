import { describe, expect, it } from 'vitest';
import { createAuthenticatedHistoryTransport } from '../../operators/review-history-transport';

const currentHead = 'a'.repeat(40), priorHead = 'b'.repeat(40);
const authority = { repository: 'owner/repo', repositoryId: 138, pullRequest: 34, head: currentHead,
  token: 'parent-only-credential' };
const prior = { marker: 'opaque Review marker', payload: 'x'.repeat(63 * 1024),
  binding: { repositoryId: 138, pullRequest: 34, head: priorHead } };
const stored = new TextEncoder().encode(JSON.stringify(prior));
function zip(name: string, bytes: Uint8Array) {
  const filename = Buffer.from(name);
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); }
  crc = (crc ^ 0xffffffff) >>> 0;
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(bytes.length, 22);
  local.writeUInt16LE(filename.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16); central.writeUInt32LE(bytes.length, 20);
  central.writeUInt32LE(bytes.length, 24); central.writeUInt16LE(filename.length, 28);
  const centralOffset = local.length + filename.length + bytes.length;
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + filename.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, filename, Buffer.from(bytes), central, filename, end]);
}
function fixture(options: { missing?: boolean; unsafe?: boolean; redirect?: string;
  neverFinish?: boolean; revokeAfter?: boolean } = {}) {
  let valid = true;
  const signed = options.redirect ?? 'https://pipelines.actions.githubusercontent.com/signed-artifact';
  const fetch = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.origin === 'https://api.github.com') {
      if (request.headers.get('authorization') !== `Bearer ${authority.token}` || request.redirect !== 'error')
        return Response.json({}, { status: 403 });
      if (options.revokeAfter) valid = false;
      if (url.pathname === '/repos/owner/repo') return Response.json({ id: 138, permissions: { pull: true } });
      if (url.pathname === '/repos/owner/repo/pulls/34') return Response.json({ number: 34, state: 'open',
        head: { sha: currentHead, repo: { id: 138 } }, base: { sha: 'c'.repeat(40), repo: { id: 138 } } });
      if (url.pathname === `/repos/owner/repo/commits/${priorHead}/pulls`)
        return Response.json([{ number: 34, state: 'open', head: { sha: priorHead } }]);
      if (url.pathname === '/repos/owner/repo/issues/34/comments') {
        if (options.missing && Number(url.searchParams.get('page')) === 2) return Response.json({}, { status: 503 });
        return Response.json(Array.from({ length: options.missing ? 100 : 1 }, (_, id) => ({ id: id + 1,
          body: 'opaque prior comment', user: { id: 777 } })));
      }
      if (url.pathname === '/repos/owner/repo/actions/artifacts/701') return Response.json({ id: 701,
        expired: false, workflow_run: { id: 7, repository_id: 138, head_sha: priorHead } });
      if (url.pathname === '/repos/owner/repo/actions/runs/7') return Response.json({ id: 7, run_attempt: 1,
        workflow_id: 531, repository: { id: 138 }, event: 'pull_request_target', pull_requests: [{ number: 34 }] });
      if (url.pathname === '/repos/owner/repo/actions/artifacts/701/zip')
        return new Response(null, { status: 302, headers: { location: signed } });
      return Response.json({}, { status: 404 });
    }
    if (url.href === signed) {
      // A redirected GitHub bearer must never reach the signed artifact origin.
      if (request.headers.has('authorization')) return Response.json({}, { status: 401 });
      return new Response(Uint8Array.from(zip(options.unsafe ? '../review.json' : 'review.json', stored)));
    }
    return Response.json({}, { status: 403 });
  };
  const transport = createAuthenticatedHistoryTransport({ ...authority, fetch,
    current: async () => { if (!valid) throw Error('Activity drive revoked'); } });
  return { transport, revoke: () => { valid = false; } };
}

describe('REQ-OPERATOR-050/056: parent-only fixed GitHub history reads', () => {
  it('returns an opaque prior comment, without parsing Review marker or moving GitHub authority to the child', async () => {
    const { transport } = fixture();
    expect(await transport.read({ schemaVersion: 1, operation: 'comments-page', page: 1 }))
      .toMatchObject({ complete: true, value: [{ id: 1, body: 'opaque prior comment' }] });
    expect(JSON.stringify(await transport.read({ schemaVersion: 1, operation: 'run', id: 7 })))
      .not.toContain(authority.token);
  });

  it('reads a valid near-limit prior artifact by ID after an authenticated run and a bearer-free signed redirect', async () => {
    const { transport } = fixture();
    const result = await transport.read({ schemaVersion: 1, operation: 'artifact', id: 701 });
    expect(result).toMatchObject({ complete: true, value: { id: 701, runId: 7 } });
    expect(Buffer.from(result.value.bytes, 'base64')).toEqual(Buffer.from(stored));
  });

  it('fails closed on missing pages, expired drive, invalid redirects and unsafe archive members', async () => {
    const missing = fixture({ missing: true }).transport;
    expect(await missing.read({ schemaVersion: 1, operation: 'comments-page', page: 1 }))
      .toMatchObject({ complete: true });
    expect(await missing.read({ schemaVersion: 1, operation: 'comments-page', page: 2 }))
      .toMatchObject({ complete: false });
    expect(await fixture({ revokeAfter: true }).transport.read({ schemaVersion: 1,
      operation: 'comments-page', page: 1 })).toMatchObject({ complete: false });
    expect(await fixture({ redirect: 'http://attacker.example/zip' }).transport.read({ schemaVersion: 1,
      operation: 'artifact', id: 701 })).toMatchObject({ complete: false });
    expect(await fixture({ unsafe: true }).transport.read({ schemaVersion: 1,
      operation: 'artifact', id: 701 })).toMatchObject({ complete: false });
  });

  it('rejects arbitrary path/repository, excess page or aggregate-byte authority instead of returning partial green', async () => {
    const { transport, revoke } = fixture();
    for (const body of [{ schemaVersion: 1, operation: 'comments-page', page: 21 },
      { schemaVersion: 1, operation: 'run', id: 0 },
      { schemaVersion: 1, operation: 'comment', id: 501, repository: 'attacker/other' }]) {
      expect(await transport.read(body)).toMatchObject({ complete: false });
    }
    revoke();
    expect(await transport.read({ schemaVersion: 1, operation: 'artifact', id: 701 }))
      .toMatchObject({ complete: false });
    const bounded = fixture().transport;
    expect(await bounded.read({ schemaVersion: 1, operation: 'artifact', id: 701 }))
      .toMatchObject({ complete: true });
    let exhausted = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      const read = await bounded.read({ schemaVersion: 1, operation: 'artifact', id: 701 });
      if (!read.complete) { exhausted = true; break; }
    }
    expect(exhausted).toBe(true);
  });
});
