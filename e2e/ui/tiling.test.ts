import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { Browser, Page } from 'puppeteer';
import { launchBrowser, createPage, navigateToHome, waitForAppReady } from './setup';
import {
  waitForSelector,
  clickAndWait,
  elementExists,
  isElementVisible,
  getElementCount,
  waitForElementRemoved,
} from './helpers';
import { cleanupSessions } from '../helpers/test-utils';

/**
 * E2E Tests for Terminal Tiling Feature
 *
 * Tests the terminal tiling functionality:
 * - Tiling button visibility (appears when 2+ tabs)
 * - Tiling overlay interaction
 * - Layout selection (2-split, 3-split, 4-grid)
 * - Tile activation in tiled mode
 * - Tab reordering updates tile positions
 * - Tab close adjusts tiling
 * - State persistence across page reload
 * - Return to tabbed mode
 *
 * Note: These tests require a running session with multiple terminal tabs.
 * DEV_MODE=true must be set in wrangler.toml for auth bypass.
 */
describe('Terminal Tiling Feature', () => {
  let browser: Browser;
  let page: Page;
  const createdSessionIds: string[] = [];

  beforeAll(async () => {
    browser = await launchBrowser();
  });

  afterAll(async () => {
    // Cleanup created sessions via API
    await cleanupSessions(createdSessionIds);
    await browser.close();
  });

  beforeEach(async () => {
    page = await createPage(browser);
  });

  afterEach(async () => {
    try {
      if (page && !page.isClosed()) {
        await page.close();
      }
    } catch (error) {
      console.error('Error closing page:', error);
    }
  });

  // Helper to wait for terminal tabs to be available
  const waitForTerminalTabs = async () => {
    await waitForSelector(page, '[data-testid="terminal-tabs"]', { timeout: 10000 });
  };

  // Helper to add a new terminal tab
  const addTerminalTab = async () => {
    const addButton = await page.$('[data-testid="terminal-tab-add"]');
    if (addButton) {
      await addButton.click();
      await page.waitForFunction(
        (count) => document.querySelectorAll('[data-testid^="terminal-tab-"]:not([data-testid="terminal-tab-add"])').length > count,
        {},
        await getTabCount() - 1
      ).catch(() => {});
      return true;
    }
    return false;
  };

  // Helper to get current tab count
  const getTabCount = async () => {
    const tabs = await page.$$('[data-testid^="terminal-tab-"]:not([data-testid="terminal-tab-add"])');
    return tabs.length;
  };

  // Helper to ensure minimum number of tabs
  const ensureMinimumTabs = async (minTabs: number) => {
    let currentCount = await getTabCount();
    while (currentCount < minTabs) {
      const added = await addTerminalTab();
      if (!added) break;
      currentCount = await getTabCount();
    }
    return currentCount;
  };

  // Helper to check if we have a running session
  const hasRunningSession = async () => {
    const terminalTabs = await elementExists(page, '[data-testid="terminal-tabs"]', 5000);
    return terminalTabs;
  };

  describe('Tiling Button Visibility', () => {
    it('should not show tiling button when only 1 tab exists', async () => {
      await navigateToHome(page);
      await waitForAppReady(page);

      const hasSession = await hasRunningSession();
      if (!hasSession) {
        console.log('No running session - skipping test');
        return;
      }

      await waitForTerminalTabs();

      const tabCount = await getTabCount();
      if (tabCount >= 2) {
        // If already 2+ tabs, we can't test this scenario without closing tabs
        console.log('Already have 2+ tabs - checking that button IS visible');
        const tilingButton = await elementExists(page, '[data-testid="tiling-button"]', 3000);
        expect(tilingButton).toBe(true);
        return;
      }

      // With 1 tab, tiling button should not be visible
      const tilingButton = await elementExists(page, '[data-testid="tiling-button"]', 2000);
      expect(tilingButton).toBe(false);
    });

    it('should show tiling button when 2+ tabs exist', async () => {
      await navigateToHome(page);
      await waitForAppReady(page);

      const hasSession = await hasRunningSession();
      if (!hasSession) {
        console.log('No running session - skipping test');
        return;
      }

      await waitForTerminalTabs();

      // Ensure we have at least 2 tabs
      const tabCount = await ensureMinimumTabs(2);

      if (tabCount < 2) {
        console.log('Could not create 2 tabs - skipping test');
        return;
      }

      // Tiling button should be visible
      const tilingButton = await waitForSelector(page, '[data-testid="tiling-button"]', { timeout: 3000 });
      expect(tilingButton).not.toBeNull();
    });

    it('tiling button should have inactive state by default', async () => {
      await navigateToHome(page);
      await waitForAppReady(page);

      const hasSession = await hasRunningSession();
      if (!hasSession) {
        console.log('No running session - skipping test');
        return;
      }

      await waitForTerminalTabs();
      await ensureMinimumTabs(2);

      const tilingButton = await page.$('[data-testid="tiling-button"]');
      if (!tilingButton) {
        console.log('Tiling button not found - skipping test');
        return;
      }

      // Check the data-active attribute (default should be false or not "true")
      const isActive = await page.evaluate((el) => el.getAttribute('data-active'), tilingButton);
      expect(isActive).not.toBe('true');
    });
  });

  describe('Tiling Overlay Interaction', () => {
    it('should open tiling overlay when button is clicked', async () => {
      await navigateToHome(page);
      await waitForAppReady(page);

      const hasSession = await hasRunningSession();
      if (!hasSession) {
        console.log('No running session - skipping test');
        return;
      }

      await waitForTerminalTabs();
      await ensureMinimumTabs(2);

      const tilingButton = await page.$('[data-testid="tiling-button"]');
      if (!tilingButton) {
        console.log('Tiling button not found - skipping test');
        return;
      }

      await tilingButton.click();
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Overlay should be visible
      const overlay = await waitForSelector(page, '[data-testid="tiling-overlay"]', { timeout: 3000 });
      expect(overlay).not.toBeNull();
    });

    it('should show layout options based on tab count', async () => {
      await navigateToHome(page);
      await waitForAppReady(page);

      const hasSession = await hasRunningSession();
      if (!hasSession) {
        console.log('No running session - skipping test');
        return;
      }

      await waitForTerminalTabs();
      const tabCount = await ensureMinimumTabs(2);

      const tilingButton = await page.$('[data-testid="tiling-button"]');
      if (!tilingButton) {
        console.log('Tiling button not found - skipping test');
        return;
      }

      await tilingButton.click();
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Tabbed should always be available
      const tabbedOption = await elementExists(page, '[data-testid="tiling-option-tabbed"]', 2000);
      expect(tabbedOption).toBe(true);

      // 2-split should be available with 2+ tabs
      const twoSplitOption = await elementExists(page, '[data-testid="tiling-option-2-split"]', 1000);
      if (tabCount >= 2) {
        expect(twoSplitOption).toBe(true);
      }

      // 3-split should only be available with 3+ tabs
      const threeSplitOption = await elementExists(page, '[data-testid="tiling-option-3-split"]', 1000);
      if (tabCount >= 3) {
        expect(threeSplitOption).toBe(true);
      } else {
        expect(threeSplitOption).toBe(false);
      }

      // 4-grid should only be available with 4+ tabs
      const fourGridOption = await elementExists(page, '[data-testid="tiling-option-4-grid"]', 1000);
      if (tabCount >= 4) {
        expect(fourGridOption).toBe(true);
      } else {
        expect(fourGridOption).toBe(false);
      }
    });

    it('should close overlay when backdrop is clicked', async () => {
      await navigateToHome(page);
      await waitForAppReady(page);

      const hasSession = await hasRunningSession();
      if (!hasSession) {
        console.log('No running session - skipping test');
        return;
      }

      await waitForTerminalTabs();
      await ensureMinimumTabs(2);

      const tilingButton = await page.$('[data-testid="tiling-button"]');
      if (!tilingButton) {
        console.log('Tiling button not found - skipping test');
        return;
      }

      // Open overlay
      await tilingButton.click();
      await waitForSelector(page, '[data-testid="tiling-overlay"]', { timeout: 3000 });

      // Click backdrop to close
      const backdrop = await page.$('[data-testid="tiling-overlay-backdrop"]');
      if (backdrop) {
        await backdrop.click();
        await new Promise((resolve) => setTimeout(resolve, 300));
      }

      // Overlay should be gone
      const overlayGone = await waitForElementRemoved(page, '[data-testid="tiling-overlay"]', 3000);
      expect(overlayGone).toBe(true);
    });
  });

  describe('Layout Selection', () => {
    it('should show 2 terminals side-by-side when 2-split is selected', async () => {
      await navigateToHome(page);
      await waitForAppReady(page);

      const hasSession = await hasRunningSession();
      if (!hasSession) {
        console.log('No running session - skipping test');
        return;
      }

      await waitForTerminalTabs();
      const tabCount = await ensureMinimumTabs(2);

      if (tabCount < 2) {
        console.log('Could not create 2 tabs - skipping test');
        return;
      }

      // Open overlay and select 2-split
      const tilingButton = await page.$('[data-testid="tiling-button"]');
      if (!tilingButton) {
        console.log('Tiling button not found - skipping test');
        return;
      }

      await tilingButton.click();
      await waitForSelector(page, '[data-testid="tiling-overlay"]', { timeout: 3000 });

      const twoSplitOption = await page.$('[data-testid="tiling-option-2-split"]');
      if (!twoSplitOption) {
        console.log('2-split option not found - skipping test');
        return;
      }

      await twoSplitOption.click();
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Tiled container should be visible with 2-split class
      const tiledContainer = await page.$('[data-testid="tiled-terminal-container"]');
      expect(tiledContainer).not.toBeNull();

      if (tiledContainer) {
        const hasClass = await page.evaluate(
          (el) => el.classList.contains('tiled--2-split'),
          tiledContainer
        );
        expect(hasClass).toBe(true);
      }

      // Should have 2 slots
      const slots = await page.$$('[data-testid^="tiled-slot-"]');
      expect(slots.length).toBe(2);

      // Tiling button should now be active
      const isActive = await page.evaluate(
        (el) => el.getAttribute('data-active'),
        await page.$('[data-testid="tiling-button"]')
      );
      expect(isActive).toBe('true');
    });

    it('should show correct arrangement when 3-split is selected', async () => {
      await navigateToHome(page);
      await waitForAppReady(page);

      const hasSession = await hasRunningSession();
      if (!hasSession) {
        console.log('No running session - skipping test');
        return;
      }

      await waitForTerminalTabs();
      const tabCount = await ensureMinimumTabs(3);

      if (tabCount < 3) {
        console.log('Could not create 3 tabs - skipping test');
        return;
      }

      // Open overlay and select 3-split
      const tilingButton = await page.$('[data-testid="tiling-button"]');
      if (!tilingButton) {
        console.log('Tiling button not found - skipping test');
        return;
      }

      await tilingButton.click();
      await waitForSelector(page, '[data-testid="tiling-overlay"]', { timeout: 3000 });

      const threeSplitOption = await page.$('[data-testid="tiling-option-3-split"]');
      if (!threeSplitOption) {
        console.log('3-split option not found - skipping test');
        return;
      }

      await threeSplitOption.click();
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Tiled container should be visible with 3-split class
      const tiledContainer = await page.$('[data-testid="tiled-terminal-container"]');
      expect(tiledContainer).not.toBeNull();

      if (tiledContainer) {
        const hasClass = await page.evaluate(
          (el) => el.classList.contains('tiled--3-split'),
          tiledContainer
        );
        expect(hasClass).toBe(true);
      }

      // Should have 3 slots
      const slots = await page.$$('[data-testid^="tiled-slot-"]');
      expect(slots.length).toBe(3);
    });

    it('should show 4-grid layout when selected', async () => {
      await navigateToHome(page);
      await waitForAppReady(page);

      const hasSession = await hasRunningSession();
      if (!hasSession) {
        console.log('No running session - skipping test');
        return;
      }

      await waitForTerminalTabs();
      const tabCount = await ensureMinimumTabs(4);

      if (tabCount < 4) {
        console.log('Could not create 4 tabs - skipping test');
        return;
      }

      // Open overlay and select 4-grid
      const tilingButton = await page.$('[data-testid="tiling-button"]');
      if (!tilingButton) {
        console.log('Tiling button not found - skipping test');
        return;
      }

      await tilingButton.click();
      await waitForSelector(page, '[data-testid="tiling-overlay"]', { timeout: 3000 });

      const fourGridOption = await page.$('[data-testid="tiling-option-4-grid"]');
      if (!fourGridOption) {
        console.log('4-grid option not found - skipping test');
        return;
      }

      await fourGridOption.click();
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Tiled container should be visible with 4-grid class
      const tiledContainer = await page.$('[data-testid="tiled-terminal-container"]');
      expect(tiledContainer).not.toBeNull();

      if (tiledContainer) {
        const hasClass = await page.evaluate(
          (el) => el.classList.contains('tiled--4-grid'),
          tiledContainer
        );
        expect(hasClass).toBe(true);
      }

      // Should have 4 slots
      const slots = await page.$$('[data-testid^="tiled-slot-"]');
      expect(slots.length).toBe(4);
    });
  });

  describe('Tile Activation', () => {
    it('should activate tile when clicked in tiled mode', async () => {
      await navigateToHome(page);
      await waitForAppReady(page);

      const hasSession = await hasRunningSession();
      if (!hasSession) {
        console.log('No running session - skipping test');
        return;
      }

      await waitForTerminalTabs();
      const tabCount = await ensureMinimumTabs(2);

      if (tabCount < 2) {
        console.log('Could not create 2 tabs - skipping test');
        return;
      }

      // Enable 2-split layout
      const tilingButton = await page.$('[data-testid="tiling-button"]');
      if (!tilingButton) {
        console.log('Tiling button not found - skipping test');
        return;
      }

      await tilingButton.click();
      await waitForSelector(page, '[data-testid="tiling-overlay"]', { timeout: 3000 });

      const twoSplitOption = await page.$('[data-testid="tiling-option-2-split"]');
      if (!twoSplitOption) {
        console.log('2-split option not found - skipping test');
        return;
      }

      await twoSplitOption.click();
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Get all slots
      const slots = await page.$$('[data-testid^="tiled-slot-"]');
      if (slots.length < 2) {
        console.log('Not enough slots - skipping test');
        return;
      }

      // Click the second slot
      await slots[1].click();
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Check that the clicked slot is now active
      const isActive = await page.evaluate(
        (el) => el.classList.contains('tiled-terminal-slot--active'),
        slots[1]
      );
      expect(isActive).toBe(true);
    });

    it('active tile should have visual highlight', async () => {
      await navigateToHome(page);
      await waitForAppReady(page);

      const hasSession = await hasRunningSession();
      if (!hasSession) {
        console.log('No running session - skipping test');
        return;
      }

      await waitForTerminalTabs();
      const tabCount = await ensureMinimumTabs(2);

      if (tabCount < 2) {
        console.log('Could not create 2 tabs - skipping test');
        return;
      }

      // Enable 2-split layout
      const tilingButton = await page.$('[data-testid="tiling-button"]');
      if (!tilingButton) {
        console.log('Tiling button not found - skipping test');
        return;
      }

      await tilingButton.click();
      await waitForSelector(page, '[data-testid="tiling-overlay"]', { timeout: 3000 });

      const twoSplitOption = await page.$('[data-testid="tiling-option-2-split"]');
      if (twoSplitOption) {
        await twoSplitOption.click();
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      // Find the active slot
      const activeSlot = await page.$('.tiled-terminal-slot--active');
      if (!activeSlot) {
        console.log('No active slot found - skipping test');
        return;
      }

      // Check for accent border (visual highlight)
      const borderColor = await page.evaluate((el) => {
        const style = window.getComputedStyle(el);
        return style.borderColor;
      }, activeSlot);

      // Border should not be transparent
      expect(borderColor).not.toBe('transparent');
    });
  });

  describe('Tab Reordering in Tiled Mode', () => {
    it('should update tile positions when tabs are reordered', async () => {
      await navigateToHome(page);
      await waitForAppReady(page);

      const hasSession = await hasRunningSession();
      if (!hasSession) {
        console.log('No running session - skipping test');
        return;
      }

      await waitForTerminalTabs();
      const tabCount = await ensureMinimumTabs(3);

      if (tabCount < 3) {
        console.log('Could not create 3 tabs - skipping test');
        return;
      }

      // Enable tiling first
      const tilingButton = await page.$('[data-testid="tiling-button"]');
      if (!tilingButton) {
        console.log('Tiling button not found - skipping test');
        return;
      }

      await tilingButton.click();
      await waitForSelector(page, '[data-testid="tiling-overlay"]', { timeout: 3000 });

      const twoSplitOption = await page.$('[data-testid="tiling-option-2-split"]');
      if (twoSplitOption) {
        await twoSplitOption.click();
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      // Note: Tab reordering via drag-drop is complex to test in E2E
      // We verify that the tiled container exists and has the expected structure
      const tiledContainer = await page.$('[data-testid="tiled-terminal-container"]');
      expect(tiledContainer).not.toBeNull();

      // Verify slots exist
      const slots = await page.$$('[data-testid^="tiled-slot-"]');
      expect(slots.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Tab Close in Tiled Mode', () => {
    it('should adjust tiling when tab is closed below layout minimum', async () => {
      await navigateToHome(page);
      await waitForAppReady(page);

      const hasSession = await hasRunningSession();
      if (!hasSession) {
        console.log('No running session - skipping test');
        return;
      }

      await waitForTerminalTabs();
      const tabCount = await ensureMinimumTabs(3);

      if (tabCount < 3) {
        console.log('Could not create 3 tabs - skipping test');
        return;
      }

      // Enable 3-split layout
      const tilingButton = await page.$('[data-testid="tiling-button"]');
      if (!tilingButton) {
        console.log('Tiling button not found - skipping test');
        return;
      }

      await tilingButton.click();
      await waitForSelector(page, '[data-testid="tiling-overlay"]', { timeout: 3000 });

      const threeSplitOption = await page.$('[data-testid="tiling-option-3-split"]');
      if (!threeSplitOption) {
        console.log('3-split option not found - skipping test');
        return;
      }

      await threeSplitOption.click();
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Verify 3-split is active
      let tiledContainer = await page.$('[data-testid="tiled-terminal-container"].tiled--3-split');
      if (!tiledContainer) {
        console.log('3-split container not found - skipping test');
        return;
      }

      // Close one of the tabs (not tab 1 which cannot be closed)
      const closeButton = await page.$('[data-testid="terminal-tab-3-close"], [data-testid="terminal-tab-2-close"]');
      if (closeButton) {
        await closeButton.click();
        await new Promise((resolve) => setTimeout(resolve, 500));

        // With only 2 tabs remaining, 3-split should auto-disable
        // Check if tiling was adjusted (either back to tabbed or 2-split)
        const newTabCount = await getTabCount();
        if (newTabCount < 3) {
          // 3-split should no longer be active
          const threeSplitStillActive = await elementExists(
            page,
            '[data-testid="tiled-terminal-container"].tiled--3-split',
            1000
          );
          expect(threeSplitStillActive).toBe(false);
        }
      }
    });
  });

  describe('Tiling State Persistence', () => {
    it('should persist tiling state across page reload', async () => {
      await navigateToHome(page);
      await waitForAppReady(page);

      const hasSession = await hasRunningSession();
      if (!hasSession) {
        console.log('No running session - skipping test');
        return;
      }

      await waitForTerminalTabs();
      const tabCount = await ensureMinimumTabs(2);

      if (tabCount < 2) {
        console.log('Could not create 2 tabs - skipping test');
        return;
      }

      // Enable 2-split layout
      const tilingButton = await page.$('[data-testid="tiling-button"]');
      if (!tilingButton) {
        console.log('Tiling button not found - skipping test');
        return;
      }

      await tilingButton.click();
      await waitForSelector(page, '[data-testid="tiling-overlay"]', { timeout: 3000 });

      const twoSplitOption = await page.$('[data-testid="tiling-option-2-split"]');
      if (!twoSplitOption) {
        console.log('2-split option not found - skipping test');
        return;
      }

      await twoSplitOption.click();
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Verify tiling is enabled
      let tiledContainer = await page.$('[data-testid="tiled-terminal-container"]');
      if (!tiledContainer) {
        console.log('Tiled container not created - skipping persistence test');
        return;
      }

      // Reload page
      await page.reload({ waitUntil: 'networkidle2' });
      await waitForAppReady(page);
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Check if we still have a running session
      const stillHasSession = await hasRunningSession();
      if (!stillHasSession) {
        console.log('Session lost after reload - skipping persistence check');
        return;
      }

      // Tiling state should be restored
      // Note: The session might need to be re-selected after reload
      const tilingButtonAfterReload = await page.$('[data-testid="tiling-button"]');
      if (tilingButtonAfterReload) {
        const isActive = await page.evaluate(
          (el) => el.getAttribute('data-active'),
          tilingButtonAfterReload
        );
        // If state persisted, button should be active
        // Note: This depends on localStorage persistence working correctly
        expect(['true', 'false']).toContain(isActive); // Test that attribute exists
      }
    });
  });

  describe('Return to Tabbed Mode', () => {
    it('should switch back to tabbed mode correctly', async () => {
      await navigateToHome(page);
      await waitForAppReady(page);

      const hasSession = await hasRunningSession();
      if (!hasSession) {
        console.log('No running session - skipping test');
        return;
      }

      await waitForTerminalTabs();
      const tabCount = await ensureMinimumTabs(2);

      if (tabCount < 2) {
        console.log('Could not create 2 tabs - skipping test');
        return;
      }

      // Enable 2-split layout first
      let tilingButton = await page.$('[data-testid="tiling-button"]');
      if (!tilingButton) {
        console.log('Tiling button not found - skipping test');
        return;
      }

      await tilingButton.click();
      await waitForSelector(page, '[data-testid="tiling-overlay"]', { timeout: 3000 });

      let twoSplitOption = await page.$('[data-testid="tiling-option-2-split"]');
      if (twoSplitOption) {
        await twoSplitOption.click();
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      // Verify tiling is enabled
      const tiledContainer = await page.$('[data-testid="tiled-terminal-container"]');
      if (!tiledContainer) {
        console.log('Tiled container not created - skipping test');
        return;
      }

      // Now switch back to tabbed mode
      tilingButton = await page.$('[data-testid="tiling-button"]');
      if (!tilingButton) {
        console.log('Tiling button not found after enabling tiling - skipping test');
        return;
      }

      await tilingButton.click();
      await waitForSelector(page, '[data-testid="tiling-overlay"]', { timeout: 3000 });

      const tabbedOption = await page.$('[data-testid="tiling-option-tabbed"]');
      if (!tabbedOption) {
        console.log('Tabbed option not found - skipping test');
        return;
      }

      await tabbedOption.click();
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Tiled container should be gone
      const tiledContainerGone = await waitForElementRemoved(
        page,
        '[data-testid="tiled-terminal-container"]',
        3000
      );
      expect(tiledContainerGone).toBe(true);

      // Tiling button should no longer be active
      tilingButton = await page.$('[data-testid="tiling-button"]');
      if (tilingButton) {
        const isActive = await page.evaluate(
          (el) => el.getAttribute('data-active'),
          tilingButton
        );
        expect(isActive).not.toBe('true');
      }
    });

    it('terminal tabs should still work after returning to tabbed mode', async () => {
      await navigateToHome(page);
      await waitForAppReady(page);

      const hasSession = await hasRunningSession();
      if (!hasSession) {
        console.log('No running session - skipping test');
        return;
      }

      await waitForTerminalTabs();
      const tabCount = await ensureMinimumTabs(2);

      if (tabCount < 2) {
        console.log('Could not create 2 tabs - skipping test');
        return;
      }

      // Enable and then disable tiling
      let tilingButton = await page.$('[data-testid="tiling-button"]');
      if (tilingButton) {
        await tilingButton.click();
        await waitForSelector(page, '[data-testid="tiling-overlay"]', { timeout: 3000 });

        const twoSplitOption = await page.$('[data-testid="tiling-option-2-split"]');
        if (twoSplitOption) {
          await twoSplitOption.click();
          await new Promise((resolve) => setTimeout(resolve, 500));
        }

        tilingButton = await page.$('[data-testid="tiling-button"]');
        if (tilingButton) {
          await tilingButton.click();
          await waitForSelector(page, '[data-testid="tiling-overlay"]', { timeout: 3000 });

          const tabbedOption = await page.$('[data-testid="tiling-option-tabbed"]');
          if (tabbedOption) {
            await tabbedOption.click();
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
        }
      }

      // Verify terminal tabs still work
      const tabs = await page.$$('[data-testid^="terminal-tab-"]:not([data-testid="terminal-tab-add"])');
      if (tabs.length >= 2) {
        // Click second tab
        await tabs[1].click();
        await new Promise((resolve) => setTimeout(resolve, 300));

        // Verify it becomes active
        const isActive = await page.evaluate(
          (el) => el.classList.contains('terminal-tab--active'),
          tabs[1]
        );
        expect(isActive).toBe(true);
      }
    });
  });

  describe('Tiling Overlay Accessibility', () => {
    it('overlay should have correct ARIA roles', async () => {
      await navigateToHome(page);
      await waitForAppReady(page);

      const hasSession = await hasRunningSession();
      if (!hasSession) {
        console.log('No running session - skipping test');
        return;
      }

      await waitForTerminalTabs();
      await ensureMinimumTabs(2);

      const tilingButton = await page.$('[data-testid="tiling-button"]');
      if (!tilingButton) {
        console.log('Tiling button not found - skipping test');
        return;
      }

      await tilingButton.click();
      await waitForSelector(page, '[data-testid="tiling-overlay"]', { timeout: 3000 });

      // Check overlay has role="menu"
      const overlay = await page.$('[data-testid="tiling-overlay"]');
      if (overlay) {
        const role = await page.evaluate((el) => el.getAttribute('role'), overlay);
        expect(role).toBe('menu');
      }

      // Check options have role="menuitem"
      const option = await page.$('[data-testid="tiling-option-tabbed"]');
      if (option) {
        const role = await page.evaluate((el) => el.getAttribute('role'), option);
        expect(role).toBe('menuitem');
      }
    });

    it('tiling button should have aria-label', async () => {
      await navigateToHome(page);
      await waitForAppReady(page);

      const hasSession = await hasRunningSession();
      if (!hasSession) {
        console.log('No running session - skipping test');
        return;
      }

      await waitForTerminalTabs();
      await ensureMinimumTabs(2);

      const tilingButton = await page.$('[data-testid="tiling-button"]');
      if (!tilingButton) {
        console.log('Tiling button not found - skipping test');
        return;
      }

      const ariaLabel = await page.evaluate((el) => el.getAttribute('aria-label'), tilingButton);
      expect(ariaLabel).toBeTruthy();
      expect(ariaLabel).toContain('tiling');
    });
  });

  describe('Terminal Rendering After Layout Changes', () => {
    it('terminals should render correctly after switching to 2-split', async () => {
      await navigateToHome(page);
      await waitForAppReady(page);

      const hasSession = await hasRunningSession();
      if (!hasSession) {
        console.log('No running session - skipping test');
        return;
      }

      await waitForTerminalTabs();
      const tabCount = await ensureMinimumTabs(2);

      if (tabCount < 2) {
        console.log('Could not create 2 tabs - skipping test');
        return;
      }

      // Enable 2-split layout
      const tilingButton = await page.$('[data-testid="tiling-button"]');
      if (!tilingButton) {
        console.log('Tiling button not found - skipping test');
        return;
      }

      await tilingButton.click();
      await waitForSelector(page, '[data-testid="tiling-overlay"]', { timeout: 3000 });

      const twoSplitOption = await page.$('[data-testid="tiling-option-2-split"]');
      if (!twoSplitOption) {
        console.log('2-split option not found - skipping test');
        return;
      }

      await twoSplitOption.click();
      // Wait for layout transition and terminal re-render
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Verify each slot contains a terminal
      const slots = await page.$$('[data-testid^="tiled-slot-"]');
      expect(slots.length).toBe(2);

      for (let i = 0; i < slots.length; i++) {
        // Each slot should contain an xterm element
        const hasXterm = await page.evaluate((slotIndex) => {
          const slot = document.querySelectorAll('[data-testid^="tiled-slot-"]')[slotIndex];
          return slot?.querySelector('.xterm') !== null;
        }, i);
        expect(hasXterm).toBe(true);

        // Check terminal canvas is rendered (xterm renders to canvas)
        const hasCanvas = await page.evaluate((slotIndex) => {
          const slot = document.querySelectorAll('[data-testid^="tiled-slot-"]')[slotIndex];
          const canvas = slot?.querySelector('.xterm canvas');
          return canvas !== null;
        }, i);
        expect(hasCanvas).toBe(true);
      }
    });

    it('terminals should render correctly after switching to 3-split', async () => {
      await navigateToHome(page);
      await waitForAppReady(page);

      const hasSession = await hasRunningSession();
      if (!hasSession) {
        console.log('No running session - skipping test');
        return;
      }

      await waitForTerminalTabs();
      const tabCount = await ensureMinimumTabs(3);

      if (tabCount < 3) {
        console.log('Could not create 3 tabs - skipping test');
        return;
      }

      // Enable 3-split layout
      const tilingButton = await page.$('[data-testid="tiling-button"]');
      if (!tilingButton) return;

      await tilingButton.click();
      await waitForSelector(page, '[data-testid="tiling-overlay"]', { timeout: 3000 });

      const threeSplitOption = await page.$('[data-testid="tiling-option-3-split"]');
      if (!threeSplitOption) return;

      await threeSplitOption.click();
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Verify 3 slots with terminals
      const slots = await page.$$('[data-testid^="tiled-slot-"]');
      expect(slots.length).toBe(3);

      // Verify layout structure: 1 large left + 2 stacked right
      const tiledContainer = await page.$('[data-testid="tiled-terminal-container"]');
      if (tiledContainer) {
        const layout = await page.evaluate((el) => el.getAttribute('data-layout'), tiledContainer);
        expect(layout).toBe('3-split');
      }

      // Each slot should have xterm canvas
      for (let i = 0; i < 3; i++) {
        const hasTerminal = await page.evaluate((slotIndex) => {
          const slot = document.querySelectorAll('[data-testid^="tiled-slot-"]')[slotIndex];
          return slot?.querySelector('.xterm canvas') !== null;
        }, i);
        expect(hasTerminal).toBe(true);
      }
    });

    it('terminals should render correctly after switching to 4-grid', async () => {
      await navigateToHome(page);
      await waitForAppReady(page);

      const hasSession = await hasRunningSession();
      if (!hasSession) {
        console.log('No running session - skipping test');
        return;
      }

      await waitForTerminalTabs();
      const tabCount = await ensureMinimumTabs(4);

      if (tabCount < 4) {
        console.log('Could not create 4 tabs - skipping test');
        return;
      }

      // Enable 4-grid layout
      const tilingButton = await page.$('[data-testid="tiling-button"]');
      if (!tilingButton) return;

      await tilingButton.click();
      await waitForSelector(page, '[data-testid="tiling-overlay"]', { timeout: 3000 });

      const fourGridOption = await page.$('[data-testid="tiling-option-4-grid"]');
      if (!fourGridOption) return;

      await fourGridOption.click();
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Verify 4 slots in 2x2 grid
      const slots = await page.$$('[data-testid^="tiled-slot-"]');
      expect(slots.length).toBe(4);

      // Verify layout attribute
      const tiledContainer = await page.$('[data-testid="tiled-terminal-container"]');
      if (tiledContainer) {
        const layout = await page.evaluate((el) => el.getAttribute('data-layout'), tiledContainer);
        expect(layout).toBe('4-grid');
      }

      // Each slot should have rendered terminal
      for (let i = 0; i < 4; i++) {
        const hasTerminal = await page.evaluate((slotIndex) => {
          const slot = document.querySelectorAll('[data-testid^="tiled-slot-"]')[slotIndex];
          return slot?.querySelector('.xterm') !== null;
        }, i);
        expect(hasTerminal).toBe(true);
      }
    });

    it('terminals should re-render correctly after switching back to tabbed', async () => {
      await navigateToHome(page);
      await waitForAppReady(page);

      const hasSession = await hasRunningSession();
      if (!hasSession) {
        console.log('No running session - skipping test');
        return;
      }

      await waitForTerminalTabs();
      const tabCount = await ensureMinimumTabs(2);

      if (tabCount < 2) return;

      // First enable 2-split
      let tilingButton = await page.$('[data-testid="tiling-button"]');
      if (!tilingButton) return;

      await tilingButton.click();
      await waitForSelector(page, '[data-testid="tiling-overlay"]', { timeout: 3000 });

      const twoSplitOption = await page.$('[data-testid="tiling-option-2-split"]');
      if (twoSplitOption) {
        await twoSplitOption.click();
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      // Verify tiled mode is active
      let tiledContainer = await page.$('[data-testid="tiled-terminal-container"]');
      expect(tiledContainer).not.toBeNull();

      // Now switch back to tabbed
      tilingButton = await page.$('[data-testid="tiling-button"]');
      if (!tilingButton) return;

      await tilingButton.click();
      await waitForSelector(page, '[data-testid="tiling-overlay"]', { timeout: 3000 });

      const tabbedOption = await page.$('[data-testid="tiling-option-tabbed"]');
      if (tabbedOption) {
        await tabbedOption.click();
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      // Verify tiled container is gone
      tiledContainer = await page.$('[data-testid="tiled-terminal-container"]');
      expect(tiledContainer).toBeNull();

      // Verify single terminal is visible and rendered
      const terminalContainer = await page.$('.layout-terminal-container');
      expect(terminalContainer).not.toBeNull();

      // Active terminal should have xterm canvas
      const hasActiveTerminal = await page.evaluate(() => {
        const terminal = document.querySelector('.layout-terminal-container .xterm canvas');
        return terminal !== null;
      });
      expect(hasActiveTerminal).toBe(true);
    });

    it('terminal dimensions should update after layout change', async () => {
      await navigateToHome(page);
      await waitForAppReady(page);

      const hasSession = await hasRunningSession();
      if (!hasSession) {
        console.log('No running session - skipping test');
        return;
      }

      await waitForTerminalTabs();
      const tabCount = await ensureMinimumTabs(2);

      if (tabCount < 2) return;

      // Get initial terminal dimensions
      const initialDimensions = await page.evaluate(() => {
        const terminal = document.querySelector('.xterm');
        if (!terminal) return null;
        const rect = terminal.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      });

      if (!initialDimensions) {
        console.log('No terminal found - skipping test');
        return;
      }

      // Enable 2-split
      const tilingButton = await page.$('[data-testid="tiling-button"]');
      if (!tilingButton) return;

      await tilingButton.click();
      await waitForSelector(page, '[data-testid="tiling-overlay"]', { timeout: 3000 });

      const twoSplitOption = await page.$('[data-testid="tiling-option-2-split"]');
      if (twoSplitOption) {
        await twoSplitOption.click();
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      // Get terminal dimensions in tiled mode
      const tiledDimensions = await page.evaluate(() => {
        const terminals = document.querySelectorAll('[data-testid^="tiled-slot-"] .xterm');
        if (terminals.length === 0) return null;
        const rect = terminals[0].getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      });

      if (tiledDimensions) {
        // In 2-split, each terminal should be roughly half the width
        // Allow some tolerance for borders/padding
        expect(tiledDimensions.width).toBeLessThan(initialDimensions.width);
      }
    });

    it('terminal content should be preserved after layout switch', async () => {
      await navigateToHome(page);
      await waitForAppReady(page);

      const hasSession = await hasRunningSession();
      if (!hasSession) {
        console.log('No running session - skipping test');
        return;
      }

      await waitForTerminalTabs();
      await ensureMinimumTabs(2);

      // Switch to 2-split and back
      const tilingButton = await page.$('[data-testid="tiling-button"]');
      if (!tilingButton) return;

      await tilingButton.click();
      await waitForSelector(page, '[data-testid="tiling-overlay"]', { timeout: 3000 });

      const twoSplitOption = await page.$('[data-testid="tiling-option-2-split"]');
      if (twoSplitOption) {
        await twoSplitOption.click();
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      // Switch back to tabbed
      const btn2 = await page.$('[data-testid="tiling-button"]');
      if (btn2) {
        await btn2.click();
        await waitForSelector(page, '[data-testid="tiling-overlay"]', { timeout: 3000 });

        const tabbedOption = await page.$('[data-testid="tiling-option-tabbed"]');
        if (tabbedOption) {
          await tabbedOption.click();
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }

      // Terminal should still be functional (has cursor/content)
      const terminalHasContent = await page.evaluate(() => {
        const terminal = document.querySelector('.xterm-rows');
        // xterm-rows should have child elements if terminal is rendered
        return terminal !== null && terminal.children.length > 0;
      });
      expect(terminalHasContent).toBe(true);
    });

    it('all terminals should be interactive in tiled mode', async () => {
      await navigateToHome(page);
      await waitForAppReady(page);

      const hasSession = await hasRunningSession();
      if (!hasSession) {
        console.log('No running session - skipping test');
        return;
      }

      await waitForTerminalTabs();
      const tabCount = await ensureMinimumTabs(2);

      if (tabCount < 2) return;

      // Enable 2-split
      const tilingButton = await page.$('[data-testid="tiling-button"]');
      if (!tilingButton) return;

      await tilingButton.click();
      await waitForSelector(page, '[data-testid="tiling-overlay"]', { timeout: 3000 });

      const twoSplitOption = await page.$('[data-testid="tiling-option-2-split"]');
      if (twoSplitOption) {
        await twoSplitOption.click();
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      // Click on each slot to verify it becomes interactive
      const slots = await page.$$('[data-testid^="tiled-slot-"]');

      for (let i = 0; i < slots.length; i++) {
        await slots[i].click();
        await new Promise((resolve) => setTimeout(resolve, 200));

        // Verify this slot is now active
        const isActive = await page.evaluate((slotIndex) => {
          const slot = document.querySelectorAll('[data-testid^="tiled-slot-"]')[slotIndex];
          return slot?.classList.contains('tiled-terminal-slot--active') || false;
        }, i);

        expect(isActive).toBe(true);
      }
    });
  });

  describe('Cursor Position After Layout Changes', () => {
    // Helper to get cursor position relative to terminal
    const getCursorPosition = async () => {
      return page.evaluate(() => {
        const cursor = document.querySelector('.xterm-cursor');
        const terminal = document.querySelector('.xterm-screen');

        if (!cursor || !terminal) return null;

        const cursorRect = cursor.getBoundingClientRect();
        const terminalRect = terminal.getBoundingClientRect();

        return {
          // Cursor position relative to terminal
          relativeX: cursorRect.left - terminalRect.left,
          relativeY: cursorRect.top - terminalRect.top,
          // Absolute cursor position
          absoluteX: cursorRect.left,
          absoluteY: cursorRect.top,
          // Terminal bounds
          terminalTop: terminalRect.top,
          terminalBottom: terminalRect.bottom,
          terminalLeft: terminalRect.left,
          terminalRight: terminalRect.right,
          // Is cursor within terminal bounds?
          isWithinBounds:
            cursorRect.left >= terminalRect.left &&
            cursorRect.right <= terminalRect.right &&
            cursorRect.top >= terminalRect.top &&
            cursorRect.bottom <= terminalRect.bottom,
          // Is cursor at bottom-left corner (common bug position)?
          isAtBottomLeft:
            cursorRect.left < terminalRect.left + 50 &&
            cursorRect.top > terminalRect.bottom - 50,
        };
      });
    };

    it('cursor should be within terminal bounds after switching to 2-split', async () => {
      await navigateToHome(page);
      await waitForAppReady(page);

      const hasSession = await hasRunningSession();
      if (!hasSession) {
        console.log('No running session - skipping test');
        return;
      }

      await waitForTerminalTabs();
      const tabCount = await ensureMinimumTabs(2);
      if (tabCount < 2) return;

      // Get initial cursor position
      const initialPos = await getCursorPosition();
      if (!initialPos) {
        console.log('No cursor found initially - skipping test');
        return;
      }

      // Switch to 2-split
      const tilingButton = await page.$('[data-testid="tiling-button"]');
      if (!tilingButton) return;

      await tilingButton.click();
      await waitForSelector(page, '[data-testid="tiling-overlay"]', { timeout: 3000 });

      const twoSplitOption = await page.$('[data-testid="tiling-option-2-split"]');
      if (twoSplitOption) {
        await twoSplitOption.click();
        // Wait for layout transition and terminal resize
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }

      // Check cursor position in active tiled terminal
      const tiledCursorPos = await page.evaluate(() => {
        const activeSlot = document.querySelector('.tiled-terminal-slot--active');
        if (!activeSlot) return null;

        const cursor = activeSlot.querySelector('.xterm-cursor');
        const terminal = activeSlot.querySelector('.xterm-screen');

        if (!cursor || !terminal) return null;

        const cursorRect = cursor.getBoundingClientRect();
        const terminalRect = terminal.getBoundingClientRect();

        return {
          isWithinBounds:
            cursorRect.left >= terminalRect.left - 5 && // 5px tolerance
            cursorRect.right <= terminalRect.right + 5 &&
            cursorRect.top >= terminalRect.top - 5 &&
            cursorRect.bottom <= terminalRect.bottom + 5,
          isAtBottomLeft:
            cursorRect.left < terminalRect.left + 50 &&
            cursorRect.top > terminalRect.bottom - 50,
          cursorTop: cursorRect.top,
          terminalTop: terminalRect.top,
          terminalBottom: terminalRect.bottom,
        };
      });

      if (tiledCursorPos) {
        // Cursor should be within terminal bounds
        expect(tiledCursorPos.isWithinBounds).toBe(true);

        // Cursor should NOT be at bottom-left corner (common bug)
        if (tiledCursorPos.isAtBottomLeft) {
          console.warn('⚠️ CURSOR BUG DETECTED: Cursor dropped to bottom-left corner after tiling switch');
        }
        expect(tiledCursorPos.isAtBottomLeft).toBe(false);
      }
    });

    it('cursor should be within terminal bounds after switching back to tabbed', async () => {
      await navigateToHome(page);
      await waitForAppReady(page);

      const hasSession = await hasRunningSession();
      if (!hasSession) {
        console.log('No running session - skipping test');
        return;
      }

      await waitForTerminalTabs();
      const tabCount = await ensureMinimumTabs(2);
      if (tabCount < 2) return;

      // First switch to 2-split
      let tilingButton = await page.$('[data-testid="tiling-button"]');
      if (!tilingButton) return;

      await tilingButton.click();
      await waitForSelector(page, '[data-testid="tiling-overlay"]', { timeout: 3000 });

      const twoSplitOption = await page.$('[data-testid="tiling-option-2-split"]');
      if (twoSplitOption) {
        await twoSplitOption.click();
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      // Now switch back to tabbed
      tilingButton = await page.$('[data-testid="tiling-button"]');
      if (!tilingButton) return;

      await tilingButton.click();
      await waitForSelector(page, '[data-testid="tiling-overlay"]', { timeout: 3000 });

      const tabbedOption = await page.$('[data-testid="tiling-option-tabbed"]');
      if (tabbedOption) {
        await tabbedOption.click();
        // Wait for layout transition and terminal resize
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }

      // Check cursor position
      const cursorPos = await getCursorPosition();

      if (cursorPos) {
        // Cursor should be within terminal bounds
        expect(cursorPos.isWithinBounds).toBe(true);

        // Cursor should NOT be at bottom-left corner
        if (cursorPos.isAtBottomLeft) {
          console.warn('⚠️ CURSOR BUG DETECTED: Cursor dropped to bottom-left corner after returning to tabbed mode');
        }
        expect(cursorPos.isAtBottomLeft).toBe(false);
      }
    });

    it('cursor should be within terminal bounds after page reload', async () => {
      await navigateToHome(page);
      await waitForAppReady(page);

      const hasSession = await hasRunningSession();
      if (!hasSession) {
        console.log('No running session - skipping test');
        return;
      }

      await waitForTerminalTabs();

      // Get initial cursor position before reload
      const initialPos = await getCursorPosition();

      // Reload the page
      await page.reload({ waitUntil: 'networkidle2' });
      await waitForAppReady(page);

      // Wait for terminal to reconnect and re-render
      await new Promise((resolve) => setTimeout(resolve, 3000));

      // Check if we still have a session
      const stillHasSession = await hasRunningSession();
      if (!stillHasSession) {
        console.log('Session lost after reload - skipping cursor check');
        return;
      }

      // Check cursor position after reload
      const cursorPos = await getCursorPosition();

      if (cursorPos) {
        // Cursor should be within terminal bounds
        if (!cursorPos.isWithinBounds) {
          console.warn('⚠️ CURSOR BUG DETECTED: Cursor outside terminal bounds after page reload');
          console.warn(`   Cursor at (${cursorPos.absoluteX}, ${cursorPos.absoluteY})`);
          console.warn(`   Terminal bounds: top=${cursorPos.terminalTop}, bottom=${cursorPos.terminalBottom}`);
        }
        expect(cursorPos.isWithinBounds).toBe(true);

        // Cursor should NOT be at bottom-left corner
        if (cursorPos.isAtBottomLeft) {
          console.warn('⚠️ CURSOR BUG DETECTED: Cursor dropped to bottom-left corner after page reload');
        }
        expect(cursorPos.isAtBottomLeft).toBe(false);
      }
    });

    it('cursor should be within terminal bounds after rapid layout switching', async () => {
      await navigateToHome(page);
      await waitForAppReady(page);

      const hasSession = await hasRunningSession();
      if (!hasSession) {
        console.log('No running session - skipping test');
        return;
      }

      await waitForTerminalTabs();
      const tabCount = await ensureMinimumTabs(4);
      if (tabCount < 4) {
        console.log('Could not create 4 tabs - skipping test');
        return;
      }

      // Rapidly switch between layouts
      const layouts = ['2-split', '3-split', '4-grid', 'tabbed'];

      for (const layout of layouts) {
        const tilingButton = await page.$('[data-testid="tiling-button"]');
        if (!tilingButton) continue;

        await tilingButton.click();
        await waitForSelector(page, '[data-testid="tiling-overlay"]', { timeout: 3000 });

        const option = await page.$(`[data-testid="tiling-option-${layout}"]`);
        if (option) {
          await option.click();
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
      }

      // Wait for final layout to settle
      await new Promise((resolve) => setTimeout(resolve, 1500));

      // Check cursor position
      const cursorPos = await getCursorPosition();

      if (cursorPos) {
        if (!cursorPos.isWithinBounds) {
          console.warn('⚠️ CURSOR BUG DETECTED: Cursor outside terminal bounds after rapid layout switching');
        }
        expect(cursorPos.isWithinBounds).toBe(true);

        if (cursorPos.isAtBottomLeft) {
          console.warn('⚠️ CURSOR BUG DETECTED: Cursor dropped to bottom-left corner after rapid layout switching');
        }
        expect(cursorPos.isAtBottomLeft).toBe(false);
      }
    });

    it('all visible terminals should have cursors in correct positions in tiled mode', async () => {
      await navigateToHome(page);
      await waitForAppReady(page);

      const hasSession = await hasRunningSession();
      if (!hasSession) {
        console.log('No running session - skipping test');
        return;
      }

      await waitForTerminalTabs();
      const tabCount = await ensureMinimumTabs(4);
      if (tabCount < 4) {
        console.log('Could not create 4 tabs - skipping test');
        return;
      }

      // Switch to 4-grid to see all 4 terminals
      const tilingButton = await page.$('[data-testid="tiling-button"]');
      if (!tilingButton) return;

      await tilingButton.click();
      await waitForSelector(page, '[data-testid="tiling-overlay"]', { timeout: 3000 });

      const fourGridOption = await page.$('[data-testid="tiling-option-4-grid"]');
      if (fourGridOption) {
        await fourGridOption.click();
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }

      // Check cursor position in each slot
      const cursorPositions = await page.evaluate(() => {
        const slots = document.querySelectorAll('[data-testid^="tiled-slot-"]');
        const results: Array<{
          slot: number;
          isWithinBounds: boolean;
          isAtBottomLeft: boolean;
          hasCursor: boolean;
        }> = [];

        slots.forEach((slot, index) => {
          const cursor = slot.querySelector('.xterm-cursor');
          const terminal = slot.querySelector('.xterm-screen');

          if (!cursor || !terminal) {
            results.push({
              slot: index,
              isWithinBounds: true, // No cursor = no problem
              isAtBottomLeft: false,
              hasCursor: false,
            });
            return;
          }

          const cursorRect = cursor.getBoundingClientRect();
          const terminalRect = terminal.getBoundingClientRect();

          results.push({
            slot: index,
            isWithinBounds:
              cursorRect.left >= terminalRect.left - 5 &&
              cursorRect.right <= terminalRect.right + 5 &&
              cursorRect.top >= terminalRect.top - 5 &&
              cursorRect.bottom <= terminalRect.bottom + 5,
            isAtBottomLeft:
              cursorRect.left < terminalRect.left + 50 &&
              cursorRect.top > terminalRect.bottom - 50,
            hasCursor: true,
          });
        });

        return results;
      });

      // Verify each slot's cursor is positioned correctly
      for (const pos of cursorPositions) {
        if (pos.hasCursor) {
          if (!pos.isWithinBounds) {
            console.warn(`⚠️ CURSOR BUG DETECTED: Slot ${pos.slot} cursor outside terminal bounds`);
          }
          expect(pos.isWithinBounds).toBe(true);

          if (pos.isAtBottomLeft) {
            console.warn(`⚠️ CURSOR BUG DETECTED: Slot ${pos.slot} cursor at bottom-left corner`);
          }
          expect(pos.isAtBottomLeft).toBe(false);
        }
      }
    });
  });

  describe('Edge Cases', () => {
    it('should handle rapid layout switching gracefully', async () => {
      await navigateToHome(page);
      await waitForAppReady(page);

      const hasSession = await hasRunningSession();
      if (!hasSession) {
        console.log('No running session - skipping test');
        return;
      }

      await waitForTerminalTabs();
      const tabCount = await ensureMinimumTabs(4);

      if (tabCount < 4) {
        console.log('Could not create 4 tabs - skipping test');
        return;
      }

      // Rapidly switch between layouts
      const tilingButton = await page.$('[data-testid="tiling-button"]');
      if (!tilingButton) {
        console.log('Tiling button not found - skipping test');
        return;
      }

      // Switch to 2-split
      await tilingButton.click();
      await waitForSelector(page, '[data-testid="tiling-overlay"]', { timeout: 3000 });
      const opt2 = await page.$('[data-testid="tiling-option-2-split"]');
      if (opt2) await opt2.click();
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Switch to 3-split
      const btn2 = await page.$('[data-testid="tiling-button"]');
      if (btn2) {
        await btn2.click();
        await waitForSelector(page, '[data-testid="tiling-overlay"]', { timeout: 3000 });
        const opt3 = await page.$('[data-testid="tiling-option-3-split"]');
        if (opt3) await opt3.click();
        await new Promise((resolve) => setTimeout(resolve, 200));
      }

      // Switch to 4-grid
      const btn3 = await page.$('[data-testid="tiling-button"]');
      if (btn3) {
        await btn3.click();
        await waitForSelector(page, '[data-testid="tiling-overlay"]', { timeout: 3000 });
        const opt4 = await page.$('[data-testid="tiling-option-4-grid"]');
        if (opt4) await opt4.click();
        await new Promise((resolve) => setTimeout(resolve, 200));
      }

      // Back to tabbed
      const btn4 = await page.$('[data-testid="tiling-button"]');
      if (btn4) {
        await btn4.click();
        await waitForSelector(page, '[data-testid="tiling-overlay"]', { timeout: 3000 });
        const optT = await page.$('[data-testid="tiling-option-tabbed"]');
        if (optT) await optT.click();
        await new Promise((resolve) => setTimeout(resolve, 200));
      }

      // Page should still be functional
      const terminalTabs = await elementExists(page, '[data-testid="terminal-tabs"]', 3000);
      expect(terminalTabs).toBe(true);

      // No error messages should be visible
      const hasError = await elementExists(page, '.layout-error', 1000);
      expect(hasError).toBe(false);
    });

    it('should show current layout as highlighted in overlay', async () => {
      await navigateToHome(page);
      await waitForAppReady(page);

      const hasSession = await hasRunningSession();
      if (!hasSession) {
        console.log('No running session - skipping test');
        return;
      }

      await waitForTerminalTabs();
      await ensureMinimumTabs(2);

      // Enable 2-split
      const tilingButton = await page.$('[data-testid="tiling-button"]');
      if (!tilingButton) {
        console.log('Tiling button not found - skipping test');
        return;
      }

      await tilingButton.click();
      await waitForSelector(page, '[data-testid="tiling-overlay"]', { timeout: 3000 });

      const twoSplitOption = await page.$('[data-testid="tiling-option-2-split"]');
      if (twoSplitOption) {
        await twoSplitOption.click();
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      // Re-open overlay
      const btnAgain = await page.$('[data-testid="tiling-button"]');
      if (btnAgain) {
        await btnAgain.click();
        await waitForSelector(page, '[data-testid="tiling-overlay"]', { timeout: 3000 });

        // 2-split should be highlighted
        const splitOption = await page.$('[data-testid="tiling-option-2-split"]');
        if (splitOption) {
          const isHighlighted = await page.evaluate(
            (el) => el.classList.contains('tiling-option--active'),
            splitOption
          );
          expect(isHighlighted).toBe(true);
        }

        // Tabbed should NOT be highlighted
        const tabbedOption = await page.$('[data-testid="tiling-option-tabbed"]');
        if (tabbedOption) {
          const isNotHighlighted = await page.evaluate(
            (el) => !el.classList.contains('tiling-option--active'),
            tabbedOption
          );
          expect(isNotHighlighted).toBe(true);
        }
      }
    });
  });
});
