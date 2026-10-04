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

const token = '0123456789abcdef0123456789abcdef';
const scope = `https://codeflare.test/api/vault/${token}/`;
const canonicalScript = `${scope}service_worker.js`;

// Browser-platform events and paired ports. The injected bundled scripts, not
// their private helpers, own all waiting, identity checks and completion logic.
class BrowserPort extends EventTarget {
  peer!: BrowserPort;
  onmessage: ((event: MessageEvent) => void) | null = null;
  closed = false;
  postMessage(data: unknown) {
    const peer = this.peer;
    queueMicrotask(() => {
      if (peer.closed) return;
      const event = new MessageEvent('message', { data });
      peer.dispatchEvent(event);
      peer.onmessage?.(event);
    });
  }
  start() {}
  close() { this.closed = true; }
}
class BrowserChannel {
  port1 = new BrowserPort();
  port2 = new BrowserPort();
  constructor() { this.port1.peer = this.port2; this.port2.peer = this.port1; }
}
class BrowserWorker extends EventTarget {
  messages: unknown[] = [];
  private keyPort?: BrowserPort;
  constructor(public state = 'activated', public scriptURL = canonicalScript, private autoAck = false) { super(); }
  postMessage(data: { type: string }, transfer?: BrowserPort[] | { transfer?: BrowserPort[] }) {
    this.messages.push(data);
    if (data.type === 'set-encryption-key') {
      this.keyPort = Array.isArray(transfer) ? transfer[0] : transfer?.transfer?.[0];
      if (this.autoAck) this.ack();
    }
  }
  ack(data: unknown = { type: 'encryption-key-set' }) { this.keyPort?.postMessage(data); }
  transition(state: string) { this.state = state; this.dispatchEvent(new Event('statechange')); }
}
type BrowserRegistration = EventTarget & {
  scope: string;
  active: BrowserWorker | null;
  installing: BrowserWorker | null;
  waiting: BrowserWorker | null;
  update(): Promise<BrowserRegistration>;
};
class BrowserServiceWorkers extends EventTarget {
  constructor(public controller: BrowserWorker | null) { super(); }
  control(worker: BrowserWorker | null) { this.controller = worker; this.dispatchEvent(new Event('controllerchange')); }
  broadcast(source: BrowserWorker | null, data = { type: 'space-sync-complete' }) {
    this.dispatchEvent(Object.assign(new Event('message'), { data, source }));
  }
}
async function flushBrowserTasks() {
  // Flush only microtasks; browser deadlines are driven explicitly below.
  for (let i = 0; i < 32; i += 1) await Promise.resolve();
}
function bootstrapBrowser(options: { upgrade?: boolean; firstLoad?: boolean; storageDenied?: boolean } = {}) {
  const old = new BrowserWorker('activated', canonicalScript, true);
  const next = new BrowserWorker(options.upgrade || options.firstLoad ? 'installing' : 'activated');
  const serviceWorker = Object.assign(new BrowserServiceWorkers(options.firstLoad ? null : old), {
    getRegistrations: async () => [],
    register: async (_url: string, _options: unknown) => registration,
    getRegistration: async () => registration,
  });
  const registration: BrowserRegistration = Object.assign(new EventTarget(), {
    scope, active: options.firstLoad ? null : old,
    installing: options.upgrade || options.firstLoad ? next : null,
    waiting: null,
    update: async () => registration,
  });
  const storage = new Map<string, string>();
  const status = { textContent: 'Loading vault…' };
  const documentRef = { cookie: '', getElementById: () => status };
  const redirects: string[] = [];
  const timers = new Map<number, () => void>();
  let timerId = 0;
  const [script] = scriptBodies(injectors.injectVaultBootstrapHopHtml(token, 'secret-key'));
  const completion = vm.runInNewContext(script, {
    navigator: { serviceWorker },
    localStorage: { setItem(key: string, value: string) {
      if (options.storageDenied) throw new Error('storage denied');
      storage.set(key, value);
    } },
    document: documentRef,
    location: { origin: 'https://codeflare.test', href: `${scope}.codeflare-bootstrap`, replace: (url: string) => redirects.push(url) },
    console, URL, MessageChannel: BrowserChannel,
    setTimeout(callback: () => void) { timers.set(++timerId, callback); return timerId; },
    clearTimeout(id: number) { timers.delete(id); },
  }) as Promise<void>;
  return {
    old, next, serviceWorker, registration, storage, status, documentRef, redirects, completion,
    activate() {
      registration.active = next;
      registration.installing = null;
      next.transition('activated');
    },
    async expireDeadlines() {
      // Allow successive activation/control/key-ACK deadlines without wall-clock waits.
      for (let round = 0; round < 4; round += 1) {
        await flushBrowserTasks();
        const callbacks = [...timers.values()];
        timers.clear();
        for (const callback of callbacks) callback();
      }
      await flushBrowserTasks();
    },
  };
}
function expectBootstrapPending(browser: ReturnType<typeof bootstrapBrowser>) {
  expect(browser.storage.get('enableEncryption')).toBeUndefined();
  expect(browser.documentRef.cookie).toBe('');
  expect(browser.redirects).toEqual([]);
}

