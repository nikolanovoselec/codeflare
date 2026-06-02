import { describe, it, expect } from 'vitest';

// CF-045
// Direct unit tests for src/routes/vault-html.ts. These pure helpers were
// previously exercised only through the src/routes/vault.ts re-export barrel
// (vault.test.ts imports from '../../routes/vault'). Importing the source
// module directly pins the behaviour at the module boundary so a broken
// re-export or a source-only change is caught here independently.
import {
  filterVaultFsListing,
  rewriteVaultBaseHref,
  hasVaultBootstrapCookie,
  inferOriginValidated,
  injectVaultEncryptionConfig,
  injectVaultBootScript,
  VAULT_BOOTSTRAP_COOKIE,
} from '../../routes/vault-html';

describe('CF-045: vault-html direct unit tests', () => {
  // REQ-VAULT-015 AC1: graphify-out artifacts are stripped from the SB listing
  describe('filterVaultFsListing', () => {
    it('removes entries whose name starts with graphify-out/', () => {
      const body = JSON.stringify([
        { name: 'Notes/foo.md' },
        { name: 'graphify-out/graph.html' },
        { name: 'Index.md' },
      ]);
      const filtered = JSON.parse(filterVaultFsListing(body)) as Array<{ name: string }>;
      expect(filtered.map((e) => e.name)).toEqual(['Notes/foo.md', 'Index.md']);
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

  describe('injectVaultBootScript', () => {
    it('injects the boot marker before </head> for a valid sessionId', () => {
      const out = injectVaultBootScript('<head></head>', { sessionId: 'aabbccdd11223344' });
      expect(out).toContain('window.__codeflareVaultBoot');
      expect(out.indexOf('window.__codeflareVaultBoot')).toBeLessThan(out.indexOf('</head>'));
    });

    it('is idempotent (does not double-inject the boot marker)', () => {
      const once = injectVaultBootScript('<head></head>', { sessionId: 'aabbccdd11223344' });
      const twice = injectVaultBootScript(once, { sessionId: 'aabbccdd11223344' });
      expect(twice).toBe(once);
    });

    it('returns the input unchanged when there is no </head>', () => {
      const html = '<body>no head</body>';
      expect(injectVaultBootScript(html, { sessionId: 'aabbccdd11223344' })).toBe(html);
    });

    it('throws on a sessionId that fails SESSION_ID_PATTERN', () => {
      expect(() => injectVaultBootScript('<head></head>', { sessionId: 'BAD ID!' })).toThrow();
    });
  });
});
