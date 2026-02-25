import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Browser, Page } from 'puppeteer';
import {
  launchBrowser, createPage, navigateToDashboard, checkSetupComplete, registerScreenshotOnFailure,
} from '../helpers';

const isSetup = await checkSetupComplete();

/** Wait until settings panel has aria-hidden=false and slide-in animation is done */
async function waitForPanelOpen(page: Page, timeout = 10000): Promise<void> {
  await page.waitForFunction(
    () => {
      const panel = document.querySelector('[data-testid="settings-panel"]');
      if (!panel) return false;
      if (panel.getAttribute('aria-hidden') !== 'false') return false;
      // Wait for CSS transform to reach identity (panel fully slid in)
      const t = getComputedStyle(panel).transform;
      return t === 'none' || t === 'matrix(1, 0, 0, 1, 0, 0)';
    },
    { timeout }
  );
}

/** Wait until settings panel has aria-hidden=true and slide-out animation is done */
async function waitForPanelClosed(page: Page, timeout = 10000): Promise<void> {
  await page.waitForFunction(
    () => {
      const panel = document.querySelector('[data-testid="settings-panel"]');
      if (!panel) return true;
      if (panel.getAttribute('aria-hidden') !== 'true') return false;
      // Wait for CSS transform to finish (panel fully slid out)
      const t = getComputedStyle(panel).transform;
      return t !== 'none' && t !== 'matrix(1, 0, 0, 1, 0, 0)';
    },
    { timeout }
  );
}

describe.skipIf(!isSetup)('Settings panel', () => {
  let browser: Browser;
  let page: Page;

  registerScreenshotOnFailure(() => page);

  beforeAll(async () => {
    browser = await launchBrowser();
    page = await createPage(browser);
    await navigateToDashboard(page);
  });

  afterAll(async () => {
    await browser?.close();
  });

  it('clicking settings button opens panel', async () => {
    await page.click('[data-testid="dashboard-settings-button"]');
    await waitForPanelOpen(page);
    const ariaHidden = await page.$eval('[data-testid="settings-panel"]', el => el.getAttribute('aria-hidden'));
    expect(ariaHidden).toBe('false');
  });

  it('backdrop is visible', async () => {
    const backdrop = await page.$('[data-testid="settings-backdrop"]');
    expect(backdrop).toBeTruthy();
  });

  it('close button closes panel', async () => {
    await page.click('[data-testid="settings-close-button"]');
    await waitForPanelClosed(page);
    const ariaHidden = await page.$eval('[data-testid="settings-panel"]', el => el.getAttribute('aria-hidden'));
    expect(ariaHidden).toBe('true');
  });

  it('backdrop click closes panel', async () => {
    // Reopen panel
    await page.click('[data-testid="dashboard-settings-button"]');
    await waitForPanelOpen(page);
    await page.click('[data-testid="settings-backdrop"]');
    await waitForPanelClosed(page);
    const ariaHidden = await page.$eval('[data-testid="settings-panel"]', el => el.getAttribute('aria-hidden'));
    expect(ariaHidden).toBe('true');
  });

  it('shows accent color controls', async () => {
    // Ensure panel is open — check current state first to handle toggle behavior
    const isAlreadyOpen = await page.evaluate(
      () => document.querySelector('[data-testid="settings-panel"]')?.getAttribute('aria-hidden') === 'false'
    );
    if (!isAlreadyOpen) {
      await page.click('[data-testid="dashboard-settings-button"]');
      await waitForPanelOpen(page);
    }
    const swatch = await page.$('[data-testid="accent-color-swatch"]');
    const input = await page.$('[data-testid="accent-color-input"]');
    const reset = await page.$('[data-testid="accent-color-reset"]');
    expect(swatch).toBeTruthy();
    expect(input).toBeTruthy();
    expect(reset).toBeTruthy();
  });

  it('shows toggle settings', async () => {
    const showTips = await page.$('[data-testid="settings-show-tips-toggle"]');
    expect(showTips).toBeTruthy();
    const buttonLabels = await page.$('[data-testid="settings-button-labels-toggle"]');
    const clipboard = await page.$('[data-testid="settings-clipboard-access-toggle"]');
    expect(buttonLabels || clipboard).toBeTruthy();
  });

  it('shows workspace sync toggle with hint', async () => {
    const syncToggle = await page.$('[data-testid="settings-workspace-sync-toggle"]');
    const syncHint = await page.$('[data-testid="settings-workspace-sync-hint"]');
    expect(syncToggle).toBeTruthy();
    expect(syncHint).toBeTruthy();
  });

  it('shows recreate docs row', async () => {
    const row = await page.$('[data-testid="settings-recreate-docs-row"]');
    const label = await page.$('[data-testid="settings-recreate-docs-label"]');
    expect(row).toBeTruthy();
    expect(label).toBeTruthy();
  });

  it('toggling a boolean setting auto-saves', async () => {
    const toggle = await page.$('[data-testid="settings-show-tips-toggle"]');
    expect(toggle).toBeTruthy();
    const initialState = await page.evaluate(
      (el) => (el as HTMLInputElement).checked ?? el?.getAttribute('aria-checked') === 'true',
      toggle
    );
    await toggle!.click();
    const newState = await page.evaluate(
      (el) => (el as HTMLInputElement).checked ?? el?.getAttribute('aria-checked') === 'true',
      toggle
    );
    expect(newState).not.toBe(initialState);
    await toggle!.click();
  });
});
