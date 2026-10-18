import { afterEach, describe, it, expect, vi } from 'vitest';
import * as piHelpers from '../../../preseed/agents/pi/extensions/browser-run-helpers';
import * as claudeCore from '../../../preseed/agents/claude/browser-run-mcp/core.mjs';

/**
 * REQ-BROWSER-003 (Pi native wrapper) and REQ-BROWSER-005 (Claude browser-run MCP
 * server) share one pure REST/format core, shipped as two twins:
 *   - preseed/agents/pi/extensions/browser-run-helpers.ts
 *   - preseed/agents/claude/browser-run-mcp/core.mjs
 * This battery runs against BOTH (so each REQ's tool behavior is genuinely tested)
 * and an equivalence block proves the twins behave identically — the guard that
 * lets us ship the logic twice without it drifting.
 */

type FakeResponse = { ok: boolean; status: number; body: unknown };
function makeFetch(impl: (url: string, init: any) => FakeResponse) {
  const calls: Array<{ url: string; init: any }> = [];
  const fn = async (url: string, init: any) => {
    calls.push({ url, init });
    const r = impl(url, init);
    return { ok: r.ok, status: r.status, json: async () => r.body };
  };
  return Object.assign(fn, { calls });
}
const ok = (result: unknown): FakeResponse => ({ ok: true, status: 200, body: { success: true, result } });

const MODULES = [
  ['pi/browser-run-helpers', piHelpers as any],
  ['claude/browser-run-mcp/core', claudeCore as any],
] as const;

