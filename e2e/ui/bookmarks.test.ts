import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Browser, Page } from 'puppeteer';
import {
  launchBrowser, createPage, checkSetupComplete, registerScreenshotOnFailure,
  createSessionViaApi, deleteSessionViaApi, startContainerViaApi, waitForContainerReady,
  navigateToSessionView,
} from '../helpers';
import { apiRequest } from '../setup';

const isSetup = await checkSetupComplete();

/** Delete all presets via API to ensure clean state */
async function deleteAllPresets(): Promise<void> {
  const res = await apiRequest('/api/presets');
  if (!res.ok) return;
  const data = await res.json();
  const presets = data.presets;
  if (!Array.isArray(presets)) return;
  await Promise.all(
    presets.map((p: { id: string }) =>
      apiRequest(`/api/presets/${p.id}`, { method: 'DELETE' }).catch(() => {})
    )
  );
}

/** Ensure bookmarks menu is open, clicking the button if needed */
async function ensureBookmarksMenuOpen(page: Page): Promise<void> {
  const menu = await page.$('[data-testid="header-bookmarks-menu"]');
  if (!menu) {
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
    // Clean all presets from previous runs to ensure empty state
    await deleteAllPresets();
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
    await page.evaluate(() => {
      (document.querySelector('[data-testid="header-bookmarks-button"]') as HTMLElement)?.click();
    });
    await page.waitForSelector('[data-testid="header-bookmarks-menu"]', { timeout: 10000 });
    const menu = await page.$('[data-testid="header-bookmarks-menu"]');
    expect(menu).toBeTruthy();
    // When no bookmarks exist, the menu shows the create form (input + Save) directly
    const input = await page.$('[data-testid="header-bookmark-name-input"]');
    const save = await page.$('[data-testid="header-bookmark-save"]');
    expect(input).toBeTruthy();
    expect(save).toBeTruthy();
  });

  it('typing name and saving creates bookmark', async () => {
    // Menu may have closed due to retry — reopen if needed
    await ensureBookmarksMenuOpen(page);
    await page.waitForSelector('[data-testid="header-bookmark-name-input"]', { timeout: 5000 });
    // Clear any existing text and type the name
    await page.click('[data-testid="header-bookmark-name-input"]', { clickCount: 3 });
    await page.type('[data-testid="header-bookmark-name-input"]', 'E2E Test Preset');
    await page.click('[data-testid="header-bookmark-save"]');
    // Save closes the menu on success — wait for the menu to disappear (confirms save worked)
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="header-bookmarks-menu"]'),
      { timeout: 10000 }
    );
    // Verify via API that preset was created
    const presetsRes = await apiRequest('/api/presets');
    expect(presetsRes.ok).toBe(true);
    const data = await presetsRes.json();
    const presets = data.presets;
    expect(Array.isArray(presets)).toBe(true);
    const testPreset = presets.find((p: { name: string }) => p.name === 'E2E Test Preset');
    expect(testPreset).toBeDefined();
    if (testPreset) presetIds.push(testPreset.id);
  });

  it('saved bookmark captures tab layout', async () => {
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
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="header-bookmarks-menu"]'),
      { timeout: 3000 }
    ).catch(() => {});
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
    await page.waitForSelector('[data-testid="terminal-tabs"]', { timeout: 10000 });
    const tabs = await page.$('[data-testid="terminal-tabs"]');
    expect(tabs).toBeTruthy();
  });
});
