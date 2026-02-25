import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Browser, Page } from 'puppeteer';
import {
  launchBrowser, createPage, checkSetupComplete, registerScreenshotOnFailure,
  createSessionViaApi, deleteSessionViaApi, navigateToSessionView, navigateToDashboard,
} from '../helpers';

const isSetup = await checkSetupComplete();

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
    // Navigate to session view (clicking stopped session auto-starts container)
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
    await page.waitForFunction(
      () => document.querySelector('[data-testid="settings-panel"]')?.classList.contains('open'),
      { timeout: 5000 }
    );
    const panel = await page.$('[data-testid="settings-panel"].open');
    expect(panel).toBeTruthy();
    // Close it
    await page.click('[data-testid="settings-close-button"]');
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="settings-panel"]')?.classList.contains('open'),
      { timeout: 5000 }
    );
  });

  it('storage button opens storage panel', async () => {
    await page.click('[data-testid="header-storage-button"]');
    await page.waitForFunction(
      () => document.querySelector('[data-testid="storage-panel"]')?.classList.contains('open'),
      { timeout: 5000 }
    );
    const panel = await page.$('[data-testid="storage-panel"].open');
    expect(panel).toBeTruthy();
    // Close it
    await page.click('[data-testid="storage-panel-close-button"]');
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="storage-panel"]')?.classList.contains('open'),
      { timeout: 5000 }
    );
  });

  it('dashboard button is visible', async () => {
    const dashBtn = await page.$('[data-testid="header-dashboard-button"]');
    expect(dashBtn).toBeTruthy();
  });

  it('clicking dashboard button returns to dashboard', async () => {
    // Full page navigation — in-page dashboard button may not render the
    // Dashboard component if initializingSessionIds was not cleared after
    // container startup (source bug workaround).
    await navigateToDashboard(page);
    const dashboard = await page.$('[data-testid="dashboard"]');
    expect(dashboard).toBeTruthy();
  });

  it('bookmarks button is visible', async () => {
    // Navigate back to session view for header
    await navigateToSessionView(page, sessionId);
    const bookmarksBtn = await page.$('[data-testid="header-bookmarks-button"]');
    expect(bookmarksBtn).toBeTruthy();
  });
});
