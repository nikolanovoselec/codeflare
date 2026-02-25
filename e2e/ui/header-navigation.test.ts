import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Browser, Page } from 'puppeteer';
import {
  launchBrowser, createPage, checkSetupComplete, registerScreenshotOnFailure,
  createSessionViaApi, deleteSessionViaApi, navigateToSessionView, navigateToDashboard,
} from '../helpers';

const isSetup = await checkSetupComplete();

/** Wait for a slide-in panel to fully open (aria-hidden=false + transform complete) */
async function waitForPanelOpen(page: Page, testId: string, timeout = 10000): Promise<void> {
  await page.waitForFunction(
    (tid: string) => {
      const panel = document.querySelector(`[data-testid="${tid}"]`);
      if (!panel) return false;
      if (panel.getAttribute('aria-hidden') !== 'false') return false;
      const t = getComputedStyle(panel).transform;
      return t === 'none' || t === 'matrix(1, 0, 0, 1, 0, 0)';
    },
    { timeout },
    testId
  );
}

/** Wait for a slide-in panel to fully close (aria-hidden=true + transform complete) */
async function waitForPanelClosed(page: Page, testId: string, timeout = 10000): Promise<void> {
  await page.waitForFunction(
    (tid: string) => {
      const panel = document.querySelector(`[data-testid="${tid}"]`);
      if (!panel) return true;
      if (panel.getAttribute('aria-hidden') !== 'true') return false;
      const t = getComputedStyle(panel).transform;
      return t !== 'none' && t !== 'matrix(1, 0, 0, 1, 0, 0)';
    },
    { timeout },
    testId
  );
}

describe.skipIf(!isSetup)('Header navigation', () => {
  let browser: Browser;
  let page: Page;
  let sessionId: string;

  registerScreenshotOnFailure(() => page);

  beforeAll(async () => {
    browser = await launchBrowser();
    page = await createPage(browser);
    const session = await createSessionViaApi({ name: 'Header Nav Test' });
    sessionId = session.id;
    await navigateToSessionView(page, sessionId);
  });

  afterAll(async () => {
    await deleteSessionViaApi(sessionId);
    await browser?.close();
  });

  it('header is visible with logo', async () => {
    const logo = await page.$('[data-testid="header-logo"]');
    expect(logo).toBeTruthy();
  });

  it('user menu button is visible', async () => {
    const userMenu = await page.$('[data-testid="header-user-menu"]');
    expect(userMenu).toBeTruthy();
  });

  it('session switcher shows current session name', async () => {
    const switcher = await page.$('[data-testid="session-switcher"]');
    expect(switcher).toBeTruthy();
    const nameEl = await page.$('[data-testid="session-switcher-name"]');
    expect(nameEl).toBeTruthy();
    const name = await page.evaluate((el) => el?.textContent, nameEl);
    expect(name).toContain('Header Nav Test');
  });

  it('settings button opens settings panel from header', async () => {
    await page.click('[data-testid="header-settings-button"]');
    await waitForPanelOpen(page, 'settings-panel');
    const ariaHidden = await page.$eval('[data-testid="settings-panel"]', el => el.getAttribute('aria-hidden'));
    expect(ariaHidden).toBe('false');
    // Close it
    await page.click('[data-testid="settings-close-button"]');
    await waitForPanelClosed(page, 'settings-panel');
  });

  it('storage button opens storage panel', async () => {
    await page.click('[data-testid="header-storage-button"]');
    await waitForPanelOpen(page, 'storage-panel');
    const ariaHidden = await page.$eval('[data-testid="storage-panel"]', el => el.getAttribute('aria-hidden'));
    expect(ariaHidden).toBe('false');
    // Close it
    await page.click('[data-testid="storage-panel-close-button"]');
    await waitForPanelClosed(page, 'storage-panel');
  });

  it('dashboard button is visible', async () => {
    const dashBtn = await page.$('[data-testid="header-dashboard-button"]');
    expect(dashBtn).toBeTruthy();
  });

  it('clicking dashboard button returns to dashboard', async () => {
    await navigateToDashboard(page);
    const dashboard = await page.$('[data-testid="dashboard"]');
    expect(dashboard).toBeTruthy();
  });

  it('bookmarks button is visible', async () => {
    await navigateToSessionView(page, sessionId);
    const bookmarksBtn = await page.$('[data-testid="header-bookmarks-button"]');
    expect(bookmarksBtn).toBeTruthy();
  });
});
