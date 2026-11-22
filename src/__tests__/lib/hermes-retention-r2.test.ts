import { expect, it, vi } from 'vitest';
import type { Env } from '../../types';
import { hermesRetentionR2 } from '../../lib/hermes-retention-r2';
import { HERMES_MARKDOWN } from '../../lib/hermes-retention';

const send = vi.hoisted(() => vi.fn<typeof fetch>());
vi.mock('aws4fetch', () => ({ AwsClient: class { fetch = send; } }));

const root = 'Vault/Memory/Sessions/';
const victim = `${root}session1234/`;
const fixtureEnv = { R2_ACCESS_KEY_ID: 'fixture', R2_SECRET_ACCESS_KEY: 'fixture' } as Env;
const list = (keys: string[], empty?: string) => new Response(`<ListBucketResult><IsTruncated>false</IsTruncated>`
  + `<KeyCount>${keys.length}</KeyCount>` + keys.map(key => `<Contents><Key>${key}</Key>`
  + `<Size>${key === empty ? 0 : 1}</Size><LastModified>2026-11-22T00:00:00Z</LastModified><ETag>fixture</ETag></Contents>`).join('')
  + '</ListBucketResult>');

it('REQ-MEM-042 AC4: whole-prefix R2 deletion leaves sibling stores and shared files intact', async () => {
  const files = new Set([`${victim}global/MEMORY.md`, `${victim}Projects/workspace/MEMORY.md`, `${victim}checkpoint.json`,
    `${root}session1234extra/checkpoint.json`, 'Vault/Memory/MEMORY.md']);
  send.mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (init?.method !== 'DELETE') return list([...files].filter(key => key.startsWith(url.searchParams.get('prefix') ?? '')));
    files.delete(decodeURIComponent(url.pathname.slice('/test-bucket/'.length)));
    return new Response(null, { status: 204 });
  });
  const bucket = hermesRetentionR2(fixtureEnv, 'https://fixture.example', 'test-bucket', true, new AbortController().signal);
  expect(await bucket.evict(`${root}session1234`)).toBe(false);
  expect(files.size).toBe(5);
  expect(await bucket.evict(victim)).toBe(true);
  expect(await bucket.prefixEmpty(victim)).toBe(true);
  expect([...files]).toEqual([`${root}session1234extra/checkpoint.json`, 'Vault/Memory/MEMORY.md']);
});

it('REQ-MEM-042 AC2: recency follows Markdown write metadata, not provider rewrite or marker time', async () => {
  const objects = [...HERMES_MARKDOWN.map(name => `${victim}${name}`), `${victim}session-id`];
  const writtenAt = '1795300000000';
  send.mockImplementation(async input => {
    const url = new URL(String(input));
    if (url.searchParams.has('list-type')) return list(objects);
    expect(objects.slice(0, -1)).toContain(decodeURIComponent(url.pathname.slice('/test-bucket/'.length)));
    return new Response('Actual Markdown', { headers: {
      'Last-Modified': 'Sat, 31 Dec 2027 00:00:00 GMT',
      'x-amz-meta-codeflare-hermes-written-at': writtenAt,
    } });
  });
  const bucket = hermesRetentionR2(fixtureEnv, 'https://fixture.example', 'test-bucket', true, new AbortController().signal);
  const observation = (await bucket.inventory()).get('session1234');
  expect(observation?.map(file => file.updatedAt)).toEqual(HERMES_MARKDOWN.map(() => Number(writtenAt)));
});

it.each(['', 'unexpected contents'])('REQ-MEM-042 AC2: an SSE-C store observes only proven-empty default-encrypted Markdown (%s)', async (body) => {
  const empty = `${victim}global/MEMORY.md`;
  const objects = [...HERMES_MARKDOWN.map(name => `${victim}${name}`), `${victim}session-id`];
  const writtenAt = '1795300000000';
  send.mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.searchParams.has('list-type')) return list(objects, empty);
    const headers = new Headers(init?.headers);
    const key = decodeURIComponent(url.pathname.slice('/test-bucket/'.length));
    if (headers.get('If-Match') !== '"fixture"') return new Response(null, { status: 412 });
    if (key === empty && headers.has('x-amz-server-side-encryption-customer-key')) return new Response(null, { status: 400 });
    return new Response(key === empty ? body : 'a', { headers: {
      'content-length': key === empty ? '0' : '1',
      'x-amz-meta-codeflare-hermes-written-at': writtenAt,
    } });
  });
  const bucket = hermesRetentionR2({ ...fixtureEnv, ENCRYPTION_KEY: btoa('a'.repeat(32)) },
    'https://fixture.example', 'test-bucket', false, new AbortController().signal);
  if (body) await expect(bucket.inventory()).rejects.toThrow();
  else expect((await bucket.inventory()).get('session1234')).toContainEqual({
    digest: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', updatedAt: Number(writtenAt),
  });
});

it('REQ-MEM-042 AC4: incomplete R2 listings cannot authorize even a partial delete', async () => {
  const existing = `${victim}global/MEMORY.md`;
  const files = new Set([existing]);
  send.mockImplementation(async (input, init) => {
    if (init?.method === 'DELETE') {
      files.delete(decodeURIComponent(new URL(String(input)).pathname.slice('/test-bucket/'.length)));
      return new Response(null, { status: 204 });
    }
    return new Response('<ListBucketResult><IsTruncated>true</IsTruncated>'
      + `<Contents><Key>${existing}</Key><Size>1</Size><LastModified>2026-11-22T00:00:00Z</LastModified></Contents>`
      + '</ListBucketResult>');
  });
  const bucket = hermesRetentionR2(fixtureEnv, 'https://fixture.example', 'test-bucket', true, new AbortController().signal);
  await expect(bucket.evict(victim)).rejects.toThrow();
  await expect(bucket.prefixEmpty(victim)).rejects.toThrow();
  expect([...files]).toEqual([existing]);
});
