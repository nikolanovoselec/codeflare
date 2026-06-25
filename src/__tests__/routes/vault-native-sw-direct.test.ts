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

  // REQ-VAULT-017 AC6: the graft coerces a non-array remote `fetchFileList()`
  // result to [] before the sync-cycle consumers (`getNonSyncCandidates` ->
  // `o.forEach`, and `o.map`), so a transient proxy error or a stray CF Access
  // 302 HTML body becomes a safe no-op cycle instead of crashing the loop.

  // Build a runnable approximation of the worker's full-sync-cycle remote-list
  // consumer chain straight out of the SERVED worker string, so the test fails
  // if the coercion `.replace()` is removed (the chain then throws on non-array).
  function makeSyncCycleRunner(sw: string) {
    const start = sw.indexOf('s=await this.primary.fetchFileList()');
    const endMarker = 'c=new Map(o.map(f=>[f.name,f]))';
    const endIdx = sw.indexOf(endMarker, start);
    if (start < 0 || endIdx < 0) {
      throw new Error('full-sync-cycle remote-list consumer chain not found in served worker');
    }
    const chain = sw.slice(start, endIdx + endMarker.length);
    // eslint-disable-next-line no-new-func
    const fn = new Function(`return (async function(){
      let s,o,r,l,c;
      ${chain};
      return { candidateCount: r.size, remoteMapCount: c.size };
    });`)() as (this: unknown) => Promise<{ candidateCount: number; remoteMapCount: number }>;
    return (remoteList: unknown) => {
      // Stub the space-sync instance the chain runs against: primary = local
      // (empty), secondary = remote (the value under test). getNonSyncCandidates
      // mirrors the worker's own `t.forEach`-based implementation.
      const ctx = {
        primary: { fetchFileList: async () => [] as Array<{ name: string }> },
        secondary: { fetchFileList: async () => remoteList },
        options: { isSyncCandidate: () => false },
        getNonSyncCandidates(t: Array<{ name: string }>) {
          const i = new Map<string, { name: string }>();
          t.forEach((n) => {
            if (!this.options.isSyncCandidate()) i.set(n.name, n);
          });
          return i;
        },
      };
      return fn.call(ctx);
    };
  }

  it('the served sync cycle iterates a real remote array normally', async () => {
    const run = makeSyncCycleRunner(VAULT_NATIVE_SERVICE_WORKER_JS);
    const result = await run([{ name: 'a.md' }, { name: 'b.md' }]);
    expect(result.candidateCount).toBe(2);
    expect(result.remoteMapCount).toBe(2);
  });

  it('the served sync cycle no-ops (no throw, zero candidates) on a non-array remote list', async () => {
    const run = makeSyncCycleRunner(VAULT_NATIVE_SERVICE_WORKER_JS);
    for (const nonArray of [{ error: 'transient 5xx' }, '<!doctype html>', null, 502]) {
      const result = await run(nonArray);
      expect(result.candidateCount).toBe(0);
      expect(result.remoteMapCount).toBe(0);
    }
  });

  it('the coercion is load-bearing: the verbatim (pre-graft) chain throws on a non-array remote list', async () => {
    // Negative control — proves the served no-op above comes from the graft, not
    // from upstream behavior. The pristine verbatim has no `Array.isArray` guard.
    expect(VAULT_NATIVE_SW_VERBATIM).not.toContain('Array.isArray(a)?a:[]');
    const runVerbatim = makeSyncCycleRunner(VAULT_NATIVE_SW_VERBATIM);
    await expect(runVerbatim({ error: 'transient 5xx' })).rejects.toThrow(/forEach is not a function|is not a function/);
    expect(VAULT_NATIVE_SERVICE_WORKER_JS).toContain(
      'o=(a=>Array.isArray(a)?a:[])(await this.secondary.fetchFileList())',
    );
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