function prewarmBrowser() {
  const current = new BrowserWorker();
  const serviceWorker = new BrowserServiceWorkers(current);
  const messages: Array<{ payload: any; origin: string }> = [];
  let poll!: () => Promise<void>;
  let running = true;
  const response = { ok: true, listing: ['CONFIG.md', 'Index.md', 'STYLES.md'].map(name => ({ name })) as unknown };
  const windowRef = {
    location: { origin: 'https://codeflare.test', search: '' },
    parent: { postMessage(payload: unknown, origin: string) { messages.push({ payload, origin }); } },
    sbRuntime: { ready: true },
    client: {
      // SilverBullet sets this from unscoped broadcasts; never use it as worker identity proof.
      fullSyncCompleted: true, systemReady: true, pageListLoaded: true,
      clientSystem: { scriptsLoaded: true },
      objectIndex: { hasFullIndexCompleted: async () => true },
      mq: { getQueueStats: async () => ({ queued: 0, processing: 0, dlq: 0 }) },
    },
    setInterval(callback: () => Promise<void>) { poll = callback; return 17; },
    clearInterval() { running = false; },
  };
  let fetchListing = async () => ({ ok: response.ok, json: async () => response.listing });
  const html = injectors.injectVaultPrewarmBridge('<html><head></head><body></body></html>', 'warm-1');
  vm.runInNewContext(markedScript(html, 'data-codeflare-vault-prewarm-bridge'), {
    window: windowRef, document: { baseURI: scope }, navigator: { serviceWorker },
    fetch: () => fetchListing(), URL, URLSearchParams, Set, Error,
  });
  return {
    current, serviceWorker, windowRef, response, messages,
    setListingFetch(fetcher: typeof fetchListing) { fetchListing = fetcher; },
    async poll() { if (running) await poll(); },
  };
}
function expectPrewarmReady(browser: ReturnType<typeof prewarmBrowser>) {
  expect(browser.messages).toEqual([{ origin: 'https://codeflare.test', payload: {
    source: 'codeflare-vault-prewarm', prewarmId: 'warm-1', status: 'ready',
    proof: { scope, contentReady: true, spaceSyncCompleted: true, indexReady: true,
      requiredFiles: ['CONFIG.md', 'Index.md', 'STYLES.md'], listedFileCount: 3 },
  } }]);
}

