import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Browser, Page } from 'puppeteer';
import {
  launchBrowser, createPage, checkSetupComplete, registerScreenshotOnFailure,
  createSessionViaApi, deleteSessionViaApi, startContainerViaApi, waitForContainerReady,
  navigateToSessionView,
} from '../helpers';

const isSetup = await checkSetupComplete();

describe.skipIf(!isSetup)('Terminal tabs', () => {
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
    await page.click('[data-testid="terminal-tab-add"]');
    await page.waitForSelector('[data-testid="terminal-tab-2"]', { timeout: 10000 });
    const tab2 = await page.$('[data-testid="terminal-tab-2"]');
    expect(tab2).toBeTruthy();
  });

  it('new tab has close button', async () => {
    const closeBtn = await page.$('[data-testid="terminal-tab-2-close"]');
    expect(closeBtn).toBeTruthy();
  });

  it('closing tab removes it', async () => {
    await page.click('[data-testid="terminal-tab-2-close"]');
    await page.waitForSelector('[data-testid="terminal-tab-2"]', { hidden: true, timeout: 5000 });
    const tab2 = await page.$('[data-testid="terminal-tab-2"]');
    expect(tab2).toBeNull();
  });

  it('can add up to max tabs (6) and add button becomes disabled', async () => {
    // Add tabs 2 through 6 (5 more tabs)
    for (let i = 2; i <= 6; i++) {
      await page.click('[data-testid="terminal-tab-add"]');
      await page.waitForSelector(`[data-testid="terminal-tab-${i}"]`, { timeout: 10000 });
    }
    // Check add button is disabled
    const addBtn = await page.$('[data-testid="terminal-tab-add"]');
    const isDisabled = await page.evaluate(
      (el) => el ? (el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true' : true,
      addBtn
    );
    expect(isDisabled).toBe(true);
  });
});
