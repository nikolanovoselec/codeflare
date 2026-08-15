import { describe, it, expect, vi } from 'vitest';

// CF-045
// Direct unit tests for src/lib/vault-view.ts. These pure helpers were
// previously exercised only through the src/routes/vault/index.ts re-export barrel
// (vault.test.ts imports from '../../routes/vault'). Importing the source
// module directly pins the behaviour at the module boundary so a broken
// re-export or a source-only change is caught here independently.
import {
  filterVaultFsListing,
  isFilteredVaultMutation,
  rewriteVaultBaseHref,
  rewriteVaultHtmlResponse,
  hasVaultBootstrapCookie,
  inferOriginValidated,
  injectVaultEncryptionConfig,
  injectVaultPrewarmBridge,
  injectVaultPrewarmFocusGuard,
  getVaultPrewarmRedirectSearch,
  VAULT_BOOTSTRAP_COOKIE,
  VAULT_PREWARM_BRIDGE_MARKER,
  VAULT_PREWARM_FOCUS_GUARD_MARKER,
  injectVaultControlledReload,
  VAULT_CONTROLLED_RELOAD_MARKER,
} from '../../lib/vault-view';

// REQ-VAULT-022: Vault armed-state open flow and persistence

describe('CF-045: vault-html direct unit tests', () => {
  // REQ-VAULT-015 AC1: graphify-out artifacts are stripped from the SB listing
  describe('filterVaultFsListing', () => {
    it('removes derived graph artifacts AND machine-owned session captures, keeping human notes', () => {
      const body = JSON.stringify([
        { name: 'Notes/foo.md' },
        { name: 'Notes/Plans/2026-06-18-plan.md' },
        { name: 'graphify-out/graph.html' },
        { name: 'Raw/Graphs/vault-graph.html' },
        { name: 'Raw/Graphs/Vault Graph.md' },
        { name: 'Raw/Sessions/2026-07-05T00-00-00+0200-abcd.md' },
        { name: 'Index.md' },
      ]);
      const filtered = JSON.parse(filterVaultFsListing(body)) as Array<{ name: string }>;
      expect(filtered.map((e) => e.name)).toEqual([
        'Notes/foo.md',
        'Notes/Plans/2026-06-18-plan.md',
        'Raw/Graphs/Vault Graph.md',
        'Index.md',
      ]);
    });

    it('returns the body byte-for-byte unchanged when nothing is filtered', () => {
      const body = JSON.stringify([{ name: 'Notes/foo.md' }, { name: 'Index.md' }]);
      expect(filterVaultFsListing(body)).toBe(body);
    });

    it('fail-safe: returns the input unchanged on non-JSON body', () => {
      const body = 'not json at all';
      expect(filterVaultFsListing(body)).toBe(body);
    });

    it('fail-safe: returns the input unchanged when the body is not an array', () => {
      const body = JSON.stringify({ name: 'graphify-out/x' });
      expect(filterVaultFsListing(body)).toBe(body);
    });
  });

  // REQ-VAULT-015 AC1: client mutations to the hidden machine-owned paths are
  // rejected so a transitioning client cannot delete the on-disk memory.
  describe('isFilteredVaultMutation', () => {
    it('blocks client mutations to hidden machine-owned paths', () => {
      for (const m of ['PUT', 'DELETE', 'PATCH', 'POST', 'put', 'delete']) {
        expect(isFilteredVaultMutation(m, '/Raw/Sessions/2026-07-05T00-00-00.md')).toBe(true);
        expect(isFilteredVaultMutation(m, '/graphify-out/graph.json')).toBe(true);
        expect(isFilteredVaultMutation(m, '/Raw/Graphs/vault-graph.html')).toBe(true);
      }
    });

    it('allows client mutations to human-edited vault paths', () => {
      for (const m of ['PUT', 'DELETE', 'PATCH', 'POST']) {
        expect(isFilteredVaultMutation(m, '/Notes/Plans/plan.md')).toBe(false);
        expect(isFilteredVaultMutation(m, '/Notes/foo.md')).toBe(false);
        // the Raw/Graphs markdown index page stays user-editable (only *.html is hidden)
        expect(isFilteredVaultMutation(m, '/Raw/Graphs/Vault Graph.md')).toBe(false);
      }
    });

    it('never blocks reads of hidden paths (GET/HEAD pass through)', () => {
      expect(isFilteredVaultMutation('GET', '/Raw/Sessions/x.md')).toBe(false);
      expect(isFilteredVaultMutation('HEAD', '/Raw/Sessions/x.md')).toBe(false);
      expect(isFilteredVaultMutation('OPTIONS', '/graphify-out/graph.json')).toBe(false);
    });
  });

  describe('rewriteVaultBaseHref', () => {
    it('rewrites <base href="/"> to the per-session vault prefix', () => {
      const { rewritten, wasNoOp } = rewriteVaultBaseHref('<head><base href="/" /></head>', 'aabbccdd11223344');
      expect(rewritten).toContain('<base href="/api/vault/aabbccdd11223344/" />');
      expect(wasNoOp).toBe(false);
    });

    it('reports wasNoOp when there is no base tag to rewrite', () => {
      const { rewritten, wasNoOp } = rewriteVaultBaseHref('<head></head>', 'aabbccdd11223344');
      expect(rewritten).toBe('<head></head>');
      expect(wasNoOp).toBe(true);
    });

    it('warns when a successful deep SPA HTML response has no rewritable base href (REQ-VAULT-013 AC4)', async () => {
      const logger = { warn: vi.fn() };
      await rewriteVaultHtmlResponse(
        new Response('<html><head><base href="/already-prefixed/"></head></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
        'aabbccdd11223344',
        '/Notes/deep/path',
        '/api/vault/aabbccdd11223344/Notes/deep/path',
        'text/html',
        logger,
      );

      expect(logger.warn).toHaveBeenCalledWith('vault base-href rewrite no-op', {
        pathname: '/api/vault/aabbccdd11223344/Notes/deep/path',
        contentType: 'text/html',
      });
    });

    it('wires exactly one focus guard into a Worker-rewritten prewarm shell', async () => {
      const token = '0123456789abcdef0123456789abcdef';
      const request = new Request(
        `https://x/api/vault/${token}/?codeflarePrewarm=1&prewarmId=warm-1`,
      );
      const result = await rewriteVaultHtmlResponse(
        new Response('<html><head><base href="/"></head><body></body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
        token,
        '/',
        `/api/vault/${token}/`,
        'text/html',
        { warn: vi.fn() },
        request,
      );
      const html = await result.text();

      expect(html.split(VAULT_PREWARM_FOCUS_GUARD_MARKER).length - 1).toBe(1);
    });
  });

  describe('hasVaultBootstrapCookie', () => {
    it('returns true when the bootstrap cookie is present with value 1', () => {
      const req = new Request('https://x/', { headers: { Cookie: `${VAULT_BOOTSTRAP_COOKIE}=1` } });
      expect(hasVaultBootstrapCookie(req)).toBe(true);
    });

    it('returns false when the cookie is absent', () => {
      const req = new Request('https://x/', { headers: { Cookie: 'other=foo' } });
      expect(hasVaultBootstrapCookie(req)).toBe(false);
    });

    it('returns false when the cookie has a non-1 value', () => {
      const req = new Request('https://x/', { headers: { Cookie: `${VAULT_BOOTSTRAP_COOKIE}=0` } });
      expect(hasVaultBootstrapCookie(req)).toBe(false);
    });
  });

  // REQ-VAULT-009 AC1+AC4: same-origin fallback for the CSRF synthesis gate
  describe('inferOriginValidated', () => {
    it('returns true for a state-changing method with no Origin header', () => {
      const req = new Request('https://x/', { method: 'PUT' });
      expect(inferOriginValidated(req)).toBe(true);
    });

    it('returns false for a state-changing method that supplied an Origin', () => {
      const req = new Request('https://x/', { method: 'POST', headers: { Origin: 'https://x' } });
      expect(inferOriginValidated(req)).toBe(false);
    });

    it('returns false for a safe (GET) method', () => {
      const req = new Request('https://x/', { method: 'GET' });
      expect(inferOriginValidated(req)).toBe(false);
    });
  });

  // REQ-VAULT-008 AC3: encryption config merged into the boot config
  describe('injectVaultEncryptionConfig', () => {
    it('merges vaultEncryptionKey and enableClientEncryption into the boot config', () => {
      const merged = JSON.parse(injectVaultEncryptionConfig('{"a":1}', 'KEY123')) as Record<string, unknown>;
      expect(merged.a).toBe(1);
      expect(merged.vaultEncryptionKey).toBe('KEY123');
      expect(merged.enableClientEncryption).toBe(true);
    });

    it('throws on an empty encryption key', () => {
      expect(() => injectVaultEncryptionConfig('{}', '')).toThrow();
    });

    it('throws when the boot config is not a JSON object', () => {
      expect(() => injectVaultEncryptionConfig('[1,2,3]', 'KEY')).toThrow();
    });
  });

  describe('REQ-MOB-014 / REQ-VAULT-020: vault prewarm helpers', () => {
    async function countPrewarmBridgeScripts(html: string): Promise<number> {
      let count = 0;
      await new HTMLRewriter()
        .on(`script[${VAULT_PREWARM_BRIDGE_MARKER}]`, {
          element() { count += 1; },
        })
        .transform(new Response(html))
        .text();
      return count;
    }

    async function countPrewarmFocusGuardScripts(html: string): Promise<number> {
      let count = 0;
      await new HTMLRewriter()
        .on(`script[${VAULT_PREWARM_FOCUS_GUARD_MARKER}]`, {
          element() { count += 1; },
        })
        .transform(new Response(html))
        .text();
      return count;
    }

    it('preserves only valid prewarm handshake parameters for bootstrap redirects', () => {
      const req = new Request('https://x/api/vault/aabbccdd/.codeflare-bootstrap?codeflarePrewarm=1&prewarmId=warm-1');
      const search = getVaultPrewarmRedirectSearch(req);
      const parsed = new URL(`https://x/${search}`);

      expect(parsed.searchParams.get('codeflarePrewarm')).toBe('1');
      expect(parsed.searchParams.get('prewarmId')).toBe('warm-1');
    });

    it('drops malformed prewarm identifiers instead of redirecting them into the shell', () => {
      const req = new Request('https://x/api/vault/aabbccdd/.codeflare-bootstrap?codeflarePrewarm=1&prewarmId=<script>');

      expect(getVaultPrewarmRedirectSearch(req)).toBe('');
    });

    it('injects a single prewarm bridge script for a valid prewarm token', async () => {
      const html = '<html><head></head><body></body></html>';
      const once = injectVaultPrewarmBridge(html, 'warm-1');
      const twice = injectVaultPrewarmBridge(once, 'warm-1');

      expect(await countPrewarmBridgeScripts(once)).toBe(1);
      expect(await countPrewarmBridgeScripts(twice)).toBe(1);
    });

    it('injects the inert bridge into the generic shell so the precached shell can prewarm later', async () => {
      const html = '<html><head></head><body></body></html>';
      const rewritten = injectVaultPrewarmBridge(html);

      expect(await countPrewarmBridgeScripts(rewritten)).toBe(1);
    });

    it('injects one idempotent focus guard for a valid prewarm token', async () => {
      const html = '<html><head></head><body></body></html>';
      const once = injectVaultPrewarmFocusGuard(html, 'warm-1');
      const twice = injectVaultPrewarmFocusGuard(once, 'warm-1');

      expect(await countPrewarmFocusGuardScripts(once)).toBe(1);
      expect(await countPrewarmFocusGuardScripts(twice)).toBe(1);
    });

  });

  it('injects exactly one controlled-reload script carrying the marker', () => {
    const rewritten = injectVaultControlledReload('<html><head></head><body></body></html>');
    expect(rewritten).toContain(VAULT_CONTROLLED_RELOAD_MARKER);
    expect(rewritten.split(VAULT_CONTROLLED_RELOAD_MARKER).length - 1).toBe(1);
  });

});
