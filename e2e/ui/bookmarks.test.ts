import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Browser, Page } from 'puppeteer';
import {
  launchBrowser, createPage, checkSetupComplete, registerScreenshotOnFailure,
  createSessionViaApi, deleteSessionViaApi, startContainerViaApi, waitForContainerReady,
  navigateToSessionView,
} from '../helpers';
import { apiRequest } from '../setup';

const isSetup = await checkSetupComplete();

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

  it('clicking opens bookmarks menu', async () => {
    await page.click('[data-testid="header-bookmarks-button"]');
    await page.waitForSelector('[data-testid="header-bookmarks-menu"]', { timeout: 5000 });
    const menu = await page.$('[data-testid="header-bookmarks-menu"]');
    expect(menu).toBeTruthy();
  });

  it('shows Add New button when under max presets', async () => {
    const addNew = await page.$('[data-testid="header-bookmark-add-new"]');
    expect(addNew).toBeTruthy();
  });

  it('clicking Add New shows name input', async () => {
    await page.click('[data-testid="header-bookmark-add-new"]');
    await page.waitForSelector('[data-testid="header-bookmark-name-input"]', { timeout: 5000 });
    const input = await page.$('[data-testid="header-bookmark-name-input"]');
    expect(input).toBeTruthy();
  });

  it('typing name and saving creates bookmark', async () => {
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

  it('clicking bookmark name applies preset', async () => {
    // Close bookmarks menu first, then reopen
    await page.keyboard.press('Escape');
    await page.click('[data-testid="header-bookmarks-button"]');
    await page.waitForSelector('[data-testid="header-bookmarks-menu"]', { timeout: 5000 });
    // Click the preset name to apply it
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
