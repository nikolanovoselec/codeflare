// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DESIGN_READY_SCRIPT } from '../lib/design-ready';

type Deferred = { promise: Promise<unknown>; resolve: () => void };

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function flushDom(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  document.documentElement.className = '';
  document.head.innerHTML = '';
  vi.restoreAllMocks();
});

describe('REQ-LANDING-004: final-design first paint gate', () => {
  it('keeps the document hidden through stylesheet and critical-font loading, then reveals once', async () => {
    const inter = deferred();
    const mono = deferred();
    const load = vi.fn()
      .mockReturnValueOnce(inter.promise)
      .mockReturnValueOnce(mono.promise);
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { load },
    });

    new Function(DESIGN_READY_SCRIPT)();

    expect(document.documentElement.classList.contains('design-loading')).toBe(true);

    const stylesheet = document.createElement('link');
    stylesheet.rel = 'stylesheet';
    document.head.append(stylesheet);
    await flushDom();
    stylesheet.dispatchEvent(new Event('load'));

    expect(load).toHaveBeenCalledTimes(2);
    expect(document.documentElement.classList.contains('design-loading')).toBe(true);

    inter.resolve();
    await flushDom();
    expect(document.documentElement.classList.contains('design-loading')).toBe(true);

    mono.resolve();
    await flushDom();
    expect(document.documentElement.classList.contains('design-loading')).toBe(false);
  });
});
