import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Browser, Page } from 'puppeteer';
import {
  launchBrowser, createTestPage, checkSetupComplete, registerScreenshotOnFailure,
  createSessionViaApi, deleteSessionViaApi, startContainerViaApi, waitForContainerReady,
  navigateToSessionView,
} from '../helpers';
import { TIMEOUTS } from '../config';

const isSetup = await checkSetupComplete();

describe.skipIf(!isSetup)('Terminal tabs', () => {
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
  });

  afterAll(async () => {
    await deleteSessionViaApi(sessionId);
    await browser?.close();
  });

  it('terminal tabs container is visible', async () => {
    const tabs = await page.$('[data-testid="terminal-tabs"]');
    expect(tabs).toBeTruthy();
  });

  it('tab 1 exists as primary tab', async () => {
    const tab1 = await page.$('[data-testid="terminal-tab-1"]');
    expect(tab1).toBeTruthy();
  });

  it('tab 1 has no close button (locked)', async () => {
    const closeBtn = await page.$('[data-testid="terminal-tab-1-close"]');
    expect(closeBtn).toBeNull();
  });

  it('add tab button is visible', async () => {
    const addBtn = await page.$('[data-testid="terminal-tab-add"]');
    expect(addBtn).toBeTruthy();
  });

  it('clicking add creates new tab', async () => {
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="terminal-tab-add"]');
      if (!el) throw new Error('Element not found: terminal-tab-add');
      (el as HTMLElement).click();
    });
    await page.waitForSelector('[data-testid="terminal-tab-2"]', { timeout: TIMEOUTS.TERMINAL_READY });
    const tab2 = await page.$('[data-testid="terminal-tab-2"]');
    expect(tab2).toBeTruthy();
  });

  it('new tab has close button', async () => {
    const closeBtn = await page.$('[data-testid="terminal-tab-2-close"]');
    expect(closeBtn).toBeTruthy();
  });

  it('closing tab removes it', async () => {
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="terminal-tab-2-close"]');
      if (!el) throw new Error('Element not found: terminal-tab-2-close');
      (el as HTMLElement).click();
    });
    await page.waitForSelector('[data-testid="terminal-tab-2"]', { hidden: true, timeout: TIMEOUTS.DIALOG });
    const tab2 = await page.$('[data-testid="terminal-tab-2"]');
    expect(tab2).toBeNull();
  });

  it('can add up to max tabs (6) and add button becomes disabled', async () => {
    // Add tabs 2 through 6 (5 more tabs)
    for (let i = 2; i <= 6; i++) {
      await page.evaluate(() => {
        const el = document.querySelector('[data-testid="terminal-tab-add"]');
        if (!el) throw new Error('Element not found: terminal-tab-add');
        (el as HTMLElement).click();
      });
      await page.waitForSelector(`[data-testid="terminal-tab-${i}"]`, { timeout: TIMEOUTS.TERMINAL_READY });
    }
    // At max tabs, the add button is removed from the DOM entirely
    // (SolidJS <Show when={canAddTab()}>) rather than being disabled.
    await page.waitForSelector('[data-testid="terminal-tab-add"]', { hidden: true, timeout: TIMEOUTS.DIALOG });
    const addBtn = await page.$('[data-testid="terminal-tab-add"]');
    expect(addBtn).toBeNull();
  });
});
