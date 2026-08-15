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
  injectVaultBootScript,
  injectVaultPrewarmBridge,
  findExactVaultRegistration,
  checkVaultBridgeLocalReadiness,
  injectVaultPrewarmFocusGuard,
  installVaultPrewarmNoFocus,
  installVaultIdbRecorder,
  getVaultPrewarmRedirectSearch,
  VAULT_BOOTSTRAP_COOKIE,
  VAULT_PREWARM_BRIDGE_MARKER,
  VAULT_PREWARM_FOCUS_GUARD_MARKER,
  VAULT_PREWARM_REQUIRED_FILES,
  injectVaultControlledReload,
  completeVaultBootstrap,
  installVaultControlledReload,
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

  describe('completeVaultBootstrap / REQ-VAULT-024', () => {
    it('does not mark bootstrap complete when encryption enablement cannot persist', () => {
      let cookie = '';
      const documentRef = {
        get cookie() { return cookie; },
        set cookie(value: string) { cookie = value; },
      };
      const locationRef = { replace: vi.fn() };
      const storageRef = {
        setItem: vi.fn(() => { throw new Error('storage denied'); }),
      };

      expect(() => completeVaultBootstrap(
        storageRef,
        documentRef,
        locationRef,
        VAULT_BOOTSTRAP_COOKIE,
        '/api/vault/aabbccdd11223344/',
        '',
      )).toThrow('storage denied');

      expect(cookie).toBe('');
      expect(locationRef.replace).not.toHaveBeenCalled();
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

    it('binds the complete local-readiness decision to the exact current Vault scope', async () => {
      const expectedScope = 'https://x/api/vault/0123456789abcdef0123456789abcdef/';
      const sid = 'aabbccdd';
      const current = { scope: expectedScope, active: { state: 'activated' } };
      const orphan = { scope: 'https://x/api/vault/abcdef12/', active: { state: 'activated' } };
      const entries = new Map([
        [`vault-session-${sid}-scope`, expectedScope],
        [`vault-session-${sid}-idbs`, JSON.stringify(['sb_data_current', 'sb_files_current'])],
      ]);
      const windowRef = {
        localStorage: { getItem: (key: string) => entries.get(key) ?? null },
        indexedDB: { databases: async () => [{ name: 'sb_data_current' }, { name: 'sb_files_current' }] },
      };
      const run = (getRegistration: (_scope: string) => Promise<any>) => checkVaultBridgeLocalReadiness(
        windowRef,
        { serviceWorker: { getRegistration } },
        expectedScope,
        sid,
        findExactVaultRegistration,
      );
      const exactLookup = vi.fn(async (_scope: string) => current);

      await expect(run(exactLookup)).resolves.toMatchObject({ ready: true, serviceWorkerState: 'activated' });
      await expect(run(vi.fn(async (_scope: string) => orphan))).resolves.toMatchObject({ ready: false, reason: 'missing-service-worker' });
      await expect(run(vi.fn(async (_scope: string) => { throw new Error('unavailable'); }))).resolves.toMatchObject({ ready: false, reason: 'missing-service-worker' });
      await expect(run(vi.fn(async (_scope: string) => ({ ...current, active: null })))).resolves.toMatchObject({ ready: false, reason: 'missing-service-worker' });
      await expect(run(vi.fn(async (_scope: string) => ({ ...current, active: { state: 'activating' } })))).resolves.toMatchObject({ ready: false, reason: 'missing-service-worker' });
      expect(exactLookup).toHaveBeenCalledWith(expectedScope);

      const script = await readPrewarmBridgeScript(injectVaultPrewarmBridge('<html><head></head></html>', 'warm-1'));
      expect(script).toContain('var checkLocalReadiness = ');
      expect(script).toContain('checkLocalReadiness(window, navigator, expectedScope, sid, findExactRegistration)');
      expect(script).not.toContain('getRegistrations()');
    });

    it('arms only after the readiness proof holds across multiple consecutive polls (stable-green gate)', async () => {
      const script = await readPrewarmBridgeScript(injectVaultPrewarmBridge('<html><head></head></html>', 'warm-1'));
      // More than one consecutive proven-ready poll is required before arming.
      const m = script.match(/requiredReadyStreak\s*=\s*(\d+)/);
      expect(m, 'bridge must define requiredReadyStreak').not.toBeNull();
      expect(Number(m![1])).toBeGreaterThanOrEqual(2);
      // post("ready") is gated behind the streak threshold, not a single proof ...
      expect(script.indexOf('readyStreak >= requiredReadyStreak')).toBeGreaterThanOrEqual(0);
      expect(script.indexOf('readyStreak >= requiredReadyStreak')).toBeLessThan(
        script.indexOf('post("ready"'),
      );
      // ... and a not-ready poll resets the streak so a momentary index-empty cannot arm.
      expect(script).toContain('readyStreak = 0');
    });
  });

  describe('installVaultIdbRecorder (REQ-VAULT-021 v2 scope cutover)', () => {
    const SID = 'aabbccdd';
    const CURRENT_SCOPE = 'https://x/api/vault/0123456789abcdef0123456789abcdef/';
    const IDB_KEY = `vault-session-${SID}-idbs`;
    const SCOPE_KEY = `vault-session-${SID}-scope`;
    const PREWARMED_KEY = `vault-session-${SID}-prewarmed`;

    function runRecorder(entries: Record<string, string>) {
      const store = new Map(Object.entries(entries));
      const storage = {
        getItem: vi.fn((key: string) => store.get(key) ?? null),
        setItem: vi.fn((key: string, value: string) => { store.set(key, value); }),
        removeItem: vi.fn((key: string) => { store.delete(key); }),
      };
      const deleteDatabase = vi.fn();
      const unregister = vi.fn(async () => true);
      const getRegistrations = vi.fn(async () => [{ scope: 'https://x/api/vault/abcdef12/', unregister }]);
      const open = vi.fn((_name: string, _version?: number) => ({ result: null }));
      const indexedDb = { open, deleteDatabase };
      const navigatorRef = { serviceWorker: { addEventListener: vi.fn(), getRegistrations } };
      const windowRef = {
        __codeflareVaultBoot: { sessionId: SID },
        document: { baseURI: CURRENT_SCOPE },
        location: { origin: 'https://x' },
      };

      installVaultIdbRecorder(windowRef, navigatorRef, indexedDb, storage);
      return { store, storage, indexedDb, open, deleteDatabase, getRegistrations, unregister };
    }

    it('invalidates only readiness markers when the canonical scope changes, then records fresh DB names', () => {
      const result = runRecorder({
        [IDB_KEY]: JSON.stringify(['sb_data_old', 'sb_files_old']),
        [PREWARMED_KEY]: '1',
      });

      expect(result.store.get(SCOPE_KEY)).toBe(CURRENT_SCOPE);
      expect(result.store.get(IDB_KEY)).toBe('[]');
      expect(result.store.has(PREWARMED_KEY)).toBe(false);
      expect(result.deleteDatabase).not.toHaveBeenCalled();
      expect(result.getRegistrations).not.toHaveBeenCalled();
      expect(result.unregister).not.toHaveBeenCalled();

      result.indexedDb.open('sb_data_new');
      result.indexedDb.open('sb_files_new');
      expect(JSON.parse(result.store.get(IDB_KEY)!)).toEqual(['sb_data_new', 'sb_files_new']);
    });

    it('preserves the current readiness proof and DB record when the scope is unchanged', () => {
      const result = runRecorder({
        [IDB_KEY]: JSON.stringify(['sb_data_current', 'sb_files_current']),
        [SCOPE_KEY]: CURRENT_SCOPE,
        [PREWARMED_KEY]: '1',
      });

      expect(JSON.parse(result.store.get(IDB_KEY)!)).toEqual(['sb_data_current', 'sb_files_current']);
      expect(result.store.get(PREWARMED_KEY)).toBe('1');
      expect(result.deleteDatabase).not.toHaveBeenCalled();
    });
  });

  describe('injectVaultControlledReload (REQ-VAULT-018 open-path safety net)', () => {
    // Call the exported installer directly (workerd blocks new Function); it is the
    // single source of truth that injectVaultControlledReload .toString()-injects.
    async function runControlledReload(opts: {
      topLevel?: boolean;
      hasServiceWorker?: boolean;
      controller?: boolean;
      regs?: Array<{ active: boolean; scope: string }>;
      flagAlready?: boolean;
    }) {
      let reloadCount = 0;
      const store: Record<string, string> = {};
      if (opts.flagAlready) store['cf-vault-sw-controlled-reload'] = '1';
      const storage = {
        getItem: (k: string) => (k in store ? store[k] : null),
        setItem: (k: string, v: string) => { store[k] = v; },
        removeItem: (k: string) => { delete store[k]; },
      };
      const currentScope = 'https://x/api/vault/0123456789abcdef0123456789abcdef/';
      const fakeWindow: any = {
        document: { baseURI: currentScope },
        location: { origin: 'https://x', reload: () => { reloadCount += 1; } },
      };
      fakeWindow.parent = (opts.topLevel ?? true) ? fakeWindow : {};
      const registrations = opts.regs ?? [];
      const navigatorRef: any = opts.hasServiceWorker === false ? {} : {
        serviceWorker: {
          controller: opts.controller ? { scriptURL: `${currentScope}service_worker.js` } : null,
          getRegistration: async (scope: string) => registrations.find((registration) => registration.scope === scope),
          getRegistrations: async () => registrations,
        },
      };
      installVaultControlledReload(fakeWindow, navigatorRef, storage);
      // Let the getRegistration().then microtask settle.
      await Promise.resolve();
      await Promise.resolve();
      return { reloadCount, flagSet: store['cf-vault-sw-controlled-reload'] === '1' };
    }

    const VAULT_REG = [{ active: true, scope: 'https://x/api/vault/0123456789abcdef0123456789abcdef/' }];

    it('injects exactly one controlled-reload script carrying the marker', () => {
      const rewritten = injectVaultControlledReload('<html><head></head><body></body></html>');
      expect(rewritten).toContain(VAULT_CONTROLLED_RELOAD_MARKER);
      expect(rewritten.split(VAULT_CONTROLLED_RELOAD_MARKER).length - 1).toBe(1);
    });

    it('reloads exactly once when a vault service worker is active but not controlling the page', async () => {
      const { reloadCount, flagSet } = await runControlledReload({ controller: false, regs: VAULT_REG });
      expect(reloadCount).toBe(1);
      expect(flagSet).toBe(true); // one-shot flag set so it cannot loop
    });

    it('does NOT reload a second time once the one-shot flag is set (loop-safe)', async () => {
      const { reloadCount } = await runControlledReload({ controller: false, regs: VAULT_REG, flagAlready: true });
      expect(reloadCount).toBe(0);
    });

    it('is inert in the headless prewarm iframe (window.parent !== window)', async () => {
      const { reloadCount } = await runControlledReload({ topLevel: false, controller: false, regs: VAULT_REG });
      expect(reloadCount).toBe(0);
    });

    it('does not reload on a genuine first boot with no vault service worker registered', async () => {
      const { reloadCount } = await runControlledReload({ controller: false, regs: [] });
      expect(reloadCount).toBe(0);
    });

    it('does not reload when only a non-vault service worker scope is active', async () => {
      const { reloadCount } = await runControlledReload({ controller: false, regs: [{ active: true, scope: 'https://x/other/' }] });
      expect(reloadCount).toBe(0);
    });

    it('does not let an active orphaned Vault scope trigger the current page reload', async () => {
      const { reloadCount } = await runControlledReload({
        controller: false,
        regs: [{ active: true, scope: 'https://x/api/vault/abcdef12/' }],
      });
      expect(reloadCount).toBe(0);
    });

    it('does not reload and clears the one-shot flag once the SW already controls the page', async () => {
      const { reloadCount, flagSet } = await runControlledReload({ controller: true, regs: VAULT_REG, flagAlready: true });
      expect(reloadCount).toBe(0);
      expect(flagSet).toBe(false); // cleared so a later in-tab nav can self-heal
    });

    it('is inert when the browser has no service worker support', async () => {
      const { reloadCount } = await runControlledReload({ hasServiceWorker: false });
      expect(reloadCount).toBe(0);
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
