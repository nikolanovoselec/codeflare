import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Browser, Page } from 'puppeteer';
import {
  launchBrowser, createTestPage, checkSetupComplete, registerScreenshotOnFailure,
  createSessionViaApi, deleteSessionViaApi, startContainerViaApi, waitForContainerReady,
  navigateToSessionView,
} from '../helpers';
import { IS_MOBILE, TIMEOUTS } from '../config';

const isSetup = await checkSetupComplete();

// Tiling button is display:none on mobile (max-width: 640px) — skip entire suite
describe.skipIf(!isSetup || IS_MOBILE)('Tiling', () => {
  let browser: Browser;
  let page: Page;
  let sessionId: string;

  registerScreenshotOnFailure(() => page);

  beforeAll(async () => {
    browser = await launchBrowser();
    page = await createTestPage(browser);
    const session = await createSessionViaApi({ agentType: 'bash' });
    sessionId = session.id;
    await startContainerViaApi(sessionId);
    await navigateToSessionView(page, sessionId);
    await waitForContainerReady(page, sessionId);
    await page.waitForSelector('[data-testid="terminal-tabs"]', { timeout: TIMEOUTS.TERMINAL_READY });
    // Add extra tabs for tiling (need 3+ tabs)
    for (let i = 2; i <= 4; i++) {
      await page.evaluate(() => {
        const el = document.querySelector('[data-testid="terminal-tab-add"]');
        if (!el) throw new Error('Element not found: terminal-tab-add');
        (el as HTMLElement).click();
      });
      await page.waitForSelector(`[data-testid="terminal-tab-${i}"]`, { timeout: TIMEOUTS.TERMINAL_READY });
    }
  });

  afterAll(async () => {
    await deleteSessionViaApi(sessionId);
    await browser?.close();
  });

  it('tiling button is visible', async () => {
    const btn = await page.$('[data-testid="tiling-button"]');
    expect(btn).toBeTruthy();
  });

  it('clicking tiling button opens overlay', async () => {
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="tiling-button"]');
      if (!el) throw new Error('Element not found: tiling-button');
      (el as HTMLElement).click();
    });
    await page.waitForSelector('[data-testid="tiling-overlay"]', { timeout: TIMEOUTS.DIALOG });
    const overlay = await page.$('[data-testid="tiling-overlay"]');
    const backdrop = await page.$('[data-testid="tiling-overlay-backdrop"]');
    expect(overlay).toBeTruthy();
    expect(backdrop).toBeTruthy();
  });

  it('overlay shows layout options', async () => {
    for (const option of ['tiling-option-tabbed', 'tiling-option-2-split', 'tiling-option-3-split', 'tiling-option-4-grid']) {
      const el = await page.$(`[data-testid="${option}"]`);
      expect(el).toBeTruthy();
    }
  });

  it('selecting 2-split creates tiled container with 2 slots', async () => {
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="tiling-option-2-split"]');
      if (!el) throw new Error('Element not found: tiling-option-2-split');
      (el as HTMLElement).click();
    });
    await page.waitForSelector('[data-testid="tiled-terminal-container"]', { timeout: TIMEOUTS.DIALOG });
    const container = await page.$('[data-testid="tiled-terminal-container"]');
    expect(container).toBeTruthy();
  });

  it('selecting 4-grid shows 4 slots', async () => {
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="tiling-button"]');
      if (!el) throw new Error('Element not found: tiling-button');
      (el as HTMLElement).click();
    });
    await page.waitForSelector('[data-testid="tiling-overlay"]', { timeout: TIMEOUTS.DIALOG });
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="tiling-option-4-grid"]');
      if (!el) throw new Error('Element not found: tiling-option-4-grid');
      (el as HTMLElement).click();
    });
    await page.waitForSelector('[data-testid="tiled-terminal-container"]', { timeout: TIMEOUTS.DIALOG });
    const slots = await page.$$('[data-testid^="tiled-slot-"]');
    expect(slots.length).toBe(4);
  });

  it('selecting tabbed returns to single terminal view', async () => {
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="tiling-button"]');
      if (!el) throw new Error('Element not found: tiling-button');
      (el as HTMLElement).click();
    });
    await page.waitForSelector('[data-testid="tiling-overlay"]', { timeout: TIMEOUTS.DIALOG });
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="tiling-option-tabbed"]');
      if (!el) throw new Error('Element not found: tiling-option-tabbed');
      (el as HTMLElement).click();
    });
    await page.waitForSelector('[data-testid="tiled-terminal-container"]', { hidden: true, timeout: TIMEOUTS.DIALOG });
    const container = await page.$('[data-testid="tiled-terminal-container"]');
    expect(container).toBeNull();
  });

  it('backdrop click closes overlay without changing layout', async () => {
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="tiling-button"]');
      if (!el) throw new Error('Element not found: tiling-button');
      (el as HTMLElement).click();
    });
    await page.waitForSelector('[data-testid="tiling-overlay"]', { timeout: TIMEOUTS.DIALOG });
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="tiling-overlay-backdrop"]');
      if (!el) throw new Error('Element not found: tiling-overlay-backdrop');
      (el as HTMLElement).click();
    });
    await page.waitForSelector('[data-testid="tiling-overlay"]', { hidden: true, timeout: TIMEOUTS.DIALOG });
    const overlay = await page.$('[data-testid="tiling-overlay"]');
    expect(overlay).toBeNull();
  });
});
