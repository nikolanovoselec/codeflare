import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'puppeteer';
import { NAV_LINKS, HEADER_SIGN_IN } from '../../landing/src/content/site';
import { launchBrowser } from '../helpers';

const tokensCss = readFileSync(resolve(process.cwd(), 'landing/src/styles/tokens.css'), 'utf8');
const globalCss = readFileSync(resolve(process.cwd(), 'landing/src/styles/global.css'), 'utf8');
const signInWords = HEADER_SIGN_IN.label.split(/\s+/);

const word = (text: string) => `
  <span class="scramble-box scramble-box--center">
    <span class="scramble-ghost">${text}</span>
    <span class="scramble-word">${text}</span>
  </span>`;

interface RectGeometry {
  top: number;
  left: number;
  width: number;
  height: number;
  right: number;
}

interface HeaderGeometry {
  button: RectGeometry;
  links: RectGeometry[];
  words: RectGeometry[];
}

describe('landing Matrix CTA layout isolation (REQ-LANDING-006)', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await launchBrowser();
    page = await browser.newPage();
    await page.setContent(`<!doctype html>
      <html><head><style>${tokensCss}\n${globalCss}</style></head><body>
        <nav class="site-nav"><div class="container">
          <a class="brand"><span class="brand-mark"></span>codeflare</a>
          <div class="nav-right">
            <ul class="nav-links">
              ${NAV_LINKS.map((link) => `<li><a>${link.label}</a></li>`).join('')}
            </ul>
            <span class="nav-signin-slot">
              <a class="btn btn-ghost btn-sm nav-signin nav-signin--matrix">
                ${signInWords.map(word).join(' ')}
              </a>
            </span>
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
      links: [...document.querySelectorAll<HTMLElement>('.nav-links a')].map(toGeometry),
      words: [...document.querySelectorAll<HTMLElement>('.nav-signin--matrix .scramble-word')].map(toGeometry),
    };
  });

  it.each([900, 1280])('lets the button border expand at %ipx without moving any navigation-link rectangle', async (viewportWidth) => {
    await page.setViewport({ width: viewportWidth, height: 220, deviceScaleFactor: 1 });
    await page.evaluate((labels) => {
      document.querySelectorAll<HTMLElement>('.nav-signin--matrix .scramble-word')
        .forEach((live, index) => { live.textContent = labels[index]!; });
    }, signInWords);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    const before = await geometry();

    await page.evaluate((labels) => {
      document.querySelectorAll<HTMLElement>('.nav-signin--matrix .scramble-word')
        .forEach((live, index) => { live.textContent = 'W'.repeat(labels[index]!.length); });
    }, signInWords);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

    const during = await geometry();
    expect(during.button.width).toBeGreaterThan(before.button.width);
    expect(during.button.right).toBeCloseTo(before.button.right, 3);
    during.words.forEach((wordRect) => {
      expect(wordRect.left).toBeGreaterThanOrEqual(during.button.left);
      expect(wordRect.right).toBeLessThanOrEqual(during.button.right);
    });
    expect(during.links).toHaveLength(NAV_LINKS.length);
    during.links.forEach((link, index) => {
      expect(link.top).toBeCloseTo(before.links[index]!.top, 3);
      expect(link.left).toBeCloseTo(before.links[index]!.left, 3);
      expect(link.width).toBeCloseTo(before.links[index]!.width, 3);
      expect(link.height).toBeCloseTo(before.links[index]!.height, 3);
    });
    expect(during.button.left).toBeGreaterThan(during.links.at(-1)!.right);
  });
});
