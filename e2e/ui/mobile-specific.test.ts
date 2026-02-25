import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Browser, Page } from 'puppeteer';
import {
  launchBrowser, createTestPage, navigateToDashboard, checkSetupComplete, registerScreenshotOnFailure,
  createSessionViaApi, deleteSessionViaApi, startContainerViaApi, waitForContainerReady,
  navigateToSessionView,
} from '../helpers';
import { IS_MOBILE, TIMEOUTS } from '../config';

const isSetup = await checkSetupComplete();

describe.skipIf(!isSetup || !IS_MOBILE)('Mobile-specific UI', () => {
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
  });

  afterAll(async () => {
    if (sessionId) await deleteSessionViaApi(sessionId);
    await browser?.close();
  });

  it('session switcher renders mobile icon instead of name', async () => {
    const switcher = await page.$('[data-testid="session-switcher"]');
    expect(switcher).toBeTruthy();

    // Mobile: shows layers icon
    const mobileIcon = await page.$('[data-testid="session-switcher-mobile-icon"]');
    expect(mobileIcon).toBeTruthy();

    // Mobile: name and chevron are hidden
    const nameEl = await page.$('[data-testid="session-switcher-name"]');
    expect(nameEl).toBeNull();
  });

  it('session switcher opens dropdown as bottom-sheet', async () => {
    await page.click('[data-testid="session-switcher"]');
    await page.waitForSelector('[data-testid="session-dropdown"]', { timeout: TIMEOUTS.DIALOG });

    // Mobile: dropdown has bottom-sheet class
    const isBottomSheet = await page.$eval(
      '[data-testid="session-dropdown"]',
      el => el.classList.contains('session-dropdown--bottom-sheet')
    );
    expect(isBottomSheet).toBe(true);

    // Close dropdown by clicking backdrop
    const backdrop = await page.$('.session-dropdown__backdrop');
    if (backdrop) await backdrop.click();
  });

  it('header auth URL button is hidden on touch devices', async () => {
    // FloatingTerminalButtons handles auth URLs on mobile instead of Header button.
    // The header auth URL button is gated by !isTouchDevice().
    const authBtn = await page.$('.header-auth-url-btn');
    expect(authBtn).toBeNull();
  });

  it('settings panel shows mobile-specific button labels toggle', async () => {
    // Navigate to dashboard to access settings
    await navigateToDashboard(page);
    await page.click('[data-testid="dashboard-settings-button"]');
    await page.waitForFunction(
      () => document.querySelector('[data-testid="settings-panel"]')?.getAttribute('aria-hidden') === 'false',
      { timeout: TIMEOUTS.DIALOG }
    );

    // Mobile: button labels toggle visible
    const buttonLabels = await page.$('[data-testid="settings-button-labels-toggle"]');
    expect(buttonLabels).toBeTruthy();

    // Mobile: clipboard access toggle hidden (desktop-only)
    const clipboard = await page.$('[data-testid="settings-clipboard-access-toggle"]');
    expect(clipboard).toBeNull();

    // Close settings
    await page.evaluate(() => {
      (document.querySelector('[data-testid="settings-close-button"]') as HTMLElement)?.click();
    });
  });

  it('tapping active tab shows close popup (mobile-only)', async () => {
    // Navigate back to session terminal view
    await navigateToSessionView(page, sessionId);
    await page.waitForSelector('[data-testid="terminal-tabs"]', { timeout: TIMEOUTS.TERMINAL_READY });

    // Add a second tab
    await page.click('[data-testid="terminal-tab-add"]');
    await page.waitForSelector('[data-testid="terminal-tab-2"]', { timeout: TIMEOUTS.TERMINAL_READY });

    // Mobile has both inline close button AND popup mechanism.
    // The popup is triggered by tapping the already-active tab.
    // First tap selects tab 2 (if not already active)
    await page.click('[data-testid="terminal-tab-2"]');

    // Second tap on already-active tab triggers the close popup
    await page.click('[data-testid="terminal-tab-2"]');
    await page.waitForSelector('[data-testid="close-popup-2"]', { timeout: TIMEOUTS.DIALOG });
    const popup = await page.$('[data-testid="close-popup-2"]');
    expect(popup).toBeTruthy();

    // Close the tab via popup
    await page.click('[data-testid="close-popup-btn-2"]');
    await page.waitForSelector('[data-testid="terminal-tab-2"]', { hidden: true, timeout: TIMEOUTS.DIALOG });
  });
});
