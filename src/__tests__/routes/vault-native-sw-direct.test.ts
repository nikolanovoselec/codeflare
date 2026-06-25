import { describe, it, expect } from 'vitest';

// CF-045
// Direct unit tests for src/routes/vault-native-sw.ts. The graft logic was
// previously exercised only through the src/routes/vault.ts re-export barrel.
// Importing the source module directly pins the key-recovery graft and its
// anchor-drift guard at the module boundary.
import {
  graftVaultKeyRecovery,
  VAULT_NATIVE_SW_VERBATIM,
  VAULT_NATIVE_SERVICE_WORKER_JS,
} from '../../routes/vault-native-sw';

describe('CF-045: vault-native-sw direct unit tests', () => {
  // REQ-VAULT-017 AC1: native SW served with the codeflare key-recovery graft
  it('grafting the verbatim worker reproduces the exported served worker', () => {
    expect(graftVaultKeyRecovery(VAULT_NATIVE_SW_VERBATIM)).toBe(VAULT_NATIVE_SERVICE_WORKER_JS);
  });

  it('the graft injects the __cfRecover helper that the verbatim worker lacks', () => {
    expect(VAULT_NATIVE_SW_VERBATIM).not.toContain('__cfRecover');
    expect(VAULT_NATIVE_SERVICE_WORKER_JS).toContain('async function __cfRecover()');
  });

  it('the graft calls __cfRecover before the get-encryption-key reply', () => {
    expect(VAULT_NATIVE_SERVICE_WORKER_JS).toContain(
      'case"get-encryption-key":{if(y===void 0)await __cfRecover()',
    );
  });

  it('REQ-VAULT-017: served worker drops no-client info spam and downgrades expected auth/sync startup noise', () => {
    expect(VAULT_NATIVE_SW_VERBATIM).toContain('No clients are listening for messages, dropping message');
    expect(VAULT_NATIVE_SERVICE_WORKER_JS).not.toContain('No clients are listening for messages, dropping message');
    expect(VAULT_NATIVE_SERVICE_WORKER_JS).toContain('console.info("[service proxy auth]",c)');
    expect(VAULT_NATIVE_SERVICE_WORKER_JS).toContain('console.warn("Sync space error",t.message)');
  });

  it('throws when an anchor substring is missing (SilverBullet version drift guard)', () => {
    expect(() => graftVaultKeyRecovery('not the silverbullet worker at all')).toThrow(
      /anchor/i,
    );
  });

  it('the served worker differs from the verbatim upstream bytes', () => {
    expect(VAULT_NATIVE_SERVICE_WORKER_JS).not.toBe(VAULT_NATIVE_SW_VERBATIM);
  });

  // REQ-VAULT-017 AC6 / REQ-VAULT-021 AC8: the graft GUARDS the remote
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
    const start = sw.indexOf('s=await this.primary.fetchFileList()');
    const endMarker = 'c=new Map(o.map(f=>[f.name,f]))';
    const endIdx = sw.indexOf(endMarker, start);
    if (start < 0 || endIdx < 0) {
      throw new Error('full-sync-cycle remote-list consumer chain not found in served worker');
    }
    const chain = sw.slice(start, endIdx + endMarker.length);
    // eslint-disable-next-line no-new-func
    const fn = new Function('t', `return (async function(){
      let s,o,r,l,c;
      ${chain};
      return { candidateCount: r.size, remoteMapCount: c.size };
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
    expect(VAULT_NATIVE_SW_VERBATIM).not.toContain('Array.isArray(a)?a:[]');
    const runVerbatim = makeSyncCycleRunner(VAULT_NATIVE_SW_VERBATIM);
    await expect(runVerbatim({ error: 'transient 5xx' })).rejects.toThrow(/forEach is not a function|is not a function/);
    // The served worker carries the structural not-ready guard (array-normalize plus the
    // empty-while-populated abort condition). Assert the functional contract tokens, not
    // the human-readable error message.
    expect(VAULT_NATIVE_SERVICE_WORKER_JS).toContain('Array.isArray(a)');
    expect(VAULT_NATIVE_SERVICE_WORKER_JS).toContain('a.length===0&&(s.length>0||t.files.size>0)');
  });

  // REQ-VAULT-021 AC8: a 2nd-session start has a POPULATED persistent local store, but
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

  // REQ-VAULT-017 AC6: the coercion must keep the served worker syntactically
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
      'o=await this.secondary.fetchFileList(),r=this.getNonSyncCandidates(o)',
      'o=await this.secondary.fetchFileList(),o=Array.isArray(o)?o:[],r=this.getNonSyncCandidates(o)',
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
    expect(hex).toBe('a7b21f560e357db3f1d76fdf5603880530b8a6219842ec46dd9ef8e5d82adecb');
  });
});
