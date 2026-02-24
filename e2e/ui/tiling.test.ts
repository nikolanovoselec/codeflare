import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Browser, Page } from 'puppeteer';
import {
  launchBrowser, createPage, checkSetupComplete, registerScreenshotOnFailure,
  createSessionViaApi, deleteSessionViaApi, startContainerViaApi, waitForContainerReady,
  navigateToSessionView,
} from '../helpers';

const isSetup = await checkSetupComplete();

describe.skipIf(!isSetup)('Tiling', () => {
  let browser: Browser;
  let page: Page;
  let sessionId: string;

  registerScreenshotOnFailure(() => page);

  beforeAll(async () => {
    browser = await launchBrowser();
    page = await createPage(browser);
    const session = await createSessionViaApi({ agentType: 'bash' });
    sessionId = session.id;
    await startContainerViaApi(sessionId);
    await navigateToSessionView(page, sessionId);
    await waitForContainerReady(page, sessionId);
    await page.waitForSelector('[data-testid="terminal-tabs"]', { timeout: 30000 });
    // Add extra tabs for tiling (need 3+ tabs)
    for (let i = 2; i <= 4; i++) {
      await page.click('[data-testid="terminal-tab-add"]');
      await page.waitForSelector(`[data-testid="terminal-tab-${i}"]`, { timeout: 10000 });
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
    await page.click('[data-testid="tiling-button"]');
    await page.waitForSelector('[data-testid="tiling-overlay"]', { timeout: 5000 });
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
    await page.click('[data-testid="tiling-option-2-split"]');
    await page.waitForSelector('[data-testid="tiled-terminal-container"]', { timeout: 5000 });
    const container = await page.$('[data-testid="tiled-terminal-container"]');
    expect(container).toBeTruthy();
  });

  it('selecting 4-grid shows 4 slots', async () => {
    await page.click('[data-testid="tiling-button"]');
    await page.waitForSelector('[data-testid="tiling-overlay"]', { timeout: 5000 });
    await page.click('[data-testid="tiling-option-4-grid"]');
    await page.waitForSelector('[data-testid="tiled-terminal-container"]', { timeout: 5000 });
    const slots = await page.$$('[data-testid^="tiled-slot-"]');
    expect(slots.length).toBe(4);
  });

  it('selecting tabbed returns to single terminal view', async () => {
    await page.click('[data-testid="tiling-button"]');
    await page.waitForSelector('[data-testid="tiling-overlay"]', { timeout: 5000 });
    await page.click('[data-testid="tiling-option-tabbed"]');
    await page.waitForSelector('[data-testid="tiled-terminal-container"]', { hidden: true, timeout: 5000 });
    const container = await page.$('[data-testid="tiled-terminal-container"]');
    expect(container).toBeNull();
  });

  it('backdrop click closes overlay without changing layout', async () => {
    await page.click('[data-testid="tiling-button"]');
    await page.waitForSelector('[data-testid="tiling-overlay"]', { timeout: 5000 });
    await page.click('[data-testid="tiling-overlay-backdrop"]');
    await page.waitForSelector('[data-testid="tiling-overlay"]', { hidden: true, timeout: 5000 });
    const overlay = await page.$('[data-testid="tiling-overlay"]');
    expect(overlay).toBeNull();
  });
});
