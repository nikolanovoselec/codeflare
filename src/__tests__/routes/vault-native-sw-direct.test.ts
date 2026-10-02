import { describe, it, expect } from 'vitest';
import { nativeWorkerRuntime } from '../helpers/native-worker-runtime';

// CF-045
// Direct unit tests for src/routes/vault/native-sw.ts. The graft logic was
// previously exercised only through the src/routes/vault/index.ts re-export barrel.
// Importing the source module directly pins the key-recovery graft and its
// anchor-drift guard at the module boundary.
import {
  graftVaultKeyRecovery,
  VAULT_NATIVE_SW_SHA256,
  VAULT_NATIVE_SW_VERBATIM,
  VAULT_NATIVE_SERVICE_WORKER_JS,
} from '../../routes/vault/native-sw';

describe('CF-045: vault-native-sw direct unit tests', () => {
  // REQ-VAULT-017 AC1: native SW served with the codeflare key-recovery graft
  it('grafting the verbatim worker reproduces the exported served worker', () => {
    expect(graftVaultKeyRecovery(VAULT_NATIVE_SW_VERBATIM)).toBe(VAULT_NATIVE_SERVICE_WORKER_JS);
  });

  it('the graft injects the __cfRecover helper that the verbatim worker lacks', () => {
    expect(VAULT_NATIVE_SW_VERBATIM).not.toContain('__cfRecover');
    expect(VAULT_NATIVE_SERVICE_WORKER_JS).toContain('async function __cfRecover()');
  });

  async function runInstallPrecache(sw: string) {
    const marker = 'self.addEventListener("install",o=>{';
    const start = sw.indexOf(marker);
    const end = sw.indexOf('});self.addEventListener("activate"', start);
    if (start < 0 || end < 0) throw new Error('install precache handler not found');
    const body = sw.slice(start + marker.length, end);
    const requests: Array<{ url: string; cache?: string }> = [];
    let install: Promise<void> | undefined;
    class CapturedRequest {
      url: string;
      cache?: string;

      constructor(url: string, options?: { cache?: string }) {
        this.url = url;
        this.cache = options?.cache;
      }
    }
    const listener = new Function(
      'self',
      'caches',
      'De',
      'gt',
      'Request',
      'console',
      `return (o)=>{${body}};`,
    )(
      { skipWaiting: async () => {} },
      { open: async () => ({ addAll: async (values: Array<{ url: string; cache?: string }>) => requests.push(...values) }) },
      'cache-v1',
      { shell: '/', app: '/app.js' },
      CapturedRequest,
      { log: () => {} },
    ) as (event: { waitUntil(promise: Promise<void>): void }) => void;
    listener({ waitUntil(promise) { install = promise; } });
    if (!install) throw new Error('install handler did not register async work');
    await install;
    return requests;
  }

  it('REQ-VAULT-017 AC4: install precaching bypasses stale browser cache entries', async () => {
    const requests = await runInstallPrecache(VAULT_NATIVE_SERVICE_WORKER_JS);
    expect(requests).toEqual([
      { url: '/', cache: 'reload' },
      { url: '/app.js', cache: 'reload' },
    ]);
  });

  const aesKey = btoa('a'.repeat(32));
  const config = { enableClientEncryption: true, spaceFolderPath: '/vault', syncDocuments: true, syncIgnore: '' };
  function servedRuntime(recover: () => Promise<Response> = async () => Response.json({ key: aesKey })) {
    const requests: Array<{ url: string; credentials?: RequestCredentials }> = [];
    const runtime = nativeWorkerRuntime(VAULT_NATIVE_SERVICE_WORKER_JS, async (input, options) => {
      const url = input instanceof Request ? input.url : String(input);
      requests.push({ url, credentials: options?.credentials });
      if (url === 'https://vault.test/.vault-key') return recover();
      if (url === '/.fs') return Response.json([]);
      throw new Error(`Unexpected native worker transport: ${url}`);
    });
    return { ...runtime, requests };
  }

  it('REQ-VAULT-024 AC5: an encryption-key query recovers and returns the server AES key through the registered handler', async () => {
    const runtime = servedRuntime();
    expect(await runtime.message({ type: 'get-encryption-key' })).toEqual([{ type: 'encryption-key', key: aesKey }]);
    expect(runtime.requests).toEqual([{ url: 'https://vault.test/.vault-key', credentials: 'same-origin' }]);
  });

  it('REQ-VAULT-024 AC5: config recovers AES and configures encrypted storage through the registered handler', async () => {
    const runtime = servedRuntime();
    expect(await runtime.message({ type: 'config', config })).toEqual([]); // config has no key reply
    expect(await runtime.message({ type: 'get-encryption-key' })).toEqual([{ type: 'encryption-key', key: aesKey }]);
    // Intentional native database identity: scope, space and recovered key bind storage.
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`/vault:https://vault.test:${aesKey}`));
    const name = `sb_files_${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
    // Public logout preparation reports the configured sync database, not a private router field.
    expect(await runtime.message({ type: 'logout-sync', id: 'configured' })).toEqual([{ ok: true, databases: [name] }]);
    expect(await runtime.message({ type: 'logout-cancel', id: 'configured' })).toEqual([]);
    await runtime.message({ type: 'shutdown' });
  });

  it.each(['get-encryption-key', 'config'])('REQ-VAULT-024 AC5: real logout generation transition during pending %s recovery fences publication and configuration', async type => {
    let release!: (response: Response) => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<Response>(resolve => { release = resolve; });
    const runtime = servedRuntime(() => { entered(); return pending; });
    const recovery = runtime.message({ type, config });
    await started;
    expect(await runtime.message({ type: 'logout-force' })).toEqual([{ ok: true }]);
    expect(runtime.isRegistered()).toBe(false);
    release(Response.json({ key: aesKey }));
    expect(await recovery).toEqual([]);
    expect(await runtime.message({ type: 'get-encryption-key' })).toEqual([]);
    expect([...runtime.databases.keys()]).toEqual([]);
  });

  it('REQ-VAULT-024 AC5: real logout preparation and cancellation suppress pending recovery without inventing logout state', async () => {
    let release!: (response: Response) => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<Response>(resolve => { release = resolve; });
    const runtime = servedRuntime(() => { entered(); return pending; });
    const recovery = runtime.message({ type: 'get-encryption-key' });
    await started;
    expect(await runtime.message({ type: 'logout-sync', id: 'pending' })).toEqual([{ ok: true, databases: [] }]);
    release(Response.json({ key: aesKey }));
    expect(await recovery).toEqual([]);
    await runtime.message({ type: 'logout-cancel', id: 'pending' });
    expect(await runtime.message({ type: 'get-encryption-key' })).toEqual([{ type: 'encryption-key', key: aesKey }]);
  });

  it('REQ-VAULT-025: served worker drops no-client info spam and downgrades expected auth/sync startup noise', async () => {
    const worker = VAULT_NATIVE_SERVICE_WORKER_JS;
    const logs: string[] = [];
    const output = {
      info: () => logs.push('info'),
      error: () => logs.push('error'),
      warn: () => logs.push('warn'),
    };
    const received: unknown[] = [];
    const clients: Array<{ postMessage(value: unknown): void }> = [];
    const start = worker.indexOf('function b(o){');
    const end = worker.indexOf('var Ei=', start);
    const broadcast = new Function('self', 'console', `${worker.slice(start, end)}return b;`)(
      { clients: { matchAll: async () => clients } }, output,
    );
    broadcast({ type: 'auth-error', message: 'AUTH_GATE', actionOrRedirectHeader: '.auth' });
    await Promise.resolve();
    expect(logs).toEqual([]);

    clients.push({ postMessage(value) { received.push(value); } });
    const callbackEnd = worker.indexOf('},void 0,d,"sync")');
    const callbackStart = worker.lastIndexOf('(f,y)=>{', callbackEnd) + '(f,y)=>{'.length;
    for (const [error, expectedLevel, configured] of [
      ['AUTH_GATE', 'info', false], ['UNEXPECTED_FAILURE', 'error', true],
    ] as const) {
      logs.length = 0;
      received.length = 0;
      const router = { configured: true, reset() { this.configured = false; } };
      const proxyError = new Function('console', 'se', 'g', 'b', `return (f,y)=>{${worker.slice(callbackStart, callbackEnd)}};`)(
        output, { message: 'AUTH_GATE' }, router, broadcast,
      );
      proxyError(error, '.auth');
      await Promise.resolve();
      expect(logs).toEqual([expectedLevel]);
      expect(router.configured).toBe(configured);
      // Intentional auth-error wire envelope is preserved through the real broadcaster.
      expect(received).toEqual([{ type: 'auth-error', message: error, actionOrRedirectHeader: '.auth' }]);
    }
    logs.length = 0;
    const syncStart = worker.indexOf('console.warn("Sync space error",');
    const syncEnd = worker.indexOf('}', syncStart);
    new Function('console', 'n', worker.slice(syncStart, syncEnd))(output, new Error('retry'));
    expect(logs).toEqual(['warn']);
    expect(() => graftVaultKeyRecovery('invalid upstream artifact')).toThrow(/anchor/);
  });

  it('REQ-VAULT-024 AC4 / REQ-VAULT-025 AC4: the served worker retains real AES across the registered zero-client interval', async () => {
    const runtime = servedRuntime(async () => new Response(null, { status: 403 }));
    expect(await runtime.message({ type: 'set-encryption-key', key: aesKey })).toEqual([{ type: 'encryption-key-set' }]);
    await runtime.noClientInterval();
    expect(await runtime.message({ type: 'get-encryption-key' })).toEqual([{ type: 'encryption-key', key: aesKey }]);
    expect(runtime.requests).toEqual([]); // retained AES, not a successful recovery hiding a wipe
  });

  it('the verbatim worker loses real AES across its registered zero-client interval', async () => {
    const runtime = nativeWorkerRuntime(VAULT_NATIVE_SW_VERBATIM, async () => { throw new Error('No external recovery allowed'); });
    await runtime.message({ type: 'set-encryption-key', key: aesKey });
    await runtime.noClientInterval();
    expect(await runtime.message({ type: 'get-encryption-key' })).toEqual([{ type: 'encryption-key', key: undefined }]);
  });

  it('throws when an anchor substring is missing (SilverBullet version drift guard)', () => {
    expect(() => graftVaultKeyRecovery('not the silverbullet worker at all')).toThrow(
      /anchor/i,
    );
  });

  it('the served worker differs from the verbatim upstream bytes', () => {
    expect(VAULT_NATIVE_SERVICE_WORKER_JS).not.toBe(VAULT_NATIVE_SW_VERBATIM);
  });

  // REQ-VAULT-025 AC2 / REQ-VAULT-023 AC2: the graft GUARDS the remote
  // `fetchFileList()` result. It normalizes a non-array (transient proxy error or a
  // stray CF Access 302 HTML body) to [], then ABORTS the sync cycle (throws) when the
  // remote list is empty while the persistent local store or snapshot is non-empty —
  // i.e. the in-container SilverBullet server is not yet serving. That stops the
  // reconciler from treating "server not ready" as "every file deleted on secondary"
  // and wiping the bucket-stable local store on a 2nd-session start. A genuinely empty
  // vault (empty primary AND empty snapshot) stays a safe no-op.

  // Build a runnable approximation of the worker's full-sync-cycle remote-list
  // consumer chain straight out of the SERVED worker string, so the tests exercise the
  // ACTUAL grafted bytes. The guard reads `s` (already-bound primary list) and `t` (the
  // snapshot param of the enclosing `syncFiles(t)`); `t` is threaded in as a closure arg.
  function makeSyncCycleRunner(sw: string) {
    const start = sw.indexOf('a=await this.primary.fetchFileList()');
    const endMarker = 'l=new Map(s.map(u=>[u.name,u]))';
    const endIdx = sw.indexOf(endMarker, start);
    if (start < 0 || endIdx < 0) {
      throw new Error('full-sync-cycle remote-list consumer chain not found in served worker');
    }
    const chain = sw.slice(start, endIdx + endMarker.length);
    // eslint-disable-next-line no-new-func
    const fn = new Function('t', `return (async function(){
      let a,s,c,r,l;
      ${chain};
      return { candidateCount: c.size, remoteMapCount: l.size };
    });`) as unknown as (
      t: unknown,
    ) => (this: unknown) => Promise<{ candidateCount: number; remoteMapCount: number }>;
    return (
      remoteList: unknown,
      opts: { primaryList?: Array<{ name: string }>; snapshot?: Map<string, unknown> } = {},
    ) => {
      // Stub the space-sync instance the chain runs against: primary = the persistent
      // browser-local store, secondary = remote (the value under test), `t` = the sync
      // snapshot. getNonSyncCandidates mirrors the worker's own forEach-based impl.
      const { primaryList = [], snapshot = new Map<string, unknown>() } = opts;
      const ctx = {
        primary: { fetchFileList: async () => primaryList, deleteFile: async () => {} },
        secondary: { fetchFileList: async () => remoteList },
        options: { isSyncCandidate: () => false },
        getNonSyncCandidates(list: Array<{ name: string }>) {
          const i = new Map<string, { name: string }>();
          list.forEach((n) => {
            if (!this.options.isSyncCandidate()) i.set(n.name, n);
          });
          return i;
        },
      };
      return fn({ files: snapshot }).call(ctx);
    };
  }

  it('the served sync cycle iterates a real remote array normally', async () => {
    const run = makeSyncCycleRunner(VAULT_NATIVE_SERVICE_WORKER_JS);
    const result = await run([{ name: 'a.md' }, { name: 'b.md' }]);
    expect(result.candidateCount).toBe(2);
    expect(result.remoteMapCount).toBe(2);
  });

  it('the served sync cycle no-ops (no throw, zero candidates) on a non-array remote list when the local store is empty', async () => {
    const run = makeSyncCycleRunner(VAULT_NATIVE_SERVICE_WORKER_JS);
    for (const nonArray of [{ error: 'transient 5xx' }, '<!doctype html>', null, 502]) {
      const result = await run(nonArray);
      expect(result.candidateCount).toBe(0);
      expect(result.remoteMapCount).toBe(0);
    }
  });

  it('the guard is load-bearing: the verbatim (pre-graft) chain throws on a non-array remote list', async () => {
    // Negative control — proves the served no-op above comes from the graft, not
    // from upstream behavior. The pristine verbatim has no `Array.isArray` guard.
    const runVerbatim = makeSyncCycleRunner(VAULT_NATIVE_SW_VERBATIM);
    await expect(runVerbatim({ error: 'transient 5xx' })).rejects.toThrow(/forEach is not a function|is not a function/);

  });

  // REQ-VAULT-023 AC2: a 2nd-session start has a POPULATED persistent local store, but
  // the in-container SilverBullet server is still warming up (~1-2 min) and its
  // `fetchFileList()` returns empty/garbage. The reconciler must NOT treat that as
  // "every file deleted on secondary" and wipe the store — the cycle aborts before any
  // deletion. These run the ACTUAL served bytes, so reverting the graft to a blind
  // coerce (or removing it) makes them fail.
  it('aborts the sync cycle (no deletion) when the remote list is empty while the local store is populated', async () => {
    const run = makeSyncCycleRunner(VAULT_NATIVE_SERVICE_WORKER_JS);
    await expect(
      run([], { primaryList: [{ name: 'Index.md' }, { name: 'CONFIG.md' }] }),
    ).rejects.toThrow();
  });

  it('aborts the sync cycle (no deletion) when the remote list is empty while the snapshot is populated', async () => {
    const run = makeSyncCycleRunner(VAULT_NATIVE_SERVICE_WORKER_JS);
    await expect(
      run([], { snapshot: new Map([['Index.md', [1, 1]]]) }),
    ).rejects.toThrow();
  });

  it('also aborts when the server returns a non-array body while the local store is populated', async () => {
    const run = makeSyncCycleRunner(VAULT_NATIVE_SERVICE_WORKER_JS);
    for (const notReady of [{ error: 'transient 5xx' }, '<!doctype html>', null, 502]) {
      await expect(
        run(notReady, { primaryList: [{ name: 'Index.md' }] }),
      ).rejects.toThrow();
    }
  });

  it('a genuinely empty vault (no local files, no snapshot) is a safe no-op, not an abort', async () => {
    const run = makeSyncCycleRunner(VAULT_NATIVE_SERVICE_WORKER_JS);
    const result = await run([], { primaryList: [], snapshot: new Map() });
    expect(result.candidateCount).toBe(0);
    expect(result.remoteMapCount).toBe(0);
  });

  it('reconciles normally (no abort) when the server returns a real non-empty list, even with a populated store', async () => {
    const run = makeSyncCycleRunner(VAULT_NATIVE_SERVICE_WORKER_JS);
    const result = await run([{ name: 'Index.md' }, { name: 'CONFIG.md' }], {
      primaryList: [{ name: 'Index.md' }],
      snapshot: new Map([['Index.md', [1, 1]]]),
    });
    expect(result.remoteMapCount).toBe(2);
  });

  it('the guard is absent from the verbatim: a populated store + empty remote does NOT abort pre-graft (it would proceed to delete)', async () => {
    // Proves the abort comes from the graft. Verbatim binds `o=[]` (a valid array), the
    // chain completes without throwing, and the downstream per-file reconciler would
    // then delete every populated-store file. The graft is what stops that.
    const runVerbatim = makeSyncCycleRunner(VAULT_NATIVE_SW_VERBATIM);
    const result = await runVerbatim([], { primaryList: [{ name: 'Index.md' }] });
    expect(result.remoteMapCount).toBe(0);
  });

  // REQ-VAULT-025 AC3: the coercion must keep the served worker syntactically
  // valid. `o` is one binding in a single `let s=...,o=...,r=...` declarator list,
  // so coercing by ADDING a second `o=` declarator is a duplicate lexical binding
  // (`Identifier 'o' has already been declared`) that makes the WHOLE worker fail
  // to parse — the browser then refuses to register the SW and the vault never
  // becomes ready. Constructing a Function parses the worker body without executing
  // it; this guards against that whole class of graft-induced parse error. (The
  // pristine verbatim blob is a self-contained IIFE bundle that parses cleanly as a
  // Function body, so any throw here comes from the graft, not the upstream bytes.)
  it('the served worker is syntactically valid JavaScript (graft introduces no parse error)', () => {
    // eslint-disable-next-line no-new-func
    expect(() => new Function(VAULT_NATIVE_SERVICE_WORKER_JS)).not.toThrow();
    // Negative control: the duplicate-`let` form the graft must NOT produce.
    const duplicateLetForm = VAULT_NATIVE_SW_VERBATIM.replace(
      's=await this.secondary.fetchFileList(),c=this.getNonSyncCandidates(s)',
      's=await this.secondary.fetchFileList(),s=Array.isArray(s)?s:[],c=this.getNonSyncCandidates(s)',
    );
    // eslint-disable-next-line no-new-func
    expect(() => new Function(duplicateLetForm)).toThrow(/already been declared|declare a let variable twice/i);
  });

  it('the graft preserves the SHA-256 version guard (verbatim bytes unchanged, no anchor-throw)', async () => {
    // The served worker building without throwing means every anchor (including
    // the new REMOTE_LIST_COERCE anchor) matched the unmodified verbatim bytes.
    expect(() => graftVaultKeyRecovery(VAULT_NATIVE_SW_VERBATIM)).not.toThrow();
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(VAULT_NATIVE_SW_VERBATIM));
    const hex = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    expect(VAULT_NATIVE_SW_SHA256).toBe('be8d1d2def7568b3440f15128a213a54f21e3b9aa43672c388597bfe808c512a');
    expect(hex).toBe(VAULT_NATIVE_SW_SHA256);
  });
});
