import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Browser, Page } from 'puppeteer';
import {
  launchBrowser, createTestPage, navigateToDashboard, checkSetupComplete, registerScreenshotOnFailure,
} from '../helpers';
import { IS_MOBILE, TIMEOUTS } from '../config';

const isSetup = await checkSetupComplete();

/** Wait until settings panel has aria-hidden=false (animations are disabled in CI via createPage) */
async function waitForPanelOpen(page: Page, timeout = TIMEOUTS.DIALOG): Promise<void> {
  await page.waitForFunction(
    () => {
      const panel = document.querySelector('[data-testid="settings-panel"]');
      return panel?.getAttribute('aria-hidden') === 'false';
    },
    { timeout }
  );
}

/** Wait until settings panel has aria-hidden=true (animations are disabled in CI via createPage) */
async function waitForPanelClosed(page: Page, timeout = TIMEOUTS.DIALOG): Promise<void> {
  await page.waitForFunction(
    () => {
      const panel = document.querySelector('[data-testid="settings-panel"]');
      if (!panel) return true;
      return panel.getAttribute('aria-hidden') === 'true';
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
    page = await createTestPage(browser);
    await navigateToDashboard(page);
  });

  afterAll(async () => {
    await browser?.close();
  });

  it('clicking settings button opens panel', async () => {
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="dashboard-settings-button"]');
      if (!el) throw new Error('Element not found: dashboard-settings-button');
      (el as HTMLElement).click();
    });
    await waitForPanelOpen(page);
    const ariaHidden = await page.$eval('[data-testid="settings-panel"]', el => el.getAttribute('aria-hidden'));
    expect(ariaHidden).toBe('false');
  });

  it('backdrop is visible', async () => {
    const backdrop = await page.$('[data-testid="settings-backdrop"]');
    expect(backdrop).toBeTruthy();
  });

  it('close button closes panel', async () => {
    // Use evaluate click to avoid "not clickable" errors from backdrop overlay
    await page.evaluate(() => {
      (document.querySelector('[data-testid="settings-close-button"]') as HTMLElement)?.click();
    });
    await waitForPanelClosed(page);
    const ariaHidden = await page.$eval('[data-testid="settings-panel"]', el => el.getAttribute('aria-hidden'));
    expect(ariaHidden).toBe('true');
  });

  it.skipIf(IS_MOBILE)('backdrop click closes panel', async () => {
    // Mobile: settings panel is full-width (100vw), no backdrop area to click.
    // This test only applies to desktop where the panel is 400px on the right.
    // Reopen panel
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="dashboard-settings-button"]');
      if (!el) throw new Error('Element not found: dashboard-settings-button');
      (el as HTMLElement).click();
    });
    await waitForPanelOpen(page);
    // Click backdrop at specific coordinates to avoid hitting the panel (right side).
    // The panel is 400px wide on the right (x: 880-1280). Click at x=200 which is
    // safely on the backdrop, not the panel. Use Puppeteer's page.mouse.click for
    // precise coordinate control (page.click on selector clicks center which works
    // but SolidJS event delegation requires real mouse events, not HTMLElement.click).
    await page.mouse.click(200, 360);
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
      await page.evaluate(() => {
        const el = document.querySelector('[data-testid="dashboard-settings-button"]');
        if (!el) throw new Error('Element not found: dashboard-settings-button');
        (el as HTMLElement).click();
      });
      await waitForPanelOpen(page);
    }
    const swatch = await page.$('[data-testid="accent-color-swatch"]');
    const input = await page.$('[data-testid="accent-color-input"]');
    // The Button component uses a hardcoded data-testid="button" and doesn't
    // forward custom data-testid props. Find reset by text content instead.
    const reset = await page.evaluateHandle(() => {
      const buttons = document.querySelectorAll('.accent-color-row [data-testid="button"]');
      return Array.from(buttons).find(b => b.textContent?.trim() === 'Reset') ?? null;
    });
    expect(swatch).toBeTruthy();
    expect(input).toBeTruthy();
    expect(reset.asElement()).toBeTruthy();
  });

  it('shows group headings', async () => {
    // Ensure panel is open
    const isAlreadyOpen = await page.evaluate(
      () => document.querySelector('[data-testid="settings-panel"]')?.getAttribute('aria-hidden') === 'false'
    );
    if (!isAlreadyOpen) {
      await page.evaluate(() => {
        const el = document.querySelector('[data-testid="dashboard-settings-button"]');
        if (!el) throw new Error('Element not found: dashboard-settings-button');
        (el as HTMLElement).click();
      });
      await waitForPanelOpen(page);
    }
    const groupTitles = await page.$$eval('.settings-group-title', els => els.map(el => el.textContent?.trim()));
    expect(groupTitles).toContain('Appearance');
    expect(groupTitles).toContain('Session Defaults');
    // Administration only visible to admins — just check the first two are always present
  });

  it('shows toggle settings', async () => {
    const showTips = await page.$('[data-testid="settings-show-tips-toggle"]');
    expect(showTips).toBeTruthy();
    if (IS_MOBILE) {
      // Mobile (touch device): shows button labels toggle, hides clipboard toggle
      const buttonLabels = await page.$('[data-testid="settings-button-labels-toggle"]');
      expect(buttonLabels).toBeTruthy();
      const clipboard = await page.$('[data-testid="settings-clipboard-access-toggle"]');
      expect(clipboard).toBeNull();
    } else {
      // Desktop: shows clipboard toggle, hides button labels toggle
      const clipboard = await page.$('[data-testid="settings-clipboard-access-toggle"]');
      expect(clipboard).toBeTruthy();
      const buttonLabels = await page.$('[data-testid="settings-button-labels-toggle"]');
      expect(buttonLabels).toBeNull();
    }
  });

  it('shows workspace sync toggle with hint', async () => {
    const syncToggle = await page.$('[data-testid="settings-workspace-sync-toggle"]');
    const syncHint = await page.$('[data-testid="settings-workspace-sync-hint"]');
    expect(syncToggle).toBeTruthy();
    expect(syncHint).toBeTruthy();
  });

  it('shows fast start toggle with hint', async () => {
    const fastStartToggle = await page.$('[data-testid="settings-fast-start-toggle"]');
    const fastStartHint = await page.$('[data-testid="settings-fast-start-hint"]');
    expect(fastStartToggle).toBeTruthy();
    expect(fastStartHint).toBeTruthy();
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
    // Use evaluate click to avoid "not clickable" errors from backdrop overlay
    await page.evaluate((el) => (el as HTMLElement).click(), toggle);
    const newState = await page.evaluate(
      (el) => (el as HTMLInputElement).checked ?? el?.getAttribute('aria-checked') === 'true',
      toggle
    );
    expect(newState).not.toBe(initialState);
    await page.evaluate((el) => (el as HTMLElement).click(), toggle);
  });
});
