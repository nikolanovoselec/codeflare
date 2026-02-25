import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Browser, Page } from 'puppeteer';
import {
  launchBrowser, createPage, checkSetupComplete, registerScreenshotOnFailure,
  createSessionViaApi, deleteSessionViaApi, startContainerViaApi, waitForContainerReady,
  navigateToSessionView,
} from '../helpers';
import { apiRequest } from '../setup';

const isSetup = await checkSetupComplete();

/** Ensure bookmarks menu is open, clicking the button if needed */
async function ensureBookmarksMenuOpen(page: Page): Promise<void> {
  const menu = await page.$('[data-testid="header-bookmarks-menu"]');
  if (!menu) {
    // Use evaluate click to avoid mousedown race with handleClickOutside
    await page.evaluate(() => {
      (document.querySelector('[data-testid="header-bookmarks-button"]') as HTMLElement)?.click();
    });
    await page.waitForSelector('[data-testid="header-bookmarks-menu"]', { timeout: 10000 });
  }
}

describe.skipIf(!isSetup)('Bookmarks', () => {
  let browser: Browser;
  let page: Page;
  let sessionId: string;
  const presetIds: string[] = [];

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
    // Add 2 extra tabs for bookmark to capture
    for (let i = 2; i <= 3; i++) {
      await page.click('[data-testid="terminal-tab-add"]');
      await page.waitForSelector(`[data-testid="terminal-tab-${i}"]`, { timeout: 10000 });
    }
  });

  afterAll(async () => {
    // Delete presets via API
    for (const id of presetIds) {
      await apiRequest(`/api/presets/${id}`, { method: 'DELETE' });
    }
    await deleteSessionViaApi(sessionId);
    await browser?.close();
  });

  it('bookmarks button is visible in header', async () => {
    const btn = await page.$('[data-testid="header-bookmarks-button"]');
    expect(btn).toBeTruthy();
  });

  it('clicking opens bookmarks menu with empty state form', async () => {
    await page.waitForSelector('[data-testid="header-bookmarks-button"]', { visible: true, timeout: 10000 });
    // Debug: check button state and page errors before clicking
    const btnInfo = await page.evaluate(() => {
      const btn = document.querySelector('[data-testid="header-bookmarks-button"]') as HTMLElement;
      if (!btn) return { exists: false };
      const rect = btn.getBoundingClientRect();
      return {
        exists: true,
        visible: rect.width > 0 && rect.height > 0,
        rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
        disabled: (btn as HTMLButtonElement).disabled,
        display: getComputedStyle(btn).display,
        pointerEvents: getComputedStyle(btn).pointerEvents,
      };
    });
    console.log('[E2E] Bookmarks button info:', JSON.stringify(btnInfo));
    // Try click and check for JS errors
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.evaluate(() => {
      (document.querySelector('[data-testid="header-bookmarks-button"]') as HTMLElement)?.click();
    });
    // Brief wait for SolidJS reactivity
    await new Promise(r => setTimeout(r, 500));
    const menuExists = await page.evaluate(() => !!document.querySelector('[data-testid="header-bookmarks-menu"]'));
    console.log('[E2E] After click: menu exists =', menuExists, 'JS errors:', errors);
    if (!menuExists) {
      // Debug: check what happened to the signal
      const pageState = await page.evaluate(() => {
        const menu = document.querySelector('[data-testid="header-bookmarks-menu"]');
        const wrapper = document.querySelector('.header-bookmarks-wrapper');
        return {
          menuExists: !!menu,
          wrapperChildCount: wrapper?.childElementCount,
          wrapperHTML: wrapper?.innerHTML?.slice(0, 200),
        };
      });
      console.log('[E2E] Page state after click:', JSON.stringify(pageState));
    }
    await page.waitForSelector('[data-testid="header-bookmarks-menu"]', { timeout: 10000 });
    const menu = await page.$('[data-testid="header-bookmarks-menu"]');
    expect(menu).toBeTruthy();
    const input = await page.$('[data-testid="header-bookmark-name-input"]');
    const save = await page.$('[data-testid="header-bookmark-save"]');
    expect(input).toBeTruthy();
    expect(save).toBeTruthy();
  });

  it('typing name and saving creates bookmark', async () => {
    // Menu may have closed due to click-outside — reopen if needed
    await ensureBookmarksMenuOpen(page);
    await page.waitForSelector('[data-testid="header-bookmark-name-input"]', { timeout: 5000 });
    // Clear any existing text and type the name
    await page.click('[data-testid="header-bookmark-name-input"]', { clickCount: 3 });
    await page.type('[data-testid="header-bookmark-name-input"]', 'E2E Test Preset');
    await page.click('[data-testid="header-bookmark-save"]');
    // Wait for bookmark to appear in menu
    await page.waitForFunction(
      () => document.querySelector('[data-testid="header-bookmarks-menu"]')?.textContent?.includes('E2E Test Preset'),
      { timeout: 5000 }
    );
    // Get preset ID for cleanup
    const presetsRes = await apiRequest('/api/presets');
    if (presetsRes.ok) {
      const data = await presetsRes.json();
      const presets = data.presets;
      if (Array.isArray(presets)) {
        for (const p of presets) {
          if (p.name === 'E2E Test Preset') presetIds.push(p.id);
        }
      }
    }
  });

  it('saved bookmark captures tab layout', async () => {
    // Bookmark was saved with 3 tabs open — verify by checking preset API
    const presetsRes = await apiRequest('/api/presets');
    expect(presetsRes.ok).toBe(true);
    const presetsData = await presetsRes.json();
    const testPreset = presetsData.presets.find((p: { name: string }) => p.name === 'E2E Test Preset');
    expect(testPreset).toBeDefined();
    expect(testPreset.tabs).toBeDefined();
  });

  it('reopened menu shows bookmark list and Add New button', async () => {
    // Close bookmarks menu if open, then reopen
    await page.keyboard.press('Escape');
    // Small delay to let the menu close
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="header-bookmarks-menu"]'),
      { timeout: 3000 }
    ).catch(() => {}); // ignore if already closed
    await page.evaluate(() => {
      (document.querySelector('[data-testid="header-bookmarks-button"]') as HTMLElement)?.click();
    });
    await page.waitForSelector('[data-testid="header-bookmarks-menu"]', { timeout: 10000 });
    // With bookmarks present, "Add New" button should now be visible
    const addNew = await page.$('[data-testid="header-bookmark-add-new"]');
    expect(addNew).toBeTruthy();
    // Bookmark item should use header-bookmark-item-* prefix
    await page.waitForFunction(
      () => {
        const items = document.querySelectorAll('[data-testid="header-bookmarks-menu"] [data-testid^="header-bookmark-item-"]');
        return items.length > 0;
      },
      { timeout: 5000 }
    );
    const items = await page.$$('[data-testid="header-bookmarks-menu"] [data-testid^="header-bookmark-item-"]');
    if (items.length > 0) {
      await items[0].click();
    }
    // Tabs should reconfigure — verify tabs container still exists
    await page.waitForSelector('[data-testid="terminal-tabs"]', { timeout: 10000 });
    const tabs = await page.$('[data-testid="terminal-tabs"]');
    expect(tabs).toBeTruthy();
  });
});