describe('production-bundled Vault browser scripts', () => {
  it('REQ-VAULT-024: removes stale workers, registers the canonical worker, persists encryption, and redirects', async () => {
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
    const activeWorker = new BrowserWorker('activated', `${scope}service_worker.js`, true);
    const registration: any = Object.assign(new EventTarget(), { scope, active: activeWorker, installing: null, waiting: null });
    registration.update = vi.fn(async () => registration);
    const register = vi.fn(async () => {
      workerEvents.push('register');
      return registration;
    });
    const serviceWorker = Object.assign(new BrowserServiceWorkers(activeWorker), {
      getRegistrations: vi.fn(async () => stalePresent
        ? [canonical, stale, crossOrigin, unrelated]
        : [canonical, crossOrigin, unrelated]),
      getRegistration: async () => registration,
      register,
    });
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
      MessageChannel: BrowserChannel,
      setTimeout,
      clearTimeout,
    });
    await completion;

    expect((await serviceWorker.getRegistrations()).map(item => item.scope)).toEqual([scope, crossOrigin.scope, unrelated.scope]);
    expect(workerEvents).toEqual(['unregister', 'register']);
    expect(completionEvents).toEqual(['storage', 'cookie', 'redirect']);
    expect(canonical.unregister).not.toHaveBeenCalled();
    expect(crossOrigin.unregister).not.toHaveBeenCalled();
    expect(unrelated.unregister).not.toHaveBeenCalled();
    expect(register).toHaveBeenCalledWith(`/api/vault/${token}/service_worker.js`, { scope: `/api/vault/${token}/` });
    expect(activeWorker.messages).toEqual([{ type: 'set-encryption-key', key: hostileKey }]);
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

  it('REQ-VAULT-024: does not complete bootstrap when encryption enablement cannot persist', async () => {
    const browser = bootstrapBrowser({ storageDenied: true });
    await browser.completion;
    expectBootstrapPending(browser);
    expect(browser.status.textContent).toContain('storage denied');
  });

  it('REQ-VAULT-024: A active/B installing upgrade waits for B activation, control and its native key acknowledgement', async () => {
    const browser = bootstrapBrowser({ upgrade: true });
    await flushBrowserTasks();
    expectBootstrapPending(browser);
    expect(browser.old.messages).not.toContainEqual(expect.objectContaining({ type: 'set-encryption-key' })); // never key retiring A
    expect(browser.next.messages).not.toContainEqual(expect.objectContaining({ type: 'set-encryption-key' }));

    browser.activate();
    await flushBrowserTasks();
    expectBootstrapPending(browser); // activation alone is not control
    expect(browser.old.messages).not.toContainEqual(expect.objectContaining({ type: 'set-encryption-key' }));
    browser.serviceWorker.control(browser.next);
    await flushBrowserTasks();
    expect(browser.next.messages).toContainEqual({ type: 'set-encryption-key', key: 'secret-key' });
    expectBootstrapPending(browser); // posting is not the asynchronous native AES ACK

    browser.next.ack();
    await browser.completion;
    expect(browser.storage.get('enableEncryption')).toBe('true');
    expect(browser.documentRef.cookie).toBe(`codeflare_vault_bootstrap=1; Path=/api/vault/${token}/; SameSite=Lax; Secure`);
    expect(browser.redirects).toEqual([`/api/vault/${token}/`]);
    expect(browser.old.messages).not.toContainEqual(expect.objectContaining({ type: 'set-encryption-key' }));
  });

  it('REQ-VAULT-024: first-load bootstrap waits for canonical worker control and acknowledged encryption before completing', async () => {
    const browser = bootstrapBrowser({ firstLoad: true });
    await flushBrowserTasks();
    expectBootstrapPending(browser);
    browser.activate();
    await flushBrowserTasks();
    expectBootstrapPending(browser);
    browser.serviceWorker.control(browser.next);
    await flushBrowserTasks();
    expect(browser.next.messages).toContainEqual({ type: 'set-encryption-key', key: 'secret-key' });
    expectBootstrapPending(browser);
    browser.next.ack();
    await browser.completion;
    expect(browser.storage.get('enableEncryption')).toBe('true');
    expect(browser.redirects).toEqual([`/api/vault/${token}/`]);
  });

  it.each(['missing', 'wrong'] as const)('REQ-VAULT-024: %s native MessagePort ACK fails closed without bootstrap completion', async ack => {
    const browser = bootstrapBrowser();
    // Healthy reuse, but A deliberately does not acknowledge this handoff.
    const worker = new BrowserWorker();
    browser.registration.active = worker;
    browser.serviceWorker.control(worker);
    await flushBrowserTasks();
    expect(worker.messages).toEqual([{ type: 'set-encryption-key', key: 'secret-key' }]);
    if (ack === 'wrong') worker.ack({ type: 'encryption-key', key: 'secret-key' });
    await browser.expireDeadlines();
    await browser.completion;
    expectBootstrapPending(browser);
    expect(browser.status.textContent).toContain('Vault could not start encryption:');
    expect(browser.status.textContent).toContain('Reload to retry.');
  });

  it.each(['activation', 'controller'] as const)('REQ-VAULT-024: upgrade %s deadline fails closed rather than arming retiring A', async deadline => {
    const browser = bootstrapBrowser({ upgrade: true });
    await flushBrowserTasks();
    if (deadline === 'controller') { browser.activate(); await flushBrowserTasks(); }
    await browser.expireDeadlines();
    await browser.completion;
    expectBootstrapPending(browser);
    expect(browser.old.messages).not.toContainEqual(expect.objectContaining({ type: 'set-encryption-key' }));
    expect(browser.status.textContent).toContain('Vault could not start encryption:');
    expect(browser.status.textContent).toContain('Reload to retry.');
  });

  it('REQ-VAULT-024: replacing the controller after key handoff fences even a correct old-worker ACK', async () => {
    const browser = bootstrapBrowser();
    const worker = new BrowserWorker();
    browser.registration.active = worker;
    browser.serviceWorker.control(worker);
    await flushBrowserTasks();
    expect(worker.messages).toEqual([{ type: 'set-encryption-key', key: 'secret-key' }]);
    expectBootstrapPending(browser);
    const replacement = new BrowserWorker();
    browser.registration.active = replacement;
    browser.serviceWorker.control(replacement);
    worker.ack();
    await browser.expireDeadlines();
    await browser.completion;
    expectBootstrapPending(browser);
    expect(replacement.messages).toEqual([]);
    expect(browser.status.textContent).toContain('Vault could not start encryption:');
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

  it('REQ-VAULT-018: posts ready only after two complete bundled bridge polls from the current canonical controller', async () => {
    const browser = prewarmBrowser();
    browser.serviceWorker.broadcast(browser.current);
    await browser.poll();
    expect(browser.messages).toEqual([]);
    browser.windowRef.client.mq.getQueueStats = async () => ({ queued: 1, processing: 0, dlq: 0 });
    await browser.poll(); // incomplete proof resets the streak
    browser.windowRef.client.mq.getQueueStats = async () => ({ queued: 0, processing: 0, dlq: 0 });
    await browser.poll();
    expect(browser.messages).toEqual([]);
    await browser.poll();
    expectPrewarmReady(browser);
    await browser.poll(); // the platform timer has been cleared after ready
    expectPrewarmReady(browser);
    expect(browser.windowRef.sbRuntime).toEqual({ ready: true, headless: true });
  });

  it.each(['foreign', 'retiring', 'no broadcast'] as const)('REQ-VAULT-018: %s completion cannot certify readiness through the unscoped native fullSyncCompleted flag', async source => {
    const browser = prewarmBrowser();
    if (source !== 'no broadcast') browser.serviceWorker.broadcast(source === 'foreign'
      ? new BrowserWorker('activated', 'https://codeflare.test/api/vault/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/service_worker.js')
      : new BrowserWorker()); // same script URL, different retiring worker identity
    await browser.poll();
    await browser.poll();
    expect(browser.messages).toEqual([]);
    browser.serviceWorker.broadcast(browser.current);
    await browser.poll();
    expect(browser.messages).toEqual([]);
    await browser.poll();
    expectPrewarmReady(browser);
  });

  it.each(['no controller', 'no source'] as const)('REQ-VAULT-018: %s cannot certify current-worker sync despite the native global completion flag', async missing => {
    const browser = prewarmBrowser();
    if (missing === 'no controller') browser.serviceWorker.control(null);
    browser.serviceWorker.broadcast(missing === 'no source' ? null : browser.current);
    await browser.poll();
    await browser.poll();
    expect(browser.messages).toEqual([]);
    browser.serviceWorker.control(browser.current);
    browser.serviceWorker.broadcast(browser.current);
    await browser.poll();
    expect(browser.messages).toEqual([]);
    await browser.poll();
    expectPrewarmReady(browser);
  });

  it('REQ-VAULT-018: even a controller-origin completion is rejected when the controller script is not canonical', async () => {
    const browser = prewarmBrowser();
    const foreign = new BrowserWorker('activated', 'https://codeflare.test/application/service_worker.js');
    browser.serviceWorker.control(foreign);
    browser.serviceWorker.broadcast(foreign);
    await browser.poll();
    await browser.poll();
    expect(browser.messages).toEqual([]);
  });

  it('REQ-VAULT-018: controller replacement clears sync evidence even when the upstream flag remains true', async () => {
    const browser = prewarmBrowser();
    browser.serviceWorker.broadcast(browser.current);
    await browser.poll();
    expect(browser.messages).toEqual([]);
    const next = new BrowserWorker();
    browser.serviceWorker.control(next);
    browser.serviceWorker.broadcast(browser.current); // delayed retiring broadcast
    await browser.poll();
    await browser.poll();
    expect(browser.messages).toEqual([]);
    browser.serviceWorker.broadcast(next);
    await browser.poll();
    expect(browser.messages).toEqual([]);
    await browser.poll();
    expectPrewarmReady(browser);
  });

  it('REQ-VAULT-018: a newly completed controller starts a fresh two-poll streak rather than inheriting the old controller poll', async () => {
    const browser = prewarmBrowser();
    browser.serviceWorker.broadcast(browser.current);
    await browser.poll();
    const next = new BrowserWorker();
    browser.serviceWorker.control(next);
    browser.serviceWorker.broadcast(next);
    await browser.poll();
    expect(browser.messages).toEqual([]);
    await browser.poll();
    expectPrewarmReady(browser);
  });

  it.each(['queue', 'index', 'fetch', 'json'] as const)('REQ-VAULT-018: controller replacement during in-flight %s proof cannot publish or contribute a ready poll', async boundary => {
    const browser = prewarmBrowser();
    browser.serviceWorker.broadcast(browser.current);
    await browser.poll(); // one complete A poll: the blocked poll would otherwise publish
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    const block = async () => { entered(); await pending; };
    if (boundary === 'queue') browser.windowRef.client.mq.getQueueStats = async () => {
      await block(); return { queued: 0, processing: 0, dlq: 0 };
    };
    if (boundary === 'index') browser.windowRef.client.objectIndex.hasFullIndexCompleted = async () => {
      await block(); return true;
    };
    if (boundary === 'fetch' || boundary === 'json') browser.setListingFetch(async () => {
      if (boundary === 'fetch') await block();
      return { ok: true, json: async () => {
        if (boundary === 'json') await block();
        return browser.response.listing;
      } };
    });
    const inFlight = browser.poll();
    await started;
    const next = new BrowserWorker();
    browser.serviceWorker.control(next);
    browser.serviceWorker.broadcast(next); // even fresh B evidence cannot validate an A read
    release();
    await inFlight;
    expect(browser.messages).toEqual([]);
    await browser.poll();
    expect(browser.messages).toEqual([]);
    await browser.poll();
    expectPrewarmReady(browser);
  });

  it('REQ-VAULT-018: an unexpected runtime failure publishes the existing parent error rather than a ready proof', async () => {
    const browser = prewarmBrowser();
    browser.serviceWorker.broadcast(browser.current);
    Object.defineProperty(browser.windowRef.sbRuntime, 'ready', { get() { throw new Error('runtime failed'); } });
    await browser.poll();
    expect(browser.messages).toEqual([{ origin: 'https://codeflare.test', payload: {
      source: 'codeflare-vault-prewarm', prewarmId: 'warm-1', status: 'error', message: 'runtime failed',
    } }]);
  });

  it('REQ-VAULT-018: withholds bundled ready proof when any acceptance-critical gate is incomplete despite current-worker sync', async () => {
    const scenarios: Array<{
      name: string;
      mutate(windowRef: any, response: { ok: boolean; listing: unknown }): void;
    }> = [
      { name: 'runtime', mutate: (windowRef) => { windowRef.sbRuntime.ready = false; } },
      { name: 'system', mutate: (windowRef) => { windowRef.client.systemReady = false; } },
      { name: 'pages', mutate: (windowRef) => { windowRef.client.pageListLoaded = false; } },
      { name: 'scripts', mutate: (windowRef) => { windowRef.client.clientSystem.scriptsLoaded = false; } },
      { name: 'index API', mutate: (windowRef) => { windowRef.client.objectIndex = {}; } },
      { name: 'queued', mutate: (windowRef) => { windowRef.client.mq.getQueueStats = async () => ({ queued: 1, processing: 0, dlq: 0 }); } },
      { name: 'processing', mutate: (windowRef) => { windowRef.client.mq.getQueueStats = async () => ({ queued: 0, processing: 1, dlq: 0 }); } },
      { name: 'dead letters', mutate: (windowRef) => { windowRef.client.mq.getQueueStats = async () => ({ queued: 0, processing: 0, dlq: 1 }); } },
      { name: 'index completion', mutate: (windowRef) => { windowRef.client.objectIndex.hasFullIndexCompleted = async () => false; } },
      { name: 'listing response', mutate: (_windowRef, response) => { response.ok = false; } },
      { name: 'listing shape', mutate: (_windowRef, response) => { response.listing = {}; } },
      { name: 'required files', mutate: (_windowRef, response) => { response.listing = [{ name: 'CONFIG.md' }, { name: 'Index.md' }]; } },
    ];
    for (const scenario of scenarios) {
      const browser = prewarmBrowser();
      browser.serviceWorker.broadcast(browser.current);
      scenario.mutate(browser.windowRef, browser.response);
      await browser.poll();
      await browser.poll();
      expect(browser.messages, scenario.name).toEqual([]);
    }
  });

  it('REQ-VAULT-022: performs the exact-scope one-shot reload from bundled injected bytes', async () => {
    const scope = 'https://codeflare.test/api/vault/0123456789abcdef0123456789abcdef/';
    const storage = { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() };
    const navigation: string[] = [];
    const locationRef = { origin: 'https://codeflare.test', reload: () => { navigation.push('reload'); } };
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
    expect(navigation).toEqual(['reload']); // intentional one-shot navigation contract
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
