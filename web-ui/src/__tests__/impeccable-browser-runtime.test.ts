import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { setImmediate } from 'node:timers';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Exercise shipped function bodies with a real DOM; isolate network and GPU boundaries.
function browser(agent: string, names: string[], globals: Record<string, unknown> = {}) {
  const source = readFileSync(resolve(process.cwd(), `../preseed/agents/${agent}/skills/impeccable/scripts/live-browser.js`), 'utf8');
  const context = createContext({ document, window, console, ...globals });
  for (const name of names) {
    const start = source.search(new RegExp(`^  (?:async )?function ${name}\\(`, 'm'));
    const end = source.indexOf('\n  }', start);
    if (start < 0 || end < start) throw new Error(`Missing shipped function: ${name}`);
    runInContext(source.slice(start, end + 4), context);
  }
  return context;
}

// Load the complete shipped client and its real DOM/session collaborators in a
// fresh page. Only browser timing, media queries and the HTTP/SSE boundary are
// substituted; reloads share browser storage, not Live's in-memory state.
function livePage(agent: string, options: {
  token?: string;
  now?: number;
  touch?: boolean;
  html?: string;
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  session?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
} = {}) {
  vi.useFakeTimers();
  const frame = document.createElement('iframe');
  document.body.appendChild(frame);
  const page = frame.contentWindow as Window & typeof globalThis;
  const doc = frame.contentDocument!;
  doc.body.innerHTML = options.html || '';
  Object.defineProperty(doc, 'readyState', { value: 'complete' });
  const storage = options.storage || localStorage;
  const session = options.session || sessionStorage;
  Object.defineProperty(page, 'localStorage', { value: storage });
  Object.defineProperty(page, 'sessionStorage', { value: session });
  const matchMedia = (query: string) => ({ matches: options.touch === true && query === '(pointer: coarse)' });
  Object.defineProperty(page, 'matchMedia', { value: matchMedia });
  Object.assign(page, { __IMPECCABLE_TOKEN__: options.token || 'test', __IMPECCABLE_PORT__: 8080 });
  const events: Array<Record<string, unknown>> = [];
  let stream: { onmessage?: (event: { data: string }) => void } | undefined;
  class EventSource {
    onmessage?: (event: { data: string }) => void;
    constructor() { stream = this; }
    close() {}
  }
  const context = createContext({
    window: page, document: doc, history: page.history, location: page.location,
    navigator: page.navigator, localStorage: storage, sessionStorage: session,
    console, EventSource, matchMedia, performance, URL,
    NodeFilter: page.NodeFilter, MouseEvent: page.MouseEvent,
    Date: class extends Date { static now() { return options.now ?? 100_000; } },
    Event: page.Event, CustomEvent: page.CustomEvent, Node: page.Node,
    MutationObserver: page.MutationObserver, AbortController: page.AbortController,
    getComputedStyle: page.getComputedStyle.bind(page),
    setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 16),
    cancelAnimationFrame: clearTimeout,
    fetch: async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') events.push(JSON.parse(String(init.body)));
      return { ok: true, json: async () => ({ count: 0, agentPolling: false, edits: [] }) };
    },
  });
  for (const file of ['live-browser-session.js', 'live-browser-dom.js', 'live-browser.js']) {
    runInContext(readFileSync(resolve(process.cwd(), `../preseed/agents/${agent}/skills/impeccable/scripts/${file}`), 'utf8'), context);
  }
  return {
    doc, events,
    message(data: Record<string, unknown>) {
      if (!stream?.onmessage) throw new Error('Live did not open its event stream');
      stream.onmessage({ data: JSON.stringify(data) });
    },
  };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
