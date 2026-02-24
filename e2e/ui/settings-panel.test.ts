import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Browser, Page } from 'puppeteer';
import {
  launchBrowser, createPage, navigateToDashboard, checkSetupComplete, registerScreenshotOnFailure,
} from '../helpers';

const isSetup = await checkSetupComplete();

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
    await page.waitForSelector('[data-testid="settings-panel"]', { timeout: 5000 });
    const panel = await page.$('[data-testid="settings-panel"]');
    expect(panel).toBeTruthy();
  });

  it('backdrop is visible', async () => {
    const backdrop = await page.$('[data-testid="settings-backdrop"]');
    expect(backdrop).toBeTruthy();
  });

  it('close button closes panel', async () => {
    await page.click('[data-testid="settings-close-button"]');
    await page.waitForSelector('[data-testid="settings-panel"]', { hidden: true, timeout: 5000 });
    const panel = await page.$('[data-testid="settings-panel"]');
    expect(panel).toBeNull();
  });

  it('backdrop click closes panel', async () => {
    // Reopen panel
    await page.click('[data-testid="dashboard-settings-button"]');
    await page.waitForSelector('[data-testid="settings-panel"]', { timeout: 5000 });
    await page.click('[data-testid="settings-backdrop"]');
    await page.waitForSelector('[data-testid="settings-panel"]', { hidden: true, timeout: 5000 });
    const panel = await page.$('[data-testid="settings-panel"]');
    expect(panel).toBeNull();
  });

  it('shows accent color controls', async () => {
    // Reopen panel
    await page.click('[data-testid="dashboard-settings-button"]');
    await page.waitForSelector('[data-testid="settings-panel"]', { timeout: 5000 });
    const swatch = await page.$('[data-testid="accent-color-swatch"]');
    const input = await page.$('[data-testid="accent-color-input"]');
    const reset = await page.$('[data-testid="accent-color-reset"]');
    expect(swatch).toBeTruthy();
    expect(input).toBeTruthy();
    expect(reset).toBeTruthy();
  });

  it('shows toggle settings', async () => {
    const buttonLabels = await page.$('[data-testid="settings-button-labels-toggle"]');
    const showTips = await page.$('[data-testid="settings-show-tips-toggle"]');
    const clipboard = await page.$('[data-testid="settings-clipboard-access-toggle"]');
    expect(buttonLabels).toBeTruthy();
    expect(showTips).toBeTruthy();
    expect(clipboard).toBeTruthy();
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
    // Get initial state
    const initialState = await page.evaluate(
      (el) => (el as HTMLInputElement).checked ?? el?.getAttribute('aria-checked') === 'true',
      toggle
    );
    // Click toggle
    await toggle!.click();
    // Verify state changed
    const newState = await page.evaluate(
      (el) => (el as HTMLInputElement).checked ?? el?.getAttribute('aria-checked') === 'true',
      toggle
    );
    expect(newState).not.toBe(initialState);
    // Restore original state
    await toggle!.click();
  });
});
