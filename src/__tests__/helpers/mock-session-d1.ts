import type { MockKV } from './mock-kv';

function row(ownerKey: string, session: Record<string, any>): Record<string, unknown> {
  return {
    owner_key: ownerKey,
    session_id: session.id,
    name: session.name ?? 'Session',
    created_at: session.createdAt ?? new Date(0).toISOString(),
    last_accessed_at: session.lastAccessedAt ?? session.createdAt ?? new Date(0).toISOString(),
    agent_type: session.agentType ?? null,
    workspace: session.workspace ?? 'terminal',
    terminal_mode: session.terminalMode ?? 'classic',
    tab_config_json: session.tabConfig ? JSON.stringify(session.tabConfig) : null,
    clone_json: session.clone ? JSON.stringify(session.clone) : null,
    lifecycle_state: session.status === 'initializing' ? 'starting' : (session.status ?? 'running'),
    lifecycle_generation: session.lifecycleGeneration ?? 0,
    response_revision: session.responseRevision ?? 0,
    observation_sequence: session.observationSequence ?? -1,
    last_started_at: session.lastStartedAt ?? null,
    last_active_at: session.lastActiveAt ?? null,
    editor_ready: session.editorReady ? 1 : 0,
    editor_ready_error: session.editorReadyError ? 1 : 0,
    cpu: session.metrics?.cpu ?? null,
    memory: session.metrics?.mem ?? null,
    disk: session.metrics?.hdd ?? null,
    sync_status: session.metrics?.syncStatus ?? null,
    metrics_observed_at: session.metrics?.updatedAt ?? null,
    last_input_at: session.lastInputAt ?? null,
    unreachable_incident_id: session.unreachableIncidentId ?? null,
    unreachable_first_observed_at: session.unreachableFirstObservedAt ?? null,
    unreachable_deadline_ms: session.unreachableDeadlineMs ?? null,
    termination_intent_id: session.terminationIntentId ?? null,
    termination_generation: session.terminationGeneration ?? null,
  };
}

export function createMockSessionD1(kv: MockKV): D1Database {
  const key = (owner: unknown, id: unknown) => `session:${String(owner)}:${String(id)}`;
  async function get(owner: unknown, id: unknown): Promise<Record<string, any> | null> {
    return await kv.get(key(owner, id), 'json') as Record<string, any> | null;
  }
  async function put(owner: unknown, session: Record<string, any>): Promise<void> {
    await kv.put(key(owner, session.id), JSON.stringify(session), { metadata: { s: session.status === 'running' ? 'r' : session.status === 'starting' || session.status === 'initializing' ? 'i' : 's' } });
  }
  async function list(owner: unknown): Promise<Array<Record<string, unknown>>> {
    const found = await kv.list({ prefix: `session:${String(owner)}:` });
    const rows: Array<Record<string, unknown>> = [];
    for (const item of found.keys) {
      const session = await kv.get(item.name, 'json') as Record<string, any> | null;
      if (session) rows.push(row(String(owner), session));
    }
    return rows.sort((a, b) => String(b.last_accessed_at).localeCompare(String(a.last_accessed_at)) || String(a.session_id).localeCompare(String(b.session_id)));
  }

  return {
    prepare(sql: string) {
      let args: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) { args = values; return statement; },
        async first() {
          if (sql.includes('SELECT state FROM session_cutover')) return { state: 'complete' };
          if (sql.includes('runtime_sessions')) {
            const session = await get(args[0], args[1]);
            return session ? row(String(args[0]), session) : null;
          }
          return null;
        },
        async all() {
          if (sql.includes('runtime_sessions')) return { results: await list(args[0]) };
          return { results: [] };
        },
        async run() {
          if (sql.includes('INSERT INTO runtime_sessions')) {
            const session = { id: args[1], name: args[2], createdAt: args[3], lastAccessedAt: args[4], agentType: args[5] ?? undefined, workspace: args[6], terminalMode: args[7], tabConfig: args[8] ? JSON.parse(String(args[8])) : undefined, clone: args[9] ? JSON.parse(String(args[9])) : undefined, status: 'stopped' };
            await put(args[0], session); return { success: true, meta: { changes: 1 } };
          }
          if (sql.includes('DELETE FROM runtime_sessions')) {
            if (args.length === 1) { const found = await kv.list({ prefix: `session:${String(args[0])}:` }); for (const x of found.keys) await kv.delete(x.name); return { success: true, meta: { changes: found.keys.length } }; }
            const exists = await get(args[0], args[1]); if (exists) await kv.delete(key(args[0], args[1])); return { success: true, meta: { changes: exists ? 1 : 0 } };
          }
          const session = await get(args[0], args[1]);
          if (!session) return { success: true, meta: { changes: 0 } };
          if (/SET\s+lifecycle_state='starting'/.test(sql)) { session.status = 'starting'; session.lifecycleGeneration = (session.lifecycleGeneration ?? 0) + 1; }
          else if (/SET\s+lifecycle_state='stopping'/.test(sql)) { session.status = 'stopping'; session.terminationIntentId = args[2]; session.terminationGeneration = session.lifecycleGeneration ?? 0; }
          else if (/SET\s+lifecycle_state='stopped'/.test(sql)) { session.status = 'stopped'; session.terminationIntentId = undefined; session.terminationGeneration = undefined; }
          else if (sql.includes('lifecycle_state=COALESCE')) {
            if (args[4] != null) session.status = args[4];
            session.lastInputAt = args[5] ?? session.lastInputAt;
            session.metrics = { cpu: args[6] ?? undefined, mem: args[7] ?? undefined, hdd: args[8] ?? undefined, syncStatus: args[9] ?? undefined, updatedAt: args[12] };
            session.editorReady = args[10] === 1;
            session.editorReadyError = args[11] === 1;
            session.observationSequence = args[3];
          }
          if (sql.includes('name=COALESCE')) { if (args[2] != null) session.name = args[2]; if (args[3] != null) session.tabConfig = JSON.parse(String(args[3])); session.lastAccessedAt = args[4]; }
          if (sql.includes('last_accessed_at=?3')) session.lastAccessedAt = args[2];
          await put(args[0], session);
          return { success: true, meta: { changes: 1 } };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
}
