import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'puppeteer';
import { NAV_LINKS, HEADER_SIGN_IN } from '../../landing/src/content/site';
import { launchBrowser } from '../helpers';

const tokensCss = readFileSync(resolve(process.cwd(), 'landing/src/styles/tokens.css'), 'utf8');
const globalCss = readFileSync(resolve(process.cwd(), 'landing/src/styles/global.css'), 'utf8');
const signInWords = HEADER_SIGN_IN.label.split(/\s+/);

const word = (text: string) => `<span class="scramble-word">${text}</span>`;

interface RectGeometry {
  top: number;
  left: number;
  width: number;
  height: number;
  right: number;
}

interface HeaderGeometry {
  button: RectGeometry;
  shell: RectGeometry;
  links: RectGeometry[];
}

describe('landing Matrix CTA layout isolation (REQ-LANDING-006)', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await launchBrowser();
    page = await browser.newPage();
    // The runtime structure scramble.ts builds for [data-scramble-hover]: an
    // in-flow full-label ghost holds the host's layout box; the chrome shell is
    // out of flow and shrink-wraps the churning in-flow words.
    await page.setContent(`<!doctype html>
      <html><head><style>${tokensCss}\n${globalCss}</style></head><body>
        <nav class="site-nav"><div class="container">
          <a class="brand"><span class="brand-mark"></span>codeflare</a>
          <div class="nav-right">
            <ul class="nav-links">
              ${NAV_LINKS.map((link) => `<li><a>${link.label}</a></li>`).join('')}
            </ul>
            <a class="btn btn-ghost btn-sm nav-signin nav-signin--matrix scramble-host">
              <span class="scramble-ghost">${HEADER_SIGN_IN.label}</span>
              <span class="scramble-shell btn btn-ghost btn-sm">${signInWords.map(word).join(' ')}</span>
            </a>
          </div>
        </div></nav>
      </body></html>`);
  });

  afterAll(async () => {
    await browser?.close();
  });

  const geometry = async (): Promise<HeaderGeometry> => page.evaluate(() => {
    const toGeometry = (element: Element): RectGeometry => {
      const rect = element.getBoundingClientRect();
      return {
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
        right: rect.right,
      };
    };
    return {
      button: toGeometry(document.querySelector<HTMLElement>('.nav-signin--matrix')!),
      shell: toGeometry(document.querySelector<HTMLElement>('.scramble-shell')!),
      links: [...document.querySelectorAll<HTMLElement>('.nav-links a')].map(toGeometry),
    };
  });

  const setWords = async (labels: string[]): Promise<void> => {
    await page.evaluate((texts) => {
      document.querySelectorAll<HTMLElement>('.scramble-shell .scramble-word')
        .forEach((live, index) => { live.textContent = texts[index]!; });
    }, labels);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  };

  it.each([900, 1280])('at %ipx the visible shell grows symmetrically during churn while the layout box and every navigation-link rectangle stay fixed', async (viewportWidth) => {
    await page.setViewport({ width: viewportWidth, height: 220, deviceScaleFactor: 1 });
    await setWords(signInWords);
    const before = await geometry();

    // At rest the shell chrome is congruent with the host's (invisible) box —
    // the visible button sits exactly where the layout box is.
    expect(before.shell.width).toBeCloseTo(before.button.width, 0);
    expect(before.shell.left).toBeCloseTo(before.button.left, 0);
    expect(before.shell.top).toBeCloseTo(before.button.top, 0);
    expect(before.shell.height).toBeCloseTo(before.button.height, 0);

    // The chrome handoff itself: the host's own border is transparent and the
    // shell's is painted — gutting .scramble-host or .scramble-shell fails here.
    const chrome = await page.evaluate(() => {
      const host = document.querySelector<HTMLElement>('.nav-signin--matrix')!;
      const shell = document.querySelector<HTMLElement>('.scramble-shell')!;
      return {
        hostBorder: getComputedStyle(host).borderTopColor,
        shellBorder: getComputedStyle(shell).borderTopColor,
        shellBorderWidth: getComputedStyle(shell).borderTopWidth,
        shellPosition: getComputedStyle(shell).position,
      };
    });
    expect(chrome.hostBorder).toBe('rgba(0, 0, 0, 0)');
    expect(chrome.shellBorder).not.toBe('rgba(0, 0, 0, 0)');
    expect(chrome.shellBorderWidth).toBe('1px');
    expect(chrome.shellPosition).toBe('absolute');

    await setWords(signInWords.map((label) => 'W'.repeat(label.length)));
    const during = await geometry();

    // The visible chrome GROWS with the wide churn frame...
    expect(during.shell.width).toBeGreaterThan(before.shell.width + 1);
    // ...symmetrically around the resting box (both edges extend outward)...
    const beforeCenter = before.shell.left + before.shell.width / 2;
    const duringCenter = during.shell.left + during.shell.width / 2;
    expect(duringCenter).toBeCloseTo(beforeCenter, 1);
    expect(during.shell.left).toBeLessThan(before.shell.left);
    expect(during.shell.right).toBeGreaterThan(before.shell.right);
    // ...while the host's layout box never changes — that is what keeps siblings still.
    expect(during.button.width).toBeCloseTo(before.button.width, 3);
    expect(during.button.left).toBeCloseTo(before.button.left, 3);
    expect(during.button.right).toBeCloseTo(before.button.right, 3);
    // ...and no navigation-link rectangle moves either.
    expect(during.links).toHaveLength(NAV_LINKS.length);
    during.links.forEach((link, index) => {
      expect(link.top).toBeCloseTo(before.links[index]!.top, 3);
      expect(link.left).toBeCloseTo(before.links[index]!.left, 3);
      expect(link.width).toBeCloseTo(before.links[index]!.width, 3);
      expect(link.height).toBeCloseTo(before.links[index]!.height, 3);
    });
    expect(during.button.left).toBeGreaterThan(during.links.at(-1)!.right);

    // Content-driven, not a ratchet: restoring the label shrinks the shell back.
    await setWords(signInWords);
    const after = await geometry();
    expect(after.shell.width).toBeCloseTo(before.shell.width, 0);
  });
});
