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

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

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

  it('disconnected steering recovery prescribes the installed native launcher', () => {
    const context = browser(agent, ['steerTimeoutMessage'], {
      steerQueuedBehindGeneration: () => false, agentPollingConnected: false,
    });
    expect(context.steerTimeoutMessage()).toContain(`~/${agent === 'pi' ? '.pi/agent' : '.claude'}/skills/impeccable/scripts/impeccable live-poll`);
  });
});
