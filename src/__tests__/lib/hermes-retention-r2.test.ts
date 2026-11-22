import { expect, it, vi } from 'vitest';
import type { Env } from '../../types';
import { hermesRetentionR2 } from '../../lib/hermes-retention-r2';
import { HERMES_MARKDOWN } from '../../lib/hermes-retention';

const send = vi.hoisted(() => vi.fn<typeof fetch>());
vi.mock('aws4fetch', () => ({ AwsClient: class { fetch = send; } }));

const root = 'Vault/Memory/Sessions/';
const victim = `${root}session1234/`;
const fixtureEnv = { R2_ACCESS_KEY_ID: 'fixture', R2_SECRET_ACCESS_KEY: 'fixture' } as Env;
const list = (keys: string[]) => new Response(`<ListBucketResult><IsTruncated>false</IsTruncated>`
  + `<KeyCount>${keys.length}</KeyCount>` + keys.map(key => `<Contents><Key>${key}</Key>`
  + '<Size>1</Size><LastModified>2026-11-22T00:00:00Z</LastModified><ETag>fixture</ETag></Contents>').join('')
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
