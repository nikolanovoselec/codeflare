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
  injectVaultPrewarmBridge,
  injectVaultPrewarmFocusGuard,
  installVaultPrewarmNoFocus,
  getVaultPrewarmRedirectSearch,
  VAULT_BOOTSTRAP_COOKIE,
  VAULT_PREWARM_BRIDGE_MARKER,
  VAULT_PREWARM_FOCUS_GUARD_MARKER,
  VAULT_PREWARM_REQUIRED_FILES,
} from '../../routes/vault-html';

describe('CF-045: vault-html direct unit tests', () => {
  // REQ-VAULT-015 AC1: graphify-out artifacts are stripped from the SB listing
  describe('filterVaultFsListing', () => {
    it('removes derived graph artifacts that should not enter the SilverBullet index queue', () => {
      const body = JSON.stringify([
        { name: 'Notes/foo.md' },
        { name: 'graphify-out/graph.html' },
        { name: 'Raw/Graphs/vault-graph.html' },
        { name: 'Raw/Graphs/Vault Graph.md' },
        { name: 'Index.md' },
      ]);
      const filtered = JSON.parse(filterVaultFsListing(body)) as Array<{ name: string }>;
      expect(filtered.map((e) => e.name)).toEqual(['Notes/foo.md', 'Raw/Graphs/Vault Graph.md', 'Index.md']);
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

    async function readPrewarmBridgeScript(html: string): Promise<string> {
      let script = '';
      await new HTMLRewriter()
        .on(`script[${VAULT_PREWARM_BRIDGE_MARKER}]`, {
          text(text) { script += text.text; },
        })
        .transform(new Response(html))
        .text();
      return script;
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

    function runPrewarmFocusGuard(search: string) {
      let htmlFocusCount = 0;
      let svgFocusCount = 0;
      let inputSelectCount = 0;
      let textareaSelectCount = 0;
      let windowFocusCount = 0;
      let blurCount = 0;
      const listeners: Record<string, Array<(event: { target?: unknown }) => void>> = {};

      class FakeHTMLElement {
        focus() { htmlFocusCount += 1; }
        blur() { blurCount += 1; }
      }
      class FakeSVGElement {
        focus() { svgFocusCount += 1; }
      }
      class FakeInputElement extends FakeHTMLElement {
        select() { inputSelectCount += 1; }
      }
      class FakeTextAreaElement extends FakeHTMLElement {
        select() { textareaSelectCount += 1; }
      }

      const fakeWindow: any = {
        location: { search },
        URLSearchParams,
        HTMLElement: FakeHTMLElement,
        SVGElement: FakeSVGElement,
        HTMLInputElement: FakeInputElement,
        HTMLTextAreaElement: FakeTextAreaElement,
        focus() { windowFocusCount += 1; },
      };
      const fakeDocument = {
        addEventListener(type: string, listener: (event: { target?: unknown }) => void) {
          listeners[type] = [...(listeners[type] ?? []), listener];
        },
      };

      const installed = installVaultPrewarmNoFocus(fakeWindow, fakeDocument, null);

      const htmlEl = new FakeHTMLElement();
      const svgEl = new FakeSVGElement();
      const input = new FakeInputElement();
      const textarea = new FakeTextAreaElement();
      htmlEl.focus();
      svgEl.focus();
      input.select();
      textarea.select();
      fakeWindow.focus();
      for (const listener of listeners.focusin ?? []) listener({ target: htmlEl });

      return {
        installed,
        guardActivated: fakeWindow.__codeflareVaultPrewarmNoFocus === true,
        htmlFocusCount,
        svgFocusCount,
        inputSelectCount,
        textareaSelectCount,
        windowFocusCount,
        blurCount,
      };
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

    it('keeps normal focus behavior when the generic shell is not opened for prewarm', async () => {
      const html = '<html><head></head><body></body></html>';
      const rewritten = injectVaultPrewarmFocusGuard(html);
      const result = runPrewarmFocusGuard('');

      expect(await countPrewarmFocusGuardScripts(rewritten)).toBe(1);
      expect(result.installed).toBe(false);
      expect(result.guardActivated).toBe(false);
      expect(result.htmlFocusCount).toBe(1);
      expect(result.svgFocusCount).toBe(1);
      expect(result.inputSelectCount).toBe(1);
      expect(result.textareaSelectCount).toBe(1);
      expect(result.windowFocusCount).toBe(1);
      expect(result.blurCount).toBe(0);
    });

    it('makes the prewarm shell unable to take script focus while SilverBullet boots', async () => {
      const html = '<html><head></head><body></body></html>';
      const rewritten = injectVaultPrewarmFocusGuard(html);
      const result = runPrewarmFocusGuard('?codeflarePrewarm=1&prewarmId=warm-1');

      expect(await countPrewarmFocusGuardScripts(rewritten)).toBe(1);
      expect(result.installed).toBe(true);
      expect(result.guardActivated).toBe(true);
      expect(result.htmlFocusCount).toBe(0);
      expect(result.svgFocusCount).toBe(0);
      expect(result.inputSelectCount).toBe(0);
      expect(result.textareaSelectCount).toBe(0);
      expect(result.windowFocusCount).toBe(0);
      expect(result.blurCount).toBe(1);
    });

    it('requires SilverBullet space sync and expected vault files before the bridge can report ready', async () => {
      const html = '<html><head></head><body></body></html>';
      const script = await readPrewarmBridgeScript(injectVaultPrewarmBridge(html, 'warm-1'));

      for (const file of VAULT_PREWARM_REQUIRED_FILES) {
        expect(script).toContain(`"${file}"`);
      }
      expect(script).toContain('space-sync-complete');
      expect(script).toContain('hasFullIndexCompleted');
      expect(script).toContain('getQueueStats("indexQueue")');
      expect(script).toContain('isQueueEmpty("indexQueue")');
      expect(script).toContain('fetch(".fs/", { cache: "no-store" })');
      expect(script.indexOf('checkContentReadiness')).toBeLessThan(
        script.indexOf('post("ready"'),
      );
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
