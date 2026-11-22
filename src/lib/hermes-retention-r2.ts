import { createHash } from 'node:crypto';
import { readBoundedResponse } from './bounded-stream';
import { SESSION_ID_PATTERN } from './constants';
import { HERMES_MARKDOWN, HERMES_SESSION_ROOT, HERMES_STORE_MARKER, type HermesFileObservation } from './hermes-retention';
import { createR2Client, getR2Url, parseListObjectsXml } from './r2-client';
import { getSseHeaders } from './r2-sse';
import type { Env, StorageListResult } from '../types';

export const HERMES_ADAPTER_KEY = '.pi/agent/extensions/hermes-memory-runtime.ts';

/** R2 operations for the bucket's exact Hermes namespace. Keep listings and
 * reads bounded; absence is authoritative only after a complete listing. */
export function hermesRetentionR2(env: Env, endpoint: string, bucket: string, plain: boolean, signal: AbortSignal) {
  const client = createR2Client(env);
  const headers = getSseHeaders(env, plain);
  const lookup = async (prefix: string): Promise<Map<string, StorageListResult['objects'][number]>> => {
    const url = new URL(getR2Url(endpoint, bucket));
    url.searchParams.set('list-type', '2');
    url.searchParams.set('prefix', prefix);
    const objects = new Map<string, StorageListResult['objects'][number]>();
    const cursors = new Set<string>();
    for (let page = 0; page < 4; page++) {
      const reply = await client.fetch(url, { signal });
      if (!reply.ok) throw new Error('Hermes inventory unavailable');
      const bytes = await readBoundedResponse(reply, 2 * 1024 * 1024, 'Hermes inventory', signal);
      const parsed = parseListObjectsXml(new TextDecoder().decode(bytes), true);
      if (parsed.prefixes.length) throw new Error('Unexpected Hermes inventory prefixes');
      for (const object of parsed.objects) {
        if (!object.key.startsWith(prefix) || objects.has(object.key)) throw new Error('Invalid Hermes object listing');
        objects.set(object.key, object);
      }
      if (!parsed.isTruncated) return objects;
      const cursor = parsed.nextContinuationToken;
      if (!cursor || cursors.has(cursor)) throw new Error('Invalid Hermes inventory cursor');
      cursors.add(cursor);
      url.searchParams.set('continuation-token', cursor);
    }
    throw new Error('Hermes inventory exceeded its page budget');
  };

  const read = async (key: string, limit: number, etag?: string) => {
    const response = await client.fetch(getR2Url(endpoint, bucket, key), {
      headers: { ...headers, ...(etag ? { 'If-Match': etag } : {}) }, signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('Hermes object unavailable');
    }
    return { bytes: await readBoundedResponse(response, limit, 'Hermes object', signal), headers: response.headers };
  };

  const observe = async (id: string, objects: Map<string, StorageListResult['objects'][number]>) => {
    const prefix = `${HERMES_SESSION_ROOT}${id}/`;
    const keys = HERMES_MARKDOWN.map(name => `${prefix}${name}`);
    if (!objects.has(`${prefix}${HERMES_STORE_MARKER}`) || !keys.every(key => objects.get(key)?.etag)) {
      return null;
    }
    // Compare plaintext even for SSE-C, whose ETag is not a content hash.
    return Promise.all(keys.map(async key => {
      const listed = objects.get(key)!;
      const etag = listed.etag!;
      const { bytes, headers: objectHeaders } = await read(key, 4 * 1024 * 1024, etag.startsWith('"') ? etag : `"${etag}"`);
      // The scoped uploader stamps actual byte changes only. Server-side
      // copies (including re-encryption) preserve this user metadata.
      const writtenAt = objectHeaders.get('x-amz-meta-codeflare-hermes-written-at');
      if (!writtenAt || !/^\d{13}$/.test(writtenAt)) throw new Error('Invalid Hermes write time');
      return { digest: createHash('sha256').update(bytes).digest('hex'), updatedAt: Number(writtenAt) };
    }));
  };

  return {
    async observe(id: string) {
      if (!SESSION_ID_PATTERN.test(id)) throw new Error('Invalid Hermes session ID');
      const objects = await lookup(`${HERMES_SESSION_ROOT}${id}/`);
      return objects.size === 0 ? 'absent' as const : observe(id, objects);
    },
    async prefixEmpty(prefix: string) { return (await lookup(prefix)).size === 0; },
    async adapterDigest() {
      return createHash('sha256').update((await read(HERMES_ADAPTER_KEY, 64 * 1024)).bytes).digest('hex');
    },
    async hasCheckpoint(id: string) {
      if (!SESSION_ID_PATTERN.test(id)) throw new Error('Invalid Hermes session ID');
      const key = `${HERMES_SESSION_ROOT}${id}/checkpoint.json`;
      return (await lookup(key)).has(key);
    },
    async inventory(): Promise<Map<string, HermesFileObservation[] | null>> {
      const objects = await lookup(HERMES_SESSION_ROOT);
      const stores = new Set<string>();
      for (const key of objects.keys()) {
        const relative = key.slice(HERMES_SESSION_ROOT.length);
        const slash = relative.indexOf('/');
        if (slash < 0) continue;
        const id = relative.slice(0, slash);
        const name = relative.slice(slash + 1);
        if (SESSION_ID_PATTERN.test(id) && (name === HERMES_STORE_MARKER || HERMES_MARKDOWN.some(path => name === path))) stores.add(id);
      }
      if (stores.size > 10) throw new Error('Too many Hermes stores');
      const inventory = new Map<string, HermesFileObservation[] | null>();
      for (const id of stores) {
        inventory.set(id, await observe(id, objects));
      }
      return inventory;
    },
    async evict(prefix: string): Promise<boolean> {
      if (!prefix.startsWith(HERMES_SESSION_ROOT) || !prefix.endsWith('/')
        || !SESSION_ID_PATTERN.test(prefix.slice(HERMES_SESSION_ROOT.length, -1))) return false;
      const objects = await lookup(prefix);
      for (const key of objects.keys()) {
        const response = await client.fetch(getR2Url(endpoint, bucket, key), { method: 'DELETE', signal });
        await response.body?.cancel();
        if (!response.ok) return false;
      }
      return true;
    },
  };
}
