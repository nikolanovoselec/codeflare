import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { beforeAll, describe, expect, it, vi } from 'vitest';

// REQ-VAULT-018, REQ-VAULT-022, REQ-VAULT-024, REQ-VAULT-029:
// Browser scripts must execute from the exact bytes emitted by the production
// bundler. Direct helper tests cannot catch esbuild keepNames helpers captured
// by Function#toString and then evaluated in a separate browser realm.

type VaultInjectors = {
  injectVaultBootstrapHopHtml(sessionId: string, key: string, redirectSearch?: string): string;
  injectVaultPrewarmBridge(html: string, prewarmId?: string): string;
  injectVaultPrewarmFocusGuard(html: string, prewarmId?: string): string;
  injectVaultControlledReload(html: string): string;
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
let injectors: VaultInjectors;

function scriptBodyAt(html: string, openAt: number): string {
  const bodyStart = html.indexOf('>', openAt);
  if (bodyStart === -1) throw new Error('unterminated generated script start tag');
  const bodyEnd = html.indexOf('</script>', bodyStart + 1);
  if (bodyEnd === -1) throw new Error('missing generated script end tag');
  return html.slice(bodyStart + 1, bodyEnd);
}

function scriptBodies(html: string): string[] {
  const bodies: string[] = [];
  let cursor = 0;
  while (true) {
    const openAt = html.indexOf('<script', cursor);
    if (openAt === -1) return bodies;
    bodies.push(scriptBodyAt(html, openAt));
    const closeAt = html.indexOf('</script>', openAt);
    cursor = closeAt + '</script>'.length;
  }
}

function markedScript(html: string, marker: string): string {
  const openAt = html.indexOf(`<script ${marker}="1">`);
  if (openAt === -1) throw new Error(`missing ${marker} browser script`);
  return scriptBodyAt(html, openAt);
}

beforeAll(async () => {
  const entry = [
    "import { injectVaultBootstrapHopHtml, injectVaultPrewarmBridge, injectVaultPrewarmFocusGuard, injectVaultControlledReload } from './src/lib/vault-view.ts';",
    'globalThis.__vaultInjectors = { injectVaultBootstrapHopHtml, injectVaultPrewarmBridge, injectVaultPrewarmFocusGuard, injectVaultControlledReload };',
  ].join('\n');
  const result = await build({
    stdin: { contents: entry, resolveDir: repoRoot, sourcefile: 'vault-browser-bundle-entry.ts' },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    keepNames: true,
  });
  const context = vm.createContext({
    console,
    crypto,
    URL,
    URLSearchParams,
    Request,
    Response,
    Headers,
    TextEncoder,
    TextDecoder,
    btoa: globalThis.btoa,
    atob: globalThis.atob,
  });
  const output = result.outputFiles?.[0];
  if (!output) throw new Error('esbuild emitted no Vault browser bundle');
  vm.runInContext(output.text, context);
  injectors = (context as typeof context & { __vaultInjectors: VaultInjectors }).__vaultInjectors;
  expect(injectors).toBeDefined();
});

describe('production-bundled Vault browser scripts', () => {
  it('removes stale workers, registers the canonical worker, persists encryption, and redirects', async () => {
    const token = '0123456789abcdef0123456789abcdef';
    const hostileKey = '</script><script>globalThis.compromised=true</script>';
    const scope = `https://codeflare.test/api/vault/${token}/`;
    const workerEvents: string[] = [];
    const completionEvents: string[] = [];
    const canonical = { scope, unregister: vi.fn(async () => true) };
    const stale = { scope: 'https://codeflare.test/api/vault/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/', unregister: vi.fn(async () => true) };
    const crossOrigin = { scope: 'https://other.test/api/vault/legacy/', unregister: vi.fn(async () => true) };
    const unrelated = { scope: 'https://codeflare.test/application/', unregister: vi.fn(async () => true) };
    let stalePresent = true;
    stale.unregister.mockImplementation(async () => {
      workerEvents.push('unregister');
      stalePresent = false;
      return true;
    });
    const activeWorker = { state: 'activated', postMessage: vi.fn() };
    const registration: any = { active: activeWorker, installing: null, waiting: null };
    registration.update = vi.fn(async () => registration);
    const register = vi.fn(async () => {
      workerEvents.push('register');
      return registration;
    });
    const serviceWorker = {
      getRegistrations: vi.fn(async () => stalePresent
        ? [canonical, stale, crossOrigin, unrelated]
        : [canonical, crossOrigin, unrelated]),
      register,
    };
    const storage = { setItem: vi.fn(() => { completionEvents.push('storage'); }) };
    let cookie = '';
    const documentRef = {
      getElementById: vi.fn(() => ({ textContent: '' })),
      get cookie() { return cookie; },
      set cookie(value: string) { completionEvents.push('cookie'); cookie = value; },
    };
    const locationRef = {
      origin: 'https://codeflare.test',
      replace: vi.fn(() => { completionEvents.push('redirect'); }),
    };
    const html = injectors.injectVaultBootstrapHopHtml(token, hostileKey, '?codeflarePrewarm=1&prewarmId=warm-1');
    const [script] = scriptBodies(html);

    const completion = vm.runInNewContext(script, {
      navigator: { serviceWorker },
      localStorage: storage,
      document: documentRef,
      location: locationRef,
      console,
      URL,
      setTimeout,
      clearTimeout,
    });
    await completion;

    expect(stale.unregister).toHaveBeenCalledOnce();
    expect(workerEvents).toEqual(['unregister', 'register']);
    expect(completionEvents).toEqual(['storage', 'cookie', 'redirect']);
    expect(canonical.unregister).not.toHaveBeenCalled();
    expect(crossOrigin.unregister).not.toHaveBeenCalled();
    expect(unrelated.unregister).not.toHaveBeenCalled();
    expect(register).toHaveBeenCalledWith(`/api/vault/${token}/service_worker.js`, { scope: `/api/vault/${token}/` });
    expect(activeWorker.postMessage).toHaveBeenCalledWith({ type: 'set-encryption-key', key: hostileKey });
    expect(storage.setItem).toHaveBeenCalledWith('enableEncryption', 'true');
    expect(cookie).toBe(`codeflare_vault_bootstrap=1; Path=/api/vault/${token}/; SameSite=Lax; Secure`);
    expect(locationRef.replace).toHaveBeenCalledWith(`/api/vault/${token}/?codeflarePrewarm=1&prewarmId=warm-1`);
  });

  it('fails closed before registration when a stale Vault worker remains', async () => {
    const token = '0123456789abcdef0123456789abcdef';
    const stale = { scope: 'https://codeflare.test/api/vault/legacy/', unregister: vi.fn(async () => false) };
    const register = vi.fn();
    const serviceWorker = { getRegistrations: vi.fn(async () => [stale]), register };
    const storage = { setItem: vi.fn() };
    const status = { textContent: '' };
    const documentRef = { getElementById: vi.fn(() => status), cookie: '' };
    const locationRef = { origin: 'https://codeflare.test', replace: vi.fn() };
    const [script] = scriptBodies(injectors.injectVaultBootstrapHopHtml(token, 'secret-key'));

    await vm.runInNewContext(script, {
      navigator: { serviceWorker }, localStorage: storage, document: documentRef,
      location: locationRef, console, URL, setTimeout, clearTimeout,
    });

    expect(register).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(documentRef.cookie).toBe('');
    expect(locationRef.replace).not.toHaveBeenCalled();
    expect(status.textContent).toContain('stale Vault service worker remains');
  });

  it('does not complete bootstrap when encryption enablement cannot persist', async () => {
    const token = '0123456789abcdef0123456789abcdef';
    const activeWorker = { state: 'activated', postMessage: vi.fn() };
    const registration: any = { active: activeWorker, installing: null, waiting: null };
    registration.update = vi.fn(async () => registration);
    const serviceWorker = {
      getRegistrations: vi.fn(async () => []),
      register: vi.fn(async () => registration),
    };
    const storage = { setItem: vi.fn(() => { throw new Error('storage denied'); }) };
    const status = { textContent: '' };
    const documentRef = { getElementById: vi.fn(() => status), cookie: '' };
    const locationRef = { origin: 'https://codeflare.test', replace: vi.fn() };
    const [script] = scriptBodies(injectors.injectVaultBootstrapHopHtml(token, 'secret-key'));

    await vm.runInNewContext(script, {
      navigator: { serviceWorker }, localStorage: storage, document: documentRef,
      location: locationRef, console, URL, setTimeout, clearTimeout,
    });

    expect(documentRef.cookie).toBe('');
    expect(locationRef.replace).not.toHaveBeenCalled();
    expect(status.textContent).toContain('storage denied');
  });

  it('installs the focus guard from the bundled injected bytes', () => {
    let htmlFocusCount = 0;
    let svgFocusCount = 0;
    let inputSelectCount = 0;
    let textareaSelectCount = 0;
    let windowFocusCount = 0;
    let blurCount = 0;
    class HtmlElement { focus() { htmlFocusCount += 1; } }
    class SvgElement { focus() { svgFocusCount += 1; } }
    class Input extends HtmlElement { select() { inputSelectCount += 1; } }
    class Textarea extends HtmlElement { select() { textareaSelectCount += 1; } }
    const documentRef = { addEventListener: vi.fn() };
    const windowRef: any = {
      location: { search: '?codeflarePrewarm=1&prewarmId=warm-1' },
      URLSearchParams,
      HTMLElement: HtmlElement,
      SVGElement: SvgElement,
      HTMLInputElement: Input,
      HTMLTextAreaElement: Textarea,
      focus() { windowFocusCount += 1; },
    };
    const html = injectors.injectVaultPrewarmFocusGuard('<html><head></head><body></body></html>', 'warm-1');
    vm.runInNewContext(markedScript(html, 'data-codeflare-vault-prewarm-focus-guard'), {
      window: windowRef,
      document: documentRef,
      URLSearchParams,
      Object,
    });

    new HtmlElement().focus();
    new SvgElement().focus();
    new Input().select();
    new Textarea().select();
    windowRef.focus();
    const focusListener = documentRef.addEventListener.mock.calls[0]?.[1] as ((event: { target: { blur(): void } }) => void) | undefined;
    expect(focusListener).toBeTypeOf('function');
    focusListener!({ target: { blur() { blurCount += 1; } } });

    expect(windowRef.__codeflareVaultPrewarmNoFocus).toBe(true);
    expect(documentRef.addEventListener).toHaveBeenCalledWith('focusin', expect.any(Function), true);
    expect({ htmlFocusCount, svgFocusCount, inputSelectCount, textareaSelectCount, windowFocusCount, blurCount }).toEqual({
      htmlFocusCount: 0,
      svgFocusCount: 0,
      inputSelectCount: 0,
      textareaSelectCount: 0,
      windowFocusCount: 0,
      blurCount: 1,
    });
  });

  it('leaves generic non-prewarm focus and select behavior unchanged', () => {
    let focusCount = 0;
    let selectCount = 0;
    class Element { focus() { focusCount += 1; } }
    class Input extends Element { select() { selectCount += 1; } }
    const documentRef = { addEventListener: vi.fn() };
    const windowRef: any = {
      location: { search: '' },
      URLSearchParams,
      HTMLElement: Element,
      SVGElement: Element,
      HTMLInputElement: Input,
      HTMLTextAreaElement: Input,
      focus() { focusCount += 1; },
    };
    const html = injectors.injectVaultPrewarmFocusGuard('<html><head></head><body></body></html>');
    vm.runInNewContext(markedScript(html, 'data-codeflare-vault-prewarm-focus-guard'), {
      window: windowRef,
      document: documentRef,
      URLSearchParams,
      Object,
    });
    new Element().focus();
    new Input().select();
    windowRef.focus();

    expect(windowRef.__codeflareVaultPrewarmNoFocus).toBeUndefined();
    expect(documentRef.addEventListener).not.toHaveBeenCalled();
    expect(focusCount).toBe(2);
    expect(selectCount).toBe(1);
  });

  it('posts ready only after two complete bundled bridge polls', async () => {
    const scope = 'https://codeflare.test/api/vault/0123456789abcdef0123456789abcdef/';
    let poll: (() => Promise<void>) | undefined;
    let queueReady = true;
    const parent = { postMessage: vi.fn() };
    const windowRef: any = {
      location: { origin: 'https://codeflare.test', search: '' },
      parent,
      sbRuntime: { ready: true },
      client: {
        fullSyncCompleted: true,
        systemReady: true,
        pageListLoaded: true,
        clientSystem: { scriptsLoaded: true },
        objectIndex: { hasFullIndexCompleted: vi.fn(async () => true) },
        mq: { getQueueStats: vi.fn(async () => queueReady
          ? { queued: 0, processing: 0, dlq: 0 }
          : { queued: 1, processing: 0, dlq: 0 }) },
      },
      setInterval: vi.fn((callback: () => Promise<void>) => { poll = callback; return 17; }),
      clearInterval: vi.fn(),
    };
    const fetchRef = vi.fn(async () => ({
      ok: true,
      json: async () => ['CONFIG.md', 'Index.md', 'STYLES.md'].map((name) => ({ name })),
    }));
    const html = injectors.injectVaultPrewarmBridge('<html><head></head><body></body></html>', 'warm-1');
    vm.runInNewContext(markedScript(html, 'data-codeflare-vault-prewarm-bridge'), {
      window: windowRef,
      document: { baseURI: scope },
      navigator: { serviceWorker: { addEventListener: vi.fn() } },
      fetch: fetchRef,
      URL,
      URLSearchParams,
      Set,
      Error,
    });

    expect(poll).toBeTypeOf('function');
    await poll!(); // first complete proof
    expect(parent.postMessage).not.toHaveBeenCalled();
    queueReady = false;
    await poll!(); // incomplete proof resets the streak
    queueReady = true;
    await poll!(); // first complete proof after reset
    expect(parent.postMessage).not.toHaveBeenCalled();
    await poll!(); // second consecutive complete proof
    expect(parent.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      source: 'codeflare-vault-prewarm',
      prewarmId: 'warm-1',
      status: 'ready',
      proof: expect.objectContaining({ scope, contentReady: true, indexReady: true }),
    }), 'https://codeflare.test');
  });

  it('withholds bundled ready proof when any acceptance-critical gate is incomplete', async () => {
    const scope = 'https://codeflare.test/api/vault/0123456789abcdef0123456789abcdef/';
    const scenarios: Array<{
      name: string;
      mutate(windowRef: any, response: { ok: boolean; listing: unknown }): void;
    }> = [
      { name: 'runtime', mutate: (windowRef) => { windowRef.sbRuntime.ready = false; } },
      { name: 'sync', mutate: (windowRef) => { windowRef.client.fullSyncCompleted = false; } },
      { name: 'system', mutate: (windowRef) => { windowRef.client.systemReady = false; } },
      { name: 'pages', mutate: (windowRef) => { windowRef.client.pageListLoaded = false; } },
      { name: 'scripts', mutate: (windowRef) => { windowRef.client.clientSystem.scriptsLoaded = false; } },
      { name: 'index API', mutate: (windowRef) => { windowRef.client.objectIndex = {}; } },
      { name: 'queue', mutate: (windowRef) => { windowRef.client.mq.getQueueStats = async () => ({ queued: 1, processing: 0, dlq: 0 }); } },
      { name: 'index completion', mutate: (windowRef) => { windowRef.client.objectIndex.hasFullIndexCompleted = async () => false; } },
      { name: 'listing response', mutate: (_windowRef, response) => { response.ok = false; } },
      { name: 'listing shape', mutate: (_windowRef, response) => { response.listing = {}; } },
      { name: 'required files', mutate: (_windowRef, response) => { response.listing = [{ name: 'CONFIG.md' }, { name: 'Index.md' }]; } },
    ];

    for (const scenario of scenarios) {
      let poll: (() => Promise<void>) | undefined;
      const parent = { postMessage: vi.fn() };
      const windowRef: any = {
        location: { origin: 'https://codeflare.test', search: '' },
        parent,
        sbRuntime: { ready: true },
        client: {
          fullSyncCompleted: true,
          systemReady: true,
          pageListLoaded: true,
          clientSystem: { scriptsLoaded: true },
          objectIndex: { hasFullIndexCompleted: async () => true },
          mq: { getQueueStats: async () => ({ queued: 0, processing: 0, dlq: 0 }) },
        },
        setInterval(callback: () => Promise<void>) { poll = callback; return 17; },
        clearInterval: vi.fn(),
      };
      const response = {
        ok: true,
        listing: ['CONFIG.md', 'Index.md', 'STYLES.md'].map((name) => ({ name })) as unknown,
      };
      scenario.mutate(windowRef, response);
      const fetchRef = vi.fn(async () => ({ ok: response.ok, json: async () => response.listing }));
      const html = injectors.injectVaultPrewarmBridge('<html><head></head><body></body></html>', 'warm-1');
      vm.runInNewContext(markedScript(html, 'data-codeflare-vault-prewarm-bridge'), {
        window: windowRef,
        document: { baseURI: scope },
        navigator: { serviceWorker: { addEventListener: vi.fn() } },
        fetch: fetchRef,
        URL,
        URLSearchParams,
        Set,
        Error,
      });

      expect(poll, scenario.name).toBeTypeOf('function');
      await poll!();
      await poll!();
      expect(parent.postMessage, scenario.name).not.toHaveBeenCalled();
    }
  });

  it('performs the exact-scope one-shot reload from bundled injected bytes', async () => {
    const scope = 'https://codeflare.test/api/vault/0123456789abcdef0123456789abcdef/';
    const storage = { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() };
    const locationRef = { origin: 'https://codeflare.test', reload: vi.fn() };
    const windowRef: any = { document: { baseURI: scope }, location: locationRef, sessionStorage: storage };
    windowRef.parent = windowRef;
    const registration = { scope, active: {} };
    const navigatorRef = { serviceWorker: { controller: null, getRegistration: vi.fn(async () => registration) } };
    const html = injectors.injectVaultControlledReload('<html><head></head><body></body></html>');
    vm.runInNewContext(markedScript(html, 'data-codeflare-vault-controlled-reload'), {
      window: windowRef,
      navigator: navigatorRef,
      URL,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(storage.setItem).toHaveBeenCalledWith('cf-vault-sw-controlled-reload', '1');
    expect(locationRef.reload).toHaveBeenCalledOnce();
  });

  it('clears the one-shot without reloading when the exact worker already controls the page', () => {
    const scope = 'https://codeflare.test/api/vault/0123456789abcdef0123456789abcdef/';
    const storage = { getItem: vi.fn(() => '1'), setItem: vi.fn(), removeItem: vi.fn() };
    const locationRef = { origin: 'https://codeflare.test', reload: vi.fn() };
    const windowRef: any = { document: { baseURI: scope }, location: locationRef, sessionStorage: storage };
    windowRef.parent = windowRef;
    const navigatorRef = {
      serviceWorker: {
        controller: { scriptURL: `${scope}service_worker.js` },
        getRegistration: vi.fn(),
      },
    };
    const script = markedScript(
      injectors.injectVaultControlledReload('<html><head></head><body></body></html>'),
      'data-codeflare-vault-controlled-reload',
    );
    vm.runInNewContext(script, { window: windowRef, navigator: navigatorRef, URL });

    expect(storage.removeItem).toHaveBeenCalledWith('cf-vault-sw-controlled-reload');
    expect(locationRef.reload).not.toHaveBeenCalled();
    expect(navigatorRef.serviceWorker.getRegistration).not.toHaveBeenCalled();
  });

  it('keeps controlled reload inert when service workers are unsupported', () => {
    const scope = 'https://codeflare.test/api/vault/0123456789abcdef0123456789abcdef/';
    const storage = { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() };
    const locationRef = { origin: 'https://codeflare.test', reload: vi.fn() };
    const windowRef: any = { document: { baseURI: scope }, location: locationRef, sessionStorage: storage };
    windowRef.parent = windowRef;
    const script = markedScript(
      injectors.injectVaultControlledReload('<html><head></head><body></body></html>'),
      'data-codeflare-vault-controlled-reload',
    );
    vm.runInNewContext(script, { window: windowRef, navigator: {}, URL });

    expect(locationRef.reload).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
  });

  it('keeps bundled controlled reload inert for prewarm, first boot, orphaned scope, and a spent one-shot', async () => {
    const scope = 'https://codeflare.test/api/vault/0123456789abcdef0123456789abcdef/';
    const script = markedScript(
      injectors.injectVaultControlledReload('<html><head></head><body></body></html>'),
      'data-codeflare-vault-controlled-reload',
    );
    const run = async (options: { iframe?: boolean; registration?: unknown; spent?: boolean }) => {
      const storage = {
        getItem: vi.fn(() => options.spent ? '1' : null),
        setItem: vi.fn(),
        removeItem: vi.fn(),
      };
      const locationRef = { origin: 'https://codeflare.test', reload: vi.fn() };
      const windowRef: any = { document: { baseURI: scope }, location: locationRef, sessionStorage: storage };
      windowRef.parent = options.iframe ? {} : windowRef;
      const navigatorRef = {
        serviceWorker: { controller: null, getRegistration: vi.fn(async () => options.registration) },
      };
      vm.runInNewContext(script, { window: windowRef, navigator: navigatorRef, URL });
      await Promise.resolve();
      await Promise.resolve();
      return { storage, locationRef, navigatorRef };
    };

    const prewarm = await run({ iframe: true, registration: { scope, active: {} } });
    const firstBoot = await run({ registration: undefined });
    const orphaned = await run({ registration: { scope: 'https://codeflare.test/api/vault/legacy/', active: {} } });
    const spent = await run({ registration: { scope, active: {} }, spent: true });

    expect(prewarm.navigatorRef.serviceWorker.getRegistration).not.toHaveBeenCalled();
    expect(firstBoot.locationRef.reload).not.toHaveBeenCalled();
    expect(orphaned.locationRef.reload).not.toHaveBeenCalled();
    expect(spent.locationRef.reload).not.toHaveBeenCalled();
    expect(spent.storage.setItem).not.toHaveBeenCalled();
  });
});
