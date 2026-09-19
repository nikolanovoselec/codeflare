import { getSessionPrefix } from './kv-keys';

export interface CutoverKv {
  list(options: { prefix: string; cursor?: string }): Promise<{ keys: Array<{ name: string; metadata?: unknown }>; list_complete: boolean; cursor?: string }>;
  delete(key: string): Promise<void>;
}

/** One-time, operator-authorized exact-prefix purge. Ordinary deploys never call this. */
export async function runSessionCutover(input: {
  db: D1Database;
  kv: CutoverKv;
  bucketNames: readonly string[];
  quiescentConfirmed: boolean;
  now?: string;
}): Promise<{ deleted: number }> {
  if (!input.quiescentConfirmed) throw new Error('Operator-confirmed quiescence is required');
  const marker = await input.db.prepare('SELECT state FROM session_cutover WHERE id=1').first<{ state: string }>();
  if (!marker) throw new Error('Session cutover migration is not applied');
  if (marker.state === 'complete') return { deleted: 0 };

  const names: string[] = [];
  for (const bucketName of input.bucketNames) {
    const prefix = getSessionPrefix(bucketName);
    let cursor: string | undefined;
    do {
      const page = await input.kv.list({ prefix, ...(cursor ? { cursor } : {}) });
      for (const key of page.keys) {
        if (!key.name.startsWith(prefix)) throw new Error('KV returned a key outside the exact session prefix');
        const metadata = key.metadata as { s?: string } | null | undefined;
        if (metadata?.s === 'r' || metadata?.s === 'i' || metadata?.s === 'running' || metadata?.s === 'initializing') {
          throw new Error(`Legacy workload metadata is not quiescent: ${key.name}`);
        }
        names.push(key.name);
      }
      cursor = page.list_complete ? undefined : page.cursor;
      if (!page.list_complete && !cursor) throw new Error('Incomplete KV listing omitted its cursor');
    } while (cursor);
  }

  for (const name of names) await input.kv.delete(name);
  const remaining = await input.db.prepare('SELECT COUNT(*) AS count FROM runtime_sessions').first<{ count: number }>();
  if ((remaining?.count ?? 0) !== 0) throw new Error('D1 session dashboard is not empty');
  const now = input.now ?? new Date().toISOString();
  const completed = await input.db.prepare("UPDATE session_cutover SET state='complete', updated_at=?1, completed_at=?1 WHERE id=1 AND state='pending'").bind(now).run();
  if (completed.meta.changes !== 1) throw new Error('Session cutover completion was not claimed');
  return { deleted: names.length };
}
