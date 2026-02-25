import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Browser, Page } from 'puppeteer';
import {
  launchBrowser, createTestPage, navigateToDashboard, checkSetupComplete, registerScreenshotOnFailure,
} from '../helpers';
import { TIMEOUTS } from '../config';

const isSetup = await checkSetupComplete();

describe.skipIf(!isSetup)('Dashboard', () => {
  let browser: Browser;
  let page: Page;

  registerScreenshotOnFailure(() => page);

  beforeAll(async () => {
    browser = await launchBrowser();
    page = await createTestPage(browser);
    await navigateToDashboard(page);
  });

  afterAll(async () => {
    await browser?.close();
  });

  it('loads dashboard with floating panel', async () => {
    const dashboard = await page.$('[data-testid="dashboard"]');
    const floatingPanel = await page.$('[data-testid="dashboard-floating-panel"]');
    expect(dashboard || floatingPanel).toBeTruthy();
  });

  it('shows left panel with new-session button and right panel with storage', async () => {
    const leftPanel = await page.$('[data-testid="dashboard-panel-left"]');
    const rightPanel = await page.$('[data-testid="dashboard-panel-right"]');
    expect(leftPanel).toBeTruthy();
    expect(rightPanel).toBeTruthy();
  });

  it('shows settings and logout buttons', async () => {
    const settings = await page.$('[data-testid="dashboard-settings-button"]');
    const logout = await page.$('[data-testid="dashboard-logout-button"]');
    expect(settings).toBeTruthy();
    expect(logout).toBeTruthy();
  });

  it('new session button opens create dialog', async () => {
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="dashboard-new-session"]');
      if (!el) throw new Error('Element not found: dashboard-new-session');
      (el as HTMLElement).click();
    });
    await page.waitForSelector('[data-testid="create-session-dialog"]', { timeout: TIMEOUTS.DIALOG });
    const dialog = await page.$('[data-testid="create-session-dialog"]');
    expect(dialog).toBeTruthy();
  });

  it('create dialog shows agent type options', async () => {
    // Dialog should still be open from previous test, or reopen
    const dialog = await page.$('[data-testid="create-session-dialog"]');
    if (!dialog) {
      await page.evaluate(() => {
        const el = document.querySelector('[data-testid="dashboard-new-session"]');
        if (!el) throw new Error('Element not found: dashboard-new-session');
        (el as HTMLElement).click();
      });
      await page.waitForSelector('[data-testid="create-session-dialog"]', { timeout: TIMEOUTS.DIALOG });
    }
    const claude = await page.$('[data-testid="csd-agent-claude-code"]');
    const bash = await page.$('[data-testid="csd-agent-bash"]');
    expect(claude).toBeTruthy();
    expect(bash).toBeTruthy();
  });

  it('create dialog closes on Escape', async () => {
    const dialog = await page.$('[data-testid="create-session-dialog"]');
    if (!dialog) {
      await page.evaluate(() => {
        const el = document.querySelector('[data-testid="dashboard-new-session"]');
        if (!el) throw new Error('Element not found: dashboard-new-session');
        (el as HTMLElement).click();
      });
      await page.waitForSelector('[data-testid="create-session-dialog"]', { timeout: TIMEOUTS.DIALOG });
    }
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-testid="create-session-dialog"]', { hidden: true, timeout: TIMEOUTS.DIALOG });
    const closedDialog = await page.$('[data-testid="create-session-dialog"]');
    expect(closedDialog).toBeNull();
  });

  it('shows storage stat cards in left panel', async () => {
    const statCards = await page.$('[data-testid="stat-cards"]');
    expect(statCards).toBeTruthy();
    for (const card of ['stat-card-storage', 'stat-card-files', 'stat-card-folders', 'stat-card-size']) {
      const el = await page.$(`[data-testid="${card}"]`);
      expect(el).toBeTruthy();
    }
  });

  it('right panel shows storage browser with breadcrumbs', async () => {
    const browser = await page.$('[data-testid="storage-browser"]');
    const breadcrumbs = await page.$('[data-testid="storage-breadcrumbs"]');
    expect(browser).toBeTruthy();
    expect(breadcrumbs).toBeTruthy();
  });
});
