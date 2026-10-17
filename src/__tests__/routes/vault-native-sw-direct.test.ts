import { afterEach, describe, it, expect } from 'vitest';
import { nativeWorkerRuntime } from '../helpers/native-worker-runtime';
import candidate from './fixtures/silverbullet-worker-2.12.1.json';

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

describe.each(['image export', 'upstream candidate'] as const)('CF-045: vault-native-sw direct unit tests (%s)', artifact => {
  const verbatimWorker = artifact === 'upstream candidate' ? candidate.worker : VAULT_NATIVE_SW_VERBATIM;
  const expectedSHA = artifact === 'upstream candidate' ? candidate.sha256 : VAULT_NATIVE_SW_SHA256;
  // Graft inside each test: candidate incompatibility is an assertion failure,
  // never a module-collection failure. The image export stays covered as well.
  const servedWorker = () => artifact === 'upstream candidate'
    ? graftVaultKeyRecovery(verbatimWorker) : VAULT_NATIVE_SERVICE_WORKER_JS;

  it('REQ-VAULT-017 AC4: install precaching bypasses stale browser cache entries', async () => {
    const runtime = nativeWorkerRuntime(servedWorker(), async () => { throw new Error('Install uses CacheStorage'); });
    try {
      await runtime.install();
      const requests = runtime.precacheRequests;
      expect(requests.length).toBeGreaterThan(1);
      expect(requests.map(request => new URL(request.url).pathname)).toContain('/');
      expect(requests.some(request => /\.(?:js|css|json|webmanifest)(?:$|\?)/.test(request.url))).toBe(true);
      expect(requests.every(request => request.cache === 'reload')).toBe(true);
    } finally { runtime.dispose(); }
  });

  const aesKey = btoa('a'.repeat(32));
  const config = { enableClientEncryption: true, spaceFolderPath: '/vault', syncDocuments: true, syncIgnore: '' };
  const runtimes = new Set<ReturnType<typeof nativeWorkerRuntime>>();
  afterEach(() => { for (const runtime of runtimes) runtime.dispose(); runtimes.clear(); });
  function servedRuntime(recover: () => Promise<Response> = async () => Response.json({ key: aesKey })) {
    const requests: Array<{ url: string; credentials?: string }> = [];
    const runtime = nativeWorkerRuntime(servedWorker(), async (input, options) => {
      const url = input instanceof Request ? input.url : String(input);
      requests.push({ url, credentials: options?.credentials });
      if (url === 'https://vault.test/.vault-key') return recover();
      if (url === '/.fs') return Response.json([]);
      throw new Error(`Unexpected native worker transport: ${url}`);
    });
    runtimes.add(runtime);
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
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    const runtime = servedRuntime(async () => { entered(); await pending; return Response.json({ key: aesKey }); });
    const recovery = runtime.message({ type: 'get-encryption-key' });
    await started;
    expect(await runtime.message({ type: 'logout-sync', id: 'pending' })).toEqual([{ ok: true, databases: [] }]);
    release();
    expect(await recovery).toEqual([]);
    await runtime.message({ type: 'logout-cancel', id: 'pending' });
    expect(await runtime.message({ type: 'get-encryption-key' })).toEqual([{ type: 'encryption-key', key: aesKey }]);
  });

  it.each(['401', '403', 'missing key', 'invalid key', 'invalid AES', 'transport rejection'])('REQ-VAULT-024: AC5 denies unusable %s recovery at both registered read sites', async failure => {
    const runtime = servedRuntime(async () => {
      if (failure === 'transport rejection') throw new Error('Network unavailable');
      if (failure === '401' || failure === '403') return new Response(null, { status: Number(failure) });
      if (failure === 'missing key') return Response.json({});
      return Response.json({ key: failure === 'invalid AES' ? btoa('short') : 'invalid-base64@@' });
    });
    expect(await runtime.message({ type: 'get-encryption-key' })).toEqual([{ type: 'encryption-key', key: undefined }]);
    const messages: Record<string, unknown>[] = [];
    const disconnect = runtime.connectClient(value => messages.push(value));
    try {
      await runtime.message({ type: 'config', config });
      await expect.poll(() => messages.find(value => value.type === 'auth-error')).toBeDefined();
      expect(await runtime.message({ type: 'logout-sync', id: 'denied' })).toEqual([{ ok: true, databases: [] }]);
      expect(await runtime.message({ type: 'get-encryption-key' })).toEqual([]);
    } finally { disconnect(); }
  });

  it('REQ-VAULT-024: AC5 active native logout blocks both cold read sites without recovering AES', async () => {
    const runtime = servedRuntime();
    expect(await runtime.message({ type: 'logout-sync', id: 'active' })).toEqual([{ ok: true, databases: [] }]);
    expect(await runtime.message({ type: 'get-encryption-key' })).toEqual([]);
    expect(await runtime.message({ type: 'config', config })).toEqual([]);
    expect([...runtime.databases.keys()]).toEqual([]);
    await runtime.message({ type: 'logout-cancel', id: 'active' });
    expect(await runtime.message({ type: 'get-encryption-key' })).toEqual([{ type: 'encryption-key', key: aesKey }]);
  });

  it('REQ-VAULT-025: served worker drops no-client info spam and downgrades expected auth/sync startup noise', async () => {
    const runtime = nativeWorkerRuntime(servedWorker(), async () => Response.json({ error: 'not ready' }, { status: 409 }));
    runtimes.add(runtime);
    await runtime.message({ type: 'set-encryption-key', key: aesKey });
    await runtime.message({ type: 'config', config });
    await expect.poll(() => runtime.logs.some(entry => entry.level === 'warn' && entry.args[0] === 'Sync space error')).toBe(true);
    expect(runtime.logs.filter(entry => entry.level === 'info' && entry.args[0] === 'No clients are listening for messages, dropping message')).toEqual([]);
    expect(runtime.logs.filter(entry => entry.level === 'error' && entry.args[0] === 'Sync space error')).toEqual([]);
    await runtime.message({ type: 'shutdown' });
  });

  it.each(['space mismatch', 'authentication redirect'] as const)('REQ-VAULT-025: AC1 retains native %s messages and reset semantics', async failure => {
    let failing = false;
    const runtime = nativeWorkerRuntime(servedWorker(), async () => {
      if (!failing) return Response.json([]);
      return failure === 'space mismatch'
        ? Response.json([], { headers: { 'X-Space-Path': '/different-space' } })
        : new Response(null, { status: 302, headers: { Location: '.auth' } });
    });
    runtimes.add(runtime);
    const messages: Record<string, unknown>[] = [];
    const disconnect = runtime.connectClient(value => messages.push(value));
    try {
      await runtime.message({ type: 'set-encryption-key', key: aesKey });
      const ready = nextSync(runtime);
      await runtime.message({ type: 'config', config });
      expect(await ready).toEqual({ type: 'space-sync-complete', operations: 0 });
      failing = true;
      await runtime.message({ type: 'perform-space-sync' });
      await expect.poll(() => messages.find(value => value.type === 'auth-error')).toBeDefined();
      expect(messages).toContainEqual(expect.objectContaining({ type: 'auth-error',
        message: expect.any(String), actionOrRedirectHeader: failure === 'space mismatch' ? 'reload' : '.auth' }));
      if (failure === 'space mismatch') {
        expect(runtime.logs).toContainEqual(expect.objectContaining({ level: 'info', args: expect.arrayContaining(['[service proxy auth]']) }));
        await runtime.message({ type: 'perform-space-sync' });
        expect(runtime.logs).toContainEqual({ level: 'warn', args: ['Ignoring perform-space-sync request, proxy not configured yet'] });
      } else {
        expect(runtime.logs).toContainEqual(expect.objectContaining({ level: 'error', args: expect.arrayContaining(['[service proxy error]']) }));
      }
    } finally { disconnect(); await runtime.message({ type: 'shutdown' }); }
  });

  it('REQ-VAULT-024 AC4 / REQ-VAULT-025 AC4: the served worker retains real AES across the registered zero-client interval', async () => {
    const runtime = servedRuntime(async () => new Response(null, { status: 403 }));
    expect(await runtime.message({ type: 'set-encryption-key', key: aesKey })).toEqual([{ type: 'encryption-key-set' }]);
    await runtime.noClientInterval();
    expect(await runtime.message({ type: 'get-encryption-key' })).toEqual([{ type: 'encryption-key', key: aesKey }]);
    expect(runtime.requests).toEqual([]); // retained AES, not a successful recovery hiding a wipe
  });

  it('the verbatim worker loses real AES across its registered zero-client interval', async () => {
    const runtime = nativeWorkerRuntime(verbatimWorker, async () => { throw new Error('No external recovery allowed'); });
    await runtime.message({ type: 'set-encryption-key', key: aesKey });
    await runtime.noClientInterval();
    expect(await runtime.message({ type: 'get-encryption-key' })).toEqual([{ type: 'encryption-key', key: undefined }]);
  });

  it('throws when an anchor substring is missing (SilverBullet version drift guard)', () => {
    expect(() => graftVaultKeyRecovery('not the silverbullet worker at all')).toThrow(
      /anchor/i,
    );
  });

  // REQ-VAULT-025 AC2 / REQ-VAULT-023 AC2: unreadable listings must fail,
  // including on first boot. A valid [] is safe only with an empty local store
  // and snapshot; populated-store and snapshot deletion fences remain binding.
  function nextSync(runtime: ReturnType<typeof nativeWorkerRuntime>) {
    return new Promise<Record<string, unknown>>(resolve => {
      const disconnect = runtime.connectClient(value => {
        if (value.type === 'sync-error' || value.type === 'space-sync-complete') {
          disconnect();
          resolve(value);
        }
      });
    });
  }

  it.each([409, 404, 'null', 'object', 'scalar'] as const)('REQ-VAULT-025: JSON %s on a fresh native store fails sync and a later valid listing restores note visibility', async status => {
    const text = '# Example\nRecovered note\n';
    const meta = { name: 'Notes/example.md', created: 1000, lastModified: 2000,
      size: new TextEncoder().encode(text).length, contentType: 'text/markdown', perm: 'rw' };
    let valid = false;
    let offline = false;
    const runtime = nativeWorkerRuntime(servedWorker(), async input => {
      if (offline) throw new Error('Network unavailable: recovered visibility must come from the worker store');
      const url = input instanceof Request ? input.url : String(input);
      const path = new URL(url, 'https://vault.test').pathname;
      if (path === '/.fs' || path === '/.fs/') {
        if (valid) return Response.json([meta]);
        if (typeof status === 'number') return Response.json({ error: 'routing not ready' }, { status });
        return Response.json(status === 'null' ? null : status === 'object' ? { error: 'not a list' } : 502);
      }
      if (path === '/.fs/Notes/example.md') return new Response(text, { headers: {
        'Content-Type': meta.contentType, 'X-Last-Modified': String(meta.lastModified),
        'X-Created': String(meta.created), 'X-Content-Length': String(meta.size), 'X-Permission': meta.perm,
      } });
      throw new Error(`Unexpected native worker transport: ${url}`);
    });
    runtimes.add(runtime);
    const broadcasts: Record<string, unknown>[] = [];
    const disconnect = runtime.connectClient(value => { broadcasts.push(value); });
    try {
      await runtime.message({ type: 'set-encryption-key', key: aesKey });
      const failed = nextSync(runtime);
      await runtime.message({ type: 'config', config });
      const failure = await failed;
      expect(failure).toEqual(expect.objectContaining({ type: 'sync-error', message: expect.any(String) }));
      expect(failure.message).not.toBe('');
      expect(broadcasts).not.toContainEqual(expect.objectContaining({ type: 'space-sync-complete' }));

      valid = true;
      const recovered = nextSync(runtime);
      await runtime.message({ type: 'perform-space-sync' });
      expect(await recovered).toEqual(expect.objectContaining({ type: 'space-sync-complete', operations: 1 }));
      offline = true;
      const listing = await runtime.fetch(new Request('https://vault.test/.fs/'));
      expect(listing.status).toBe(200);
      expect(await listing.json()).toEqual([meta]);
      const note = await runtime.fetch(new Request('https://vault.test/.fs/Notes/example.md', { headers: { 'X-Sync-Mode': 'true' } }));
      expect(note.status).toBe(200);
      expect(await note.text()).toBe(text);
    } finally {
      disconnect();
      await runtime.message({ type: 'shutdown' });
    }
  });

  it.each(['empty remote', 'malformed remote', 'snapshot only'] as const)('REQ-VAULT-023: AC2 %s rejects deletion after a real encrypted sync', async state => {
    const text = '# Retained note\nMust survive a warming server\n';
    const meta = { name: 'Notes/retained.md', created: 1000, lastModified: 2000,
      size: new TextEncoder().encode(text).length, contentType: 'text/markdown', perm: 'rw' };
    let empty = false;
    let offline = false;
    const runtime = nativeWorkerRuntime(servedWorker(), async input => {
      if (offline) throw new Error('Offline retained data must come from native encrypted storage');
      const path = new URL(input instanceof Request ? input.url : String(input), 'https://vault.test').pathname;
      if (path === '/.fs' || path === '/.fs/') return Response.json(empty ? (state === 'malformed remote' ? { error: 'not a list' } : []) : [meta]);
      if (path === '/.fs/Notes/retained.md') return new Response(text, { headers: {
        'Content-Type': meta.contentType, 'X-Last-Modified': String(meta.lastModified),
        'X-Created': String(meta.created), 'X-Content-Length': String(meta.size), 'X-Permission': meta.perm,
      } });
      throw new Error(`Unexpected native worker transport: ${path}`);
    });
    runtimes.add(runtime);
    const messages: Record<string, unknown>[] = [];
    const disconnect = runtime.connectClient(value => messages.push(value));
    try {
      await runtime.message({ type: 'set-encryption-key', key: aesKey });
      const seeded = nextSync(runtime);
      await runtime.message({ type: 'config', config });
      expect(await seeded).toEqual(expect.objectContaining({ type: 'space-sync-complete', operations: 1 }));
      if (state === 'snapshot only') {
        // Native DELETE removes local content without reconciling its previously
        // synced remote revision. No private snapshot or IndexedDB rows are set.
        const removed = await runtime.fetch(new Request('https://vault.test/.fs/Notes/retained.md', { method: 'DELETE' }));
        expect(removed.status).toBe(200);
        const listing = await runtime.fetch(new Request('https://vault.test/.fs/'));
        expect(await listing.json()).toEqual([]);
      }
      empty = true;
      messages.length = 0;
      const rejected = nextSync(runtime);
      await runtime.message({ type: 'perform-space-sync' });
      expect(await rejected).toEqual(expect.objectContaining({ type: 'sync-error' }));
      expect(messages).not.toContainEqual(expect.objectContaining({ type: 'space-sync-complete' }));
      offline = true;
      const listing = await runtime.fetch(new Request('https://vault.test/.fs/'));
      if (state === 'snapshot only') {
        expect(await listing.json()).toEqual([]);
        return; // The retained revision, not local file presence, fenced this cycle.
      }
      expect(await listing.json()).toEqual([meta]);
      const note = await runtime.fetch(new Request('https://vault.test/.fs/Notes/retained.md', { headers: { 'X-Sync-Mode': 'true' } }));
      expect(note.status).toBe(200);
      expect(await note.text()).toBe(text);
      offline = false;
      empty = false;
      const recovered = nextSync(runtime);
      await runtime.message({ type: 'perform-space-sync' });
      expect(await recovered).toEqual(expect.objectContaining({ type: 'space-sync-complete' }));
    } finally { disconnect(); await runtime.message({ type: 'shutdown' }); }
  });

  it('REQ-VAULT-025: a genuinely empty native store and valid empty remote array publish successful empty sync', async () => {
    const runtime = servedRuntime();
    const complete = nextSync(runtime);
    try {
      await runtime.message({ type: 'config', config });
      expect(await complete).toEqual({ type: 'space-sync-complete', operations: 0 });
      const listing = await runtime.fetch(new Request('https://vault.test/.fs/'));
      expect(listing.status).toBe(200);
      expect(await listing.json()).toEqual([]);
    } finally {
      await runtime.message({ type: 'shutdown' });
    }
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
    expect(() => new Function(servedWorker())).not.toThrow();
  });

  it('the authentic worker matches its recorded SHA-256 artifact identity', async () => {
    // Artifact integrity is independent of the functional compatibility RED.
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verbatimWorker));
    const hex = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    expect(hex).toBe(expectedSHA);
  });
});