describe.each(MODULES)('browser-run core: %s', (_name, mod) => {
  describe('truncate', () => {
    it('leaves a short string untouched', () => {
      expect(mod.truncate('hello')).toBe('hello');
    });
    it('REQ-BROWSER-003 AC4: caps an over-cap string at the limit and reports the dropped count', () => {
      const overage = 50_000;
      const big = 'a'.repeat(mod.MAX_OUTPUT_CHARS + overage);
      const out = mod.truncate(big);
      // The kept content ends exactly at the cap; the marker follows it.
      expect(out.indexOf('\n\n[... truncated')).toBe(mod.MAX_OUTPUT_CHARS);
      expect(out).toContain(`truncated ${overage} chars`);
      expect(out).toContain('browser_scrape');
      // With a large overage the marker cannot outweigh the dropped content.
      expect(out.length).toBeLessThan(big.length);
    });
    it('never splits a surrogate pair at the boundary', () => {
      const emoji = '😀'; // one code point, two UTF-16 units
      const big = emoji.repeat(mod.MAX_OUTPUT_CHARS + 10);
      const out = mod.truncate(big);
      // The kept prefix is whole code points -> no lone surrogate (U+FFFD on slice).
      expect(out).not.toContain('�');
    });
  });

  describe('initial target validation', () => {
    const blocked = [
      'not a url',
      'ftp://example.com/file',
      'https://user:pass@example.com/',
      'http://localhost/',
      'http://app.localhost/',
      'http://127.0.0.1/',
      'http://10.0.0.1/',
      'http://169.254.1.1/',
      'http://172.16.0.1/',
      'http://192.168.1.1/',
      'http://[::]/',
      'http://[::1]/',
      'http://[fc00::1]/',
      'http://[fe80::1]/',
      'http://[::ffff:7f00:1]/',
    ];

    it.each(blocked)('rejects %s before any Browser Run fetch', async (url) => {
      const fetchImpl = makeFetch(() => ok('should not run'));
      const result = await mod.executeBrowserAction({
        tool: 'browser_markdown', params: { url }, accountId: 'a', token: 't', fetchImpl,
      });
      expect(result.isError).toBe(true);
      expect(fetchImpl.calls).toHaveLength(0);
    });

    it.each(['https://example.com/path', 'http://1.1.1.1/'])('accepts public HTTP(S) target %s', (url) => {
      expect(mod.initialTargetError(url)).toBeNull();
    });
  });

  describe('gotoOptions', () => {
    it('returns {} with no wait strategy', () => {
      expect(mod.gotoOptions(undefined)).toEqual({});
    });
    it('wraps a wait strategy under gotoOptions', () => {
      expect(mod.gotoOptions('networkidle0')).toEqual({ gotoOptions: { waitUntil: 'networkidle0' } });
    });
  });

  describe('emptyRenderText', () => {
    it('names the url and suggests networkidle0', () => {
      const t = mod.emptyRenderText('https://x.test/');
      expect(t).toContain('https://x.test/');
      expect(t).toContain('networkidle0');
    });
  });

  describe('runQuickAction', () => {
    it('hits the account/action endpoint with a bearer token and returns the result', async () => {
      const fetchImpl = makeFetch(() => ok('# Page'));
      const r = await mod.runQuickAction({
        accountId: 'acct123',
        token: 'tok_abc',
        action: 'markdown',
        body: { url: 'https://x.test/' },
        fetchImpl,
      });
      expect(r).toEqual({ ok: true, result: '# Page' });
      expect(fetchImpl.calls[0].url).toBe(
        'https://api.cloudflare.com/client/v4/accounts/acct123/browser-rendering/markdown',
      );
      expect(fetchImpl.calls[0].init.headers.Authorization).toBe('Bearer tok_abc');
      expect(JSON.parse(fetchImpl.calls[0].init.body)).toEqual({ url: 'https://x.test/' });
    });
    it('returns an error for an HTTP failure', async () => {
      const fetchImpl = makeFetch(() => ({ ok: false, status: 403, body: { errors: ['nope'] } }));
      const r = await mod.runQuickAction({ accountId: 'a', token: 't', action: 'markdown', body: {}, fetchImpl });
      expect(r.ok).toBe(false);
      expect(r.error).toContain('Browser Run /markdown failed');
      expect(r.error).toContain('nope');
    });
    it('returns an error when the body reports success:false', async () => {
      const fetchImpl = makeFetch(() => ({ ok: true, status: 200, body: { success: false, errors: ['bad'] } }));
      const r = await mod.runQuickAction({ accountId: 'a', token: 't', action: 'content', body: {}, fetchImpl });
      expect(r.ok).toBe(false);
      expect(r.error).toContain('Browser Run /content failed');
    });
    it('returns a request-error for a thrown network failure', async () => {
      const fetchImpl = (async () => {
        throw new Error('socket hang up');
      }) as any;
      const r = await mod.runQuickAction({ accountId: 'a', token: 't', action: 'scrape', body: {}, fetchImpl });
      expect(r.ok).toBe(false);
      expect(r.error).toContain('request error');
      expect(r.error).toContain('socket hang up');
    });
    it('maps an AbortError to "aborted"', async () => {
      const fetchImpl = (async () => {
        const e = new Error('aborted');
        e.name = 'AbortError';
        throw e;
      }) as any;
      const r = await mod.runQuickAction({ accountId: 'a', token: 't', action: 'markdown', body: {}, fetchImpl });
      expect(r).toEqual({ ok: false, error: 'aborted' });
    });
  });

  describe('six-minute request deadlines', () => {
    afterEach(() => vi.useRealTimers());
    const budgetMs = 360_000;
    const tools = ['browser_markdown', 'browser_content', 'browser_scrape'];
    const scenarios = tools.flatMap(tool => ['fetch', 'body'].map(phase => ({ tool, phase })));

    function stalledProvider(phase: string) {
      let requestSignal: AbortSignal | undefined;
      let dispose = () => {};
      const pending = (signal?: AbortSignal) => new Promise<never>((_resolve, reject) => {
        const abort = () => reject(signal?.reason ?? new DOMException('aborted', 'AbortError'));
        dispose = abort;
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
      });
      return {
        get signal() { return requestSignal; },
        dispose: () => dispose(),
        fetchImpl: async (_url: string, init: any) => {
          requestSignal = init.signal;
          if (phase === 'fetch') return pending(requestSignal!);
          // The body starts later, but must still share the original request deadline.
          await new Promise(resolve => setTimeout(resolve, 120_000));
          return { ok: true, status: 200, json: () => pending(requestSignal!) };
        },
      };
    }

    it.each(scenarios)('REQ-BROWSER-010 AC1: $tool $phase expires at six minutes', async ({ tool, phase }) => {
      vi.useFakeTimers();
      const caller = new AbortController();
      const provider = stalledProvider(phase);
      let settled = false;
      const outcome = mod.executeBrowserAction({
        tool, params: { url: 'https://example.com/', selectors: ['h1'] },
        accountId: 'synthetic-account', token: 'synthetic-token',
        signal: caller.signal, fetchImpl: provider.fetchImpl,
      }).then((result: any) => { settled = true; return result; });
      try {
        await vi.advanceTimersByTimeAsync(budgetMs - 1);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(settled).toBe(true);
        expect(provider.signal?.aborted).toBe(true);
        const action = tool === 'browser_markdown' ? 'markdown' : tool === 'browser_content' ? 'content' : 'scrape';
        // Intentional user-copy contract distinguishes expiry from HTTP failure/caller cancellation.
        expect(await outcome).toEqual({
          isError: true, text: `Browser Run /${action} timed out after 6 minutes`, details: {},
        });
      } finally {
        caller.abort();
        await outcome;
      }
    });

    it.each(['fetch', 'body'])('REQ-BROWSER-010 AC1: %s deadline also applies without a caller signal', async phase => {
      vi.useFakeTimers();
      const provider = stalledProvider(phase);
      let settled = false;
      const outcome = mod.executeBrowserAction({
        tool: 'browser_markdown', params: { url: 'https://example.com/' },
        accountId: 'synthetic-account', token: 'synthetic-token', fetchImpl: provider.fetchImpl,
      }).then((result: any) => { settled = true; return result; });
      try {
        await vi.advanceTimersByTimeAsync(budgetMs - 1);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(settled).toBe(true);
        expect(provider.signal?.aborted).toBe(true);
        expect(await outcome).toEqual({ isError: true, text: 'Browser Run /markdown timed out after 6 minutes', details: {} });
      } finally {
        provider.dispose();
        await outcome;
      }
    });

    it.each(['fetch', 'body'])('REQ-BROWSER-010 AC2: earlier caller cancellation aborts the pending %s', async phase => {
      vi.useFakeTimers();
      const caller = new AbortController();
      const provider = stalledProvider(phase);
      const outcome = mod.executeBrowserAction({
        tool: 'browser_markdown', params: { url: 'https://example.com/' },
        accountId: 'synthetic-account', token: 'synthetic-token',
        signal: caller.signal, fetchImpl: provider.fetchImpl,
      });
      await vi.advanceTimersByTimeAsync(phase === 'body' ? 120_001 : 1_000);
      caller.abort();
      expect(await outcome).toEqual({ isError: true, text: 'aborted', details: {} });
      expect(provider.signal?.aborted).toBe(true);
    });

    it('REQ-BROWSER-010 AC5: expiry does not cancel another request or replace its caller cancellation', async () => {
      vi.useFakeTimers();
      const callerA = new AbortController();
      const callerB = new AbortController();
      const providerA = stalledProvider('fetch');
      const providerB = stalledProvider('fetch');
      const start = (caller: AbortController, provider: ReturnType<typeof stalledProvider>) => mod.executeBrowserAction({
        tool: 'browser_markdown', params: { url: 'https://example.com/' },
        accountId: 'synthetic-account', token: 'synthetic-token',
        signal: caller.signal, fetchImpl: provider.fetchImpl,
      });
      let settledA = false;
      let settledB = false;
      const outcomeA = start(callerA, providerA).then((result: any) => { settledA = true; return result; });
      await vi.advanceTimersByTimeAsync(60_000);
      const outcomeB = start(callerB, providerB).then((result: any) => { settledB = true; return result; });
      try {
        await vi.advanceTimersByTimeAsync(budgetMs - 60_000);
        expect(settledA).toBe(true);
        expect(providerA.signal?.aborted).toBe(true);
        expect(await outcomeA).toEqual({ isError: true, text: 'Browser Run /markdown timed out after 6 minutes', details: {} });
        expect(settledB).toBe(false);
        expect(providerB.signal?.aborted).toBe(false);
        callerB.abort(new Error('synthetic caller cancellation reason'));
        expect(await outcomeB).toEqual({ isError: true, text: 'aborted', details: {} });
      } finally {
        callerA.abort();
        callerB.abort();
        await Promise.all([outcomeA, outcomeB]);
      }
    });

    it('REQ-BROWSER-010 AC3: pre-aborted caller is refused before provider work', async () => {
      const caller = new AbortController();
      caller.abort();
      const outcome = await mod.executeBrowserAction({
        tool: 'browser_markdown', params: { url: 'https://example.com/' },
        accountId: 'synthetic-account', token: 'synthetic-token', signal: caller.signal,
        fetchImpl: async () => { throw new Error('pre-aborted request reached provider'); },
      });
      expect(outcome).toEqual({ isError: true, text: 'aborted', details: {} });
    });

    it('REQ-BROWSER-010 AC4: successful request is not aborted by a later deadline', async () => {
      vi.useFakeTimers();
      const caller = new AbortController();
      let requestSignal: AbortSignal | undefined;
      const outcome = mod.executeBrowserAction({
        tool: 'browser_markdown', params: { url: 'https://example.com/' },
        accountId: 'synthetic-account', token: 'synthetic-token', signal: caller.signal,
        fetchImpl: async (_url: string, init: any) => {
          requestSignal = init.signal;
          return { ok: true, status: 200, json: async () => {
            await new Promise(resolve => setTimeout(resolve, budgetMs - 1));
            return { success: true, result: '# Accepted' };
          } };
        },
      });
      await vi.advanceTimersByTimeAsync(budgetMs - 1);
      const accepted = await outcome;
      await vi.advanceTimersByTimeAsync(2);
      expect(accepted).toEqual({ text: '# Accepted', details: { url: 'https://example.com/' } });
      expect(requestSignal?.aborted).toBe(false);
    });
  });

  describe('executeBrowserAction', () => {
    const base = { accountId: 'a', token: 't' };
    it('browser_markdown returns the rendered text', async () => {
      const fetchImpl = makeFetch(() => ok('# Hello'));
      const out = await mod.executeBrowserAction({
        ...base,
        tool: 'browser_markdown',
        params: { url: 'https://x.test/' },
        fetchImpl,
      });
      expect(out.isError).toBeFalsy();
      expect(out.text).toBe('# Hello');
      expect(out.details).toEqual({ url: 'https://x.test/' });
    });
    it('an empty render becomes the actionable hint', async () => {
      const fetchImpl = makeFetch(() => ok('   '));
      const out = await mod.executeBrowserAction({
        ...base,
        tool: 'browser_markdown',
        params: { url: 'https://x.test/' },
        fetchImpl,
      });
      expect(out.text).toContain('networkidle0');
      expect(out.details).toEqual({ url: 'https://x.test/', empty: true });
    });
    it('REQ-BROWSER-003 AC5: an error surfaces as isError, not a throw', async () => {
      const fetchImpl = makeFetch(() => ({ ok: false, status: 500, body: null }));
      const out = await mod.executeBrowserAction({
        ...base,
        tool: 'browser_content',
        params: { url: 'https://x.test/' },
        fetchImpl,
      });
      expect(out.isError).toBe(true);
      expect(out.text).toContain('Browser Run /content failed');
    });
    it('browser_scrape maps selectors to elements and returns pretty JSON', async () => {
      const fetchImpl = makeFetch(() => ok([{ selector: 'h1', text: 'Title' }]));
      const out = await mod.executeBrowserAction({
        ...base,
        tool: 'browser_scrape',
        params: { url: 'https://x.test/', selectors: ['h1', 'a'], wait_until: 'networkidle0' },
        fetchImpl,
      });
      expect(out.isError).toBeFalsy();
      expect(JSON.parse(out.text)).toEqual([{ selector: 'h1', text: 'Title' }]);
      const sentBody = JSON.parse(fetchImpl.calls[0].init.body);
      expect(sentBody.elements).toEqual([{ selector: 'h1' }, { selector: 'a' }]);
      expect(sentBody.gotoOptions).toEqual({ waitUntil: 'networkidle0' });
    });
  });
});