afterEach(() => {
  document.body.replaceChildren();
  sessionStorage.clear();
  if (vi.isFakeTimers()) {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
  vi.restoreAllMocks();
});

for (const agent of ['claude', 'pi']) describe(`REQ-AGENT-181: ${agent} native browser runtime`, () => {
  for (const scenario of [
    { name: 'present marker', status: 200, text: '<div data-impeccable-variants="session"></div>', discard: false },
    { name: 'missing marker', status: 200, text: '<main></main>', discard: true },
    { name: 'missing source', status: 404, text: '', discard: true },
    { name: 'server failure', status: 503, text: '', discard: false },
    { name: 'transport failure', status: 0, text: '', discard: false },
  ]) it(`preserves or discards recovery based on ${scenario.name}`, async () => {
    const events: unknown[] = [];
    const context = browser(agent, ['sourceHasSessionWrapper', 'discardOrphanedSession', 'probeJsxWrapperForOrphan'], {
      PORT: 8080, TOKEN: 'test', currentSessionId: 'session', state: 'GENERATING',
      COMPLETED_SOURCE_FALLBACK_RETRIES: 2,
      fetch: async () => {
        if (!scenario.status) throw new Error('offline');
        return { ok: scenario.status === 200, status: scenario.status, text: async () => scenario.text };
      },
      sendEvent: async (event: unknown) => { events.push(event); },
      markSessionHandled: () => {}, cleanup: () => {}, showToast: () => {},
      console: { warn: () => {} },
    });
    context.probeJsxWrapperForOrphan('page.tsx', 'session', { _orphanAttempt: 2 });
    await settle();
    expect(events).toEqual(scenario.discard ? [{ type: 'discard', id: 'session', orphaned: true }] : []);
  });

  it('retries missing source before exhausting the discard budget and ignores stale sessions', async () => {
    const retries: Array<() => void> = [];
    const events: unknown[] = [];
    const context = browser(agent, ['sourceHasSessionWrapper', 'probeJsxWrapperForOrphan'], {
      PORT: 8080, TOKEN: 'test', currentSessionId: 'session', state: 'GENERATING',
      COMPLETED_SOURCE_FALLBACK_RETRIES: 2, COMPLETED_SOURCE_FALLBACK_RETRY_MS: 10,
      fetch: async () => ({ ok: false, status: 404 }),
      setTimeout: (fn: () => void) => retries.push(fn),
      injectVariantsFromSource: (...args: unknown[]) => events.push(args),
      discardOrphanedSession: () => { throw new Error('Premature discard'); },
    });
    context.probeJsxWrapperForOrphan('page.tsx', 'session', {});
    await settle();
    expect(retries).toHaveLength(1);
    retries[0]();
    expect(events).toEqual([['page.tsx', 'session', { _orphanAttempt: 1 }]]);
    context.currentSessionId = 'replacement';
    retries[0]();
    expect(events).toHaveLength(1);
  });

  it('releases every discarded wrapper while retaining original content and other sessions', () => {
    document.body.innerHTML = '<section data-impeccable-variants="session"><div data-impeccable-variant="original"><p>First</p></div><aside>Generated</aside></section><section data-impeccable-variants="session"><div data-impeccable-variant="original"><p>Second</p></div></section><section data-impeccable-variants="session"></section><section data-impeccable-variants="other">Other session</section>';
    const context = browser(agent, ['discardedWrappers', 'releaseDiscardedStaticWrapper', 'releaseDiscardedStaticWrappers'], {
      removeDiscardStateStylesheet: () => {},
    });
    context.releaseDiscardedStaticWrappers('session');
    expect(document.querySelectorAll('[data-impeccable-variants="session"]')).toHaveLength(0);
    expect([...document.querySelectorAll('p')].map((p) => p.textContent)).toEqual(['First', 'Second']);
    expect(document.body.textContent).not.toContain('Generated');
    expect(document.querySelector('[data-impeccable-variants="other"]')?.textContent).toBe('Other session');
  });

  for (const rejects of [false, true]) it(`teardown cancels pending bitmap ${rejects ? 'failure' : 'success'}`, async () => {
    let complete!: (value?: unknown) => void;
    const pending = new Promise((resolve, reject) => { complete = rejects ? reject : resolve; });
    const close = vi.fn();
    const loseContext = vi.fn();
    const gl = {
      createProgram: () => ({}), attachShader: () => {}, linkProgram: () => {},
      getProgramParameter: () => true, createBuffer: () => ({}), bindBuffer: () => {},
      bufferData: () => {}, getAttribLocation: () => 0, enableVertexAttribArray: () => {},
      vertexAttribPointer: () => {}, getExtension: () => ({ loseContext }),
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(gl as unknown as WebGLRenderingContext);
    const context = browser(agent, ['removeStrayShaderNode', 'hideShaderOverlay', 'showShaderOverlay'], {
      PREFIX: 'test', Z: { bar: 100 }, shaderEpoch: 0, shaderState: null,
      SHADER_VS: '', SHADER_FS: '', compileShader: () => ({}),
      getComputedStyle: () => ({ borderRadius: '0px' }),
      uiAppend: (node: Node) => document.body.append(node),
      uiGetById: (id: string) => document.getElementById(id),
      createImageBitmap: () => pending,
      showShaderBitmapFallback: () => { throw new Error('Resurrected abandoned overlay'); },
      console: { warn: () => {} },
    });
    const work = context.showShaderOverlay(document.body, {}, { top: 0, left: 0, width: 10, height: 10 });
    expect(document.querySelector('canvas')).not.toBeNull();
    context.hideShaderOverlay();
    complete(rejects ? new Error('decode failed') : { close });
    await work;
    expect(document.querySelector('canvas')).toBeNull();
    expect(context.shaderState).toBeNull();
    expect(loseContext).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledTimes(rejects ? 0 : 1);
  });

  it('REQ-AGENT-181: user exit suppresses only the same token for sixty seconds across reloads', async () => {
    const first = livePage(agent, { token: 'exited', now: 100_000 });
    first.doc.querySelector<HTMLButtonElement>('#impeccable-live-exit')!.click();
    await Promise.resolve();
    expect(first.events).toContainEqual({ type: 'exit', source: 'user', token: 'exited' });
    expect(first.doc.querySelector('#impeccable-live-global-bar')).toBeNull();

    const reload = livePage(agent, { token: 'exited', now: 159_999 });
    expect(reload.doc.querySelector('#impeccable-live-global-bar')).toBeNull();
    const tabValues = new Map<string, string>();
    const otherTab = livePage(agent, {
      token: 'exited', now: 159_999,
      session: {
        getItem: (key) => tabValues.get(key) ?? null,
        setItem: (key, value) => { tabValues.set(key, value); },
        removeItem: (key) => { tabValues.delete(key); },
      },
    });
    expect(otherTab.doc.querySelector('#impeccable-live-exit')?.getAttribute('title')).toBe('Exit live mode');
    const otherToken = livePage(agent, { token: 'other', now: 159_999 });
    expect(otherToken.doc.querySelector('#impeccable-live-exit')?.getAttribute('title')).toBe('Exit live mode');
    const expired = livePage(agent, { token: 'exited', now: 160_000 });
    expect(expired.doc.querySelector('#impeccable-live-exit')?.getAttribute('title')).toBe('Exit live mode');
  });

  for (const failure of ['getItem', 'setItem'] as const) {
    it(`REQ-AGENT-181: blocked sessionStorage ${failure} still permits user exit`, async () => {
      const blocked = {
        getItem: () => {
          if (failure === 'getItem') throw new Error('Storage denied');
          return null;
        },
        setItem: () => { throw new Error('Storage denied'); },
        removeItem: () => {},
      };
      const page = livePage(agent, { session: blocked });
      page.doc.querySelector<HTMLButtonElement>('#impeccable-live-exit')!.click();
      await Promise.resolve();
      expect(page.events).toContainEqual({ type: 'exit', source: 'user', token: 'test' });
      expect(page.doc.querySelector('#impeccable-live-global-bar')).toBeNull();
    });
  }

  it('REQ-AGENT-181: missing PRODUCT notice is not repeated after reconnect or reload', () => {
    localStorage.setItem('impeccable-live-interaction', JSON.stringify({ pickActive: false, insertActive: false }));
    const page = livePage(agent);
    const connected = { type: 'connected', hasProjectContext: false, activeSessions: [] };
    page.message(connected);
    expect(page.doc.querySelector('#impeccable-live-toast')?.textContent).toContain('No PRODUCT.md found.');
    vi.advanceTimersByTime(7500);
    page.message(connected);
    expect(page.doc.querySelector('#impeccable-live-toast')).toBeNull();
    const reload = livePage(agent);
    reload.message(connected);
    expect(reload.doc.querySelector('#impeccable-live-toast')).toBeNull();
  });

  for (const failure of ['getItem', 'setItem'] as const) {
    it(`REQ-AGENT-181: PRODUCT notice remains once-only when localStorage ${failure} fails`, () => {
      const blocked = {
        getItem: (key: string) => {
          if (failure === 'getItem') throw new Error('Storage denied');
          return localStorage.getItem(key);
        },
        setItem: () => { throw new Error('Storage denied'); },
        removeItem: () => {},
      };
      const page = livePage(agent, { storage: blocked });
      const connected = { type: 'connected', hasProjectContext: false, activeSessions: [] };
      // First-run onboarding takes precedence; the following connection is
      // the first opportunity to display the missing-product notice.
      page.message(connected);
      page.message(connected);
      expect(page.doc.querySelector('#impeccable-live-toast')?.textContent).toContain('No PRODUCT.md found.');
      vi.advanceTimersByTime(7500);
      page.message(connected);
      expect(page.doc.querySelector('#impeccable-live-toast')).toBeNull();
    });
  }

  it('REQ-AGENT-181: hover keeps inactive mode labels collapsed and clicks select the intended mode', () => {
    const page = livePage(agent);
    const pick = page.doc.querySelector<HTMLButtonElement>('#impeccable-live-pick-toggle')!;
    const insert = page.doc.querySelector<HTMLButtonElement>('#impeccable-live-insert-toggle')!;
    page.doc.querySelector('#impeccable-live-global-bar')!.dispatchEvent(new MouseEvent('mouseenter'));
    pick.click();
    expect(pick.dataset.active).toBe('true');
    for (const id of ['pick', 'insert', 'detect', 'design']) {
      const button = page.doc.querySelector<HTMLButtonElement>(`#impeccable-live-${id}-toggle`)!;
      button.dispatchEvent(new MouseEvent('mouseenter'));
      const label = button.querySelector<HTMLElement>('.icon-btn-label')!;
      expect(parseFloat(label.style.maxWidth)).toBe(id === 'pick' ? 120 : 0);
      expect(label.style.opacity).toBe(id === 'pick' ? '1' : '0');
      button.dispatchEvent(new MouseEvent('mouseleave'));
    }
    insert.click();
    expect(insert.dataset.active).toBe('true');
    expect(pick.dataset.active).toBe('false');
    expect(parseFloat(insert.querySelector<HTMLElement>('.icon-btn-label')!.style.maxWidth)).toBe(120);
    expect(parseFloat(pick.querySelector<HTMLElement>('.icon-btn-label')!.style.maxWidth)).toBe(0);
  });

  for (const touch of [false, true]) {
    it(`REQ-AGENT-181: ${touch ? 'coarse' : 'fine'} pointer uses ${touch ? '44px minimum' : 'compact'} live controls`, () => {
      const page = livePage(agent, {
        touch,
        html: '<section data-impeccable-variants="session" data-impeccable-variant-count="2"><div data-impeccable-variant="original">Original</div><div data-impeccable-variant="1">First</div><div data-impeccable-variant="2">Second</div></section>',
      });
      const bar = page.doc.querySelector('#impeccable-live-bar')!;
      const controls = [
        page.doc.querySelector<HTMLButtonElement>('#impeccable-live-variant-prev')!,
        page.doc.querySelector<HTMLButtonElement>('#impeccable-live-variant-next')!,
        [...bar.querySelectorAll('button')].find((button) => button.textContent?.includes('Accept'))!,
        bar.querySelector<HTMLButtonElement>('[title="Discard all variants"]')!,
        page.doc.querySelector<HTMLButtonElement>('#impeccable-live-exit')!,
      ];
      for (const control of controls) {
        const style = page.doc.defaultView!.getComputedStyle(control);
        if (touch) {
          expect(parseFloat(style.minWidth)).toBeGreaterThanOrEqual(44);
          expect(parseFloat(style.minHeight)).toBeGreaterThanOrEqual(44);
        } else {
          expect(control.style.minWidth).toBe('');
          expect(control.style.minHeight).toBe('');
        }
      }
      expect(controls[0].textContent).toBe('←');
      expect(controls[1].textContent).toBe('→');
      expect(controls[0].style.width).toBe('26px');
      expect(controls[1].style.width).toBe('26px');
      expect(controls[4].style.width).toBe('24px');
    });
  }

  it('disconnected steering recovery prescribes the installed native launcher', () => {
    const context = browser(agent, ['steerTimeoutMessage'], {
      steerQueuedBehindGeneration: () => false, agentPollingConnected: false,
    });
    expect(context.steerTimeoutMessage()).toContain(`~/${agent === 'pi' ? '.pi/agent' : '.claude'}/skills/impeccable/scripts/impeccable live-poll`);
  });
});
