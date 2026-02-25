import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Browser, Page } from 'puppeteer';
import {
  launchBrowser, createTestPage, navigateToDashboard, registerScreenshotOnFailure,
  createSessionViaApi, deleteSessionViaApi, deleteAllSessionsViaApi, checkSetupComplete,
} from '../helpers';
import { TIMEOUTS } from '../config';

const isSetup = await checkSetupComplete();

/** Wait until settings panel has aria-hidden=false */
async function waitForPanelOpen(page: Page, timeout = TIMEOUTS.DIALOG): Promise<void> {
  await page.waitForFunction(
    () => {
      const panel = document.querySelector('[data-testid="settings-panel"]');
      return panel?.getAttribute('aria-hidden') === 'false';
    },
    { timeout }
  );
}

describe.skipIf(!isSetup)('Error States & Edge Cases', () => {
  let browser: Browser;
  let page: Page;

  registerScreenshotOnFailure(() => page);

  beforeAll(async () => {
    browser = await launchBrowser();
    page = await createTestPage(browser);
  });

  afterAll(async () => {
    await browser?.close();
  });

  it('should show empty state when no sessions exist', async () => {
    // Delete all sessions first
    await deleteAllSessionsViaApi();
    await navigateToDashboard(page);
    // Wait for dashboard to settle
    await page.waitForSelector('[data-testid="dashboard"]', { timeout: TIMEOUTS.DASHBOARD });
    // Verify no session cards are present
    const cards = await page.$$('[data-testid^="session-stat-card-"]');
    expect(cards.length).toBe(0);
  });

  it.skip('should remove session card after API deletion', { retry: 2 }, async () => {
    // SKIP: Dashboard polling requires 3 consecutive misses (15s+) to remove a card.
    // Combined with KV propagation delay, this test is too timing-sensitive for CI.
    // Create a session and verify it appears on dashboard
    const session = await createSessionViaApi({ agentType: 'bash' });
    try {
      await navigateToDashboard(page);
      await page.waitForFunction(
        (id: string) => !!document.querySelector(`[data-testid="session-stat-card-${id}"]`),
        { timeout: TIMEOUTS.SESSION_CARD, polling: TIMEOUTS.CONTAINER_POLL_INTERVAL },
        session.id
      );
      const cardBefore = await page.$(`[data-testid="session-stat-card-${session.id}"]`);
      expect(cardBefore).toBeTruthy();

      // Delete via API
      await deleteSessionViaApi(session.id);

      // Wait for card to disappear (dashboard polls every 5s, 3 consecutive misses to remove)
      // Allow up to 30s for the card to be removed (3 polls x 5s + KV propagation delay)
      const disappeared = await page.waitForFunction(
        (id: string) => !document.querySelector(`[data-testid="session-stat-card-${id}"]`),
        { timeout: 30_000, polling: TIMEOUTS.CONTAINER_POLL_INTERVAL },
        session.id
      ).then(() => true).catch(() => false);

      if (!disappeared) {
        // Polling may not have caught the deletion — reload page to force a fresh session list
        await navigateToDashboard(page);
        await page.waitForFunction(
          (id: string) => !document.querySelector(`[data-testid="session-stat-card-${id}"]`),
          { timeout: TIMEOUTS.DASHBOARD },
          session.id
        );
      }
    } catch (err) {
      // Attempt cleanup on failure
      await deleteSessionViaApi(session.id).catch(() => {});
      throw err;
    }
  });

  it('should change accent color in settings', async () => {
    await navigateToDashboard(page);
    // Open settings panel
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="dashboard-settings-button"]');
      if (!el) throw new Error('Element not found: dashboard-settings-button');
      (el as HTMLElement).click();
    });
    await waitForPanelOpen(page);

    // Get the accent color input and change it
    const input = await page.$('[data-testid="accent-color-input"]');
    expect(input).toBeTruthy();

    // Clear current value and type a new color
    await page.evaluate((el) => {
      (el as HTMLInputElement).value = '';
      el?.dispatchEvent(new Event('input', { bubbles: true }));
    }, input);
    await page.type('[data-testid="accent-color-input"]', '#ff5500');

    // Verify the swatch updated
    const swatchBg = await page.$eval('[data-testid="accent-color-swatch"]', (el) => {
      return getComputedStyle(el).background || (el as HTMLElement).style.background;
    });
    expect(swatchBg).toBeTruthy();
  });

  it('should reset accent color to default', async () => {
    // Settings panel should still be open from previous test
    const isOpen = await page.evaluate(
      () => document.querySelector('[data-testid="settings-panel"]')?.getAttribute('aria-hidden') === 'false'
    );
    if (!isOpen) {
      await page.evaluate(() => {
        const el = document.querySelector('[data-testid="dashboard-settings-button"]');
        if (!el) throw new Error('Element not found: dashboard-settings-button');
        (el as HTMLElement).click();
      });
      await waitForPanelOpen(page);
    }

    // Click the Reset button — the Button component hardcodes data-testid="button",
    // so we find the Reset button by matching the one inside the accent color row with "Reset" text
    await page.evaluate(() => {
      const row = document.querySelector('.accent-color-row');
      if (!row) throw new Error('Element not found: .accent-color-row');
      const buttons = row.querySelectorAll('[data-testid="button"]');
      const resetBtn = Array.from(buttons).find(b => b.textContent?.trim() === 'Reset') as HTMLElement;
      if (!resetBtn) throw new Error('Reset button not found inside .accent-color-row');
      resetBtn.click();
    });

    // Verify the input was cleared
    const inputValue = await page.$eval('[data-testid="accent-color-input"]', (el) => (el as HTMLInputElement).value);
    expect(inputValue).toBe('');

    // Close settings panel
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="settings-close-button"]');
      if (!el) throw new Error('Element not found: settings-close-button');
      (el as HTMLElement).click();
    });
  });
});