describe('browser-run core twins are equivalent (REQ-BROWSER-003 ≡ REQ-BROWSER-005)', () => {
  it('expose the same constant and pure outputs', () => {
    expect(claudeCore.MAX_OUTPUT_CHARS).toBe(piHelpers.MAX_OUTPUT_CHARS);
    expect(claudeCore.emptyRenderText('https://x.test/')).toBe(piHelpers.emptyRenderText('https://x.test/'));
    expect(claudeCore.gotoOptions('networkidle0')).toEqual(piHelpers.gotoOptions('networkidle0'));
    const big = 'z'.repeat(claudeCore.MAX_OUTPUT_CHARS + 7);
    expect(claudeCore.truncate(big)).toBe(piHelpers.truncate(big));
  });
  it('produce identical executeBrowserAction outcomes for the same input', async () => {
    const fetchImpl = () => makeFetch(() => ok('# Same'));
    const args = { accountId: 'a', token: 't', tool: 'browser_markdown', params: { url: 'https://x.test/' } } as const;
    const piOut = await piHelpers.executeBrowserAction({ ...args, fetchImpl: fetchImpl() } as any);
    const claudeOut = await claudeCore.executeBrowserAction({ ...args, fetchImpl: fetchImpl() } as any);
    expect(claudeOut).toEqual(piOut);
  });
  it('Claude core exposes exactly the three Browser Run tools with the native names', () => {
    expect([...claudeCore.TOOL_NAMES].sort()).toEqual(['browser_content', 'browser_markdown', 'browser_scrape']);
    for (const t of claudeCore.TOOLS) {
      expect(t.inputSchema.type).toBe('object');
      expect(t.inputSchema.properties.url).toBeDefined();
    }
  });
});
