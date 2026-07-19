import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'puppeteer';
import { launchBrowser } from '../helpers';

// The exact pinned build web-ui ships — this suite is version-pinned behavioral
// evidence for the zero-delta repair contract, complementing the unit-level spy
// tests: it reproduces xterm.js#6046 (CSI 3J leaves BufferService.isUserScrolling
// stale) on the real terminal and proves the repair sequence restores follow.
const xtermJs = readFileSync(
  resolve(process.cwd(), 'web-ui/node_modules/@xterm/xterm/lib/xterm.js'),
  'utf8',
);
const xtermCss = readFileSync(
  resolve(process.cwd(), 'web-ui/node_modules/@xterm/xterm/css/xterm.css'),
  'utf8',
);

describe('pinned-xterm CSI 3J stale scroll lock (REQ-TERM-021)', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await launchBrowser();
    page = await browser.newPage();
    await page.setContent(`<!doctype html>
      <html><head><style>${xtermCss}\n#term{width:800px;height:400px;}</style></head>
      <body><div id="term"></div></body></html>`);
    await page.addScriptTag({ content: xtermJs });
  });

  afterAll(async () => {
    await browser?.close();
  });

  const setup = () => page.evaluate(() => {
    (window as any).term?.dispose();
    const term = new (window as any).Terminal({ scrollback: 1000, scrollOnUserInput: false });
    term.open(document.getElementById('term'));
    (window as any).term = term;
  });

  const write = (data: string) =>
    page.evaluate((d) => new Promise<void>((r) => (window as any).term.write(d, r)), data);

  const buf = () => page.evaluate(() => {
    const active = (window as any).term.buffer.active;
    return { viewportY: active.viewportY as number, baseY: active.baseY as number };
  });

  const lines = (count: number, label: string) =>
    Array.from({ length: count }, (_, i) => `${label} ${i}\r\n`).join('');

  it('reproduces the defect: CSI 3J resets the buffer but leaves the user-scroll lock stale, pinning new output at the top', async () => {
    await setup();
    await write(lines(120, 'line'));
    const before = await buf();
    expect(before.baseY).toBeGreaterThan(0);

    // The user scrolls up through the buffer service — sets the internal lock.
    await page.evaluate(() => (window as any).term._core._bufferService.scrollLines(-30));
    const up = await buf();
    expect(up.viewportY).toBe(before.baseY - 30);

    // Scrollback wipe: nominal bottom (viewportY === baseY === 0), stale lock.
    await write('\x1b[3J');
    const wiped = await buf();
    expect(wiped.viewportY).toBe(0);
    expect(wiped.baseY).toBe(0);

    // Regrow WITHOUT repair: the stale lock pins the viewport at the top —
    // upstream xterm.js#6046, the raw material of the top-then-bottom flash.
    await write(lines(60, 'regrow'));
    const after = await buf();
    expect(after.baseY).toBeGreaterThan(0);
    expect(after.viewportY).toBe(0);
  });

  it('REQ-TERM-021 AC5: internal scrollLines(0) at the nominal bottom clears the stale lock so output follows again', async () => {
    await setup();
    await write(lines(120, 'line'));
    await page.evaluate(() => (window as any).term._core._bufferService.scrollLines(-30));
    await write('\x1b[3J');

    // The zero-delta repair sequence scrollBufferToBottom() performs when the
    // buffer already reports bottom: clear the lock (no ydisp change, so no
    // scroll event or repaint) and re-command the DOM position absolutely.
    await page.evaluate(() => {
      const core = (window as any).term._core;
      core._bufferService.scrollLines(0);
      core._viewport.scrollToLine((window as any).term.buffer.active.viewportY, true);
    });

    // Regrow WITH the repair applied: output follows to the live bottom.
    await write(lines(60, 'regrow'));
    const after = await buf();
    expect(after.baseY).toBeGreaterThan(0);
    expect(after.viewportY).toBe(after.baseY);
  });
});
