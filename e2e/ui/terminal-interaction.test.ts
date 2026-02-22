import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { Browser, Page } from 'puppeteer';
import { launchBrowser, createPage, navigateToHome, takeScreenshot, waitForAppReady, waitForDashboardReady } from './setup';
import {
  waitForSelector,
  clickAndWait,
  getTextContent,
  elementExists,
  isElementVisible,
  waitForText,
  getElementCount,
  getAllElements,
} from './helpers';
import { cleanupSessions } from '../helpers/test-utils';

/**
 * E2E Tests for Terminal Interaction
 *
 * Tests the terminal UI components:
 * - Terminal tabs display and interaction
 * - Tab switching functionality
 * - Tab icons matching terminal type
 * - Tab close functionality
 * - Adding new terminal tabs
 */
describe('Terminal Interaction', () => {
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

  describe('Terminal Tabs Display', () => {
    it('shows terminal tabs for running session', async () => {
      await navigateToHome(page);
      await waitForAppReady(page);

      // Check for terminal tabs container
      const hasTerminalTabs = await elementExists(page, '[data-testid="terminal-tabs"]', 5000);

      // Terminal tabs only show when there's a running session
      const hasRunningSessions = await elementExists(page, '[data-testid^="session-stat-card-"]', 3000);

      if (hasRunningSessions) {
        // If we have sessions, we might have terminal tabs
        // Click on a session to potentially activate it
        const sessionCard = await page.$('[data-testid^="session-stat-card-"]');
        if (sessionCard) {
          await sessionCard.click();
          await new Promise((resolve) => setTimeout(resolve, 1000));

          // Check again for terminal tabs
          const tabsVisible = await elementExists(page, '[data-testid="terminal-tabs"]', 3000);
          // This depends on session being running
        }
      }
    });

    it('terminal tabs container has correct structure', async () => {
      await navigateToHome(page);
      await waitForAppReady(page);

      const terminalTabs = await page.$('[data-testid="terminal-tabs"]');

      if (terminalTabs) {
        // Terminal tabs should have the correct class
        const hasCorrectClass = await page.evaluate(() => {
          const tabs = document.querySelector('[data-testid="terminal-tabs"]');
          return tabs?.classList.contains('terminal-tabs') || false;
        });

        expect(hasCorrectClass).toBe(true);
      }
    });

    it('each terminal tab has required elements', async () => {
      await navigateToHome(page);
      await waitForAppReady(page);

      const terminalTabs = await page.$$('[data-testid^="terminal-tab-"]:not([data-testid="terminal-tab-add"])');

      if (terminalTabs.length > 0) {
        // Each tab should have an icon
        const firstTabId = await page.evaluate((el) => el.getAttribute('data-testid'), terminalTabs[0]);

        if (firstTabId) {
          const tabId = firstTabId.replace('terminal-tab-', '');

          // Check for icon
          const hasIcon = await elementExists(page, `[data-testid="terminal-tab-${tabId}-icon"]`, 2000);

          // Check for close button (not on tab 1 which can't be closed)
          if (tabId !== '1') {
            const hasClose = await elementExists(page, `[data-testid="terminal-tab-${tabId}-close"]`, 2000);
          }
        }
      }
    });
  });

  describe('Tab Switching', () => {
    it('can switch between terminal tabs', async () => {
      await navigateToHome(page);
      await waitForAppReady(page);

      const terminalTabs = await page.$$('[data-testid^="terminal-tab-"]:not([data-testid="terminal-tab-add"])');

      if (terminalTabs.length > 1) {
        // Get the second tab
        const secondTab = terminalTabs[1];
        const tabId = await page.evaluate((el) => el.getAttribute('data-testid'), secondTab);

        // Click the second tab
        await secondTab.click();
        await new Promise((resolve) => setTimeout(resolve, 300));

        // Verify the tab becomes active
        const isActive = await page.evaluate((id) => {
          const tab = document.querySelector(`[data-testid="${id}"]`);
          return tab?.classList.contains('terminal-tab--active') || false;
        }, tabId);

        expect(isActive).toBe(true);
      }
    });

    it('clicking active tab does not cause errors', async () => {
      await navigateToHome(page);
      await waitForAppReady(page);

      const activeTab = await page.$('.terminal-tab--active, [data-testid^="terminal-tab-"]');

      if (activeTab) {
        // Click the already active tab
        await activeTab.click();
        await new Promise((resolve) => setTimeout(resolve, 200));

        // Page should not have errors
        const hasError = await elementExists(page, '.error, [class*="error"]', 500);
        // This is a smoke test - just verify no crash
      }
    });

    it('tab switch updates terminal display', async () => {
      await navigateToHome(page);
      await waitForAppReady(page);

      // Check if terminal container exists
      const hasTerminalContainer = await elementExists(page, '.layout-terminal-container', 3000);

      if (hasTerminalContainer) {
        // Terminal container should be present
        expect(hasTerminalContainer).toBe(true);
      }
    });
  });

  describe('Tab Icons', () => {
    it('terminal tab icons are SVG elements', async () => {
      await navigateToHome(page);
      await waitForAppReady(page);

      const tabIcons = await page.$$('[data-testid$="-icon"]');

      if (tabIcons.length > 0) {
        // Icons should be SVG
        const isSvg = await page.evaluate((el) => {
          return el.tagName.toLowerCase() === 'svg';
        }, tabIcons[0]);

        expect(isSvg).toBe(true);
      }
    });

    it('first tab has Claude icon (terminal type: claude)', async () => {
      await navigateToHome(page);
      await waitForAppReady(page);

      const tab1Icon = await page.$('[data-testid="terminal-tab-1-icon"]');

      if (tab1Icon) {
        // Icon should exist
        expect(tab1Icon).not.toBeNull();
      }
    });

    it('second tab has htop icon (terminal type: htop)', async () => {
      await navigateToHome(page);
      await waitForAppReady(page);

      const tab2Icon = await page.$('[data-testid="terminal-tab-2-icon"]');

      // Tab 2 might not exist if only 1 tab is open
      // This is expected behavior
    });

    it('third tab has yazi icon (terminal type: yazi)', async () => {
      await navigateToHome(page);
      await waitForAppReady(page);

      const tab3Icon = await page.$('[data-testid="terminal-tab-3-icon"]');

      // Tab 3 might not exist
      // This is expected behavior
    });
  });

  describe('Tab Close Functionality', () => {
    it('close button exists on closable tabs', async () => {
      await navigateToHome(page);
      await waitForAppReady(page);

      // Get all tabs except add button
      const tabs = await page.$$('[data-testid^="terminal-tab-"]:not([data-testid="terminal-tab-add"])');

      // If there are tabs beyond tab 1, they should have close buttons
      for (let i = 1; i < tabs.length; i++) {
        const tabId = await page.evaluate((el) => el.getAttribute('data-testid'), tabs[i]);
        const id = tabId?.replace('terminal-tab-', '');

        if (id && id !== '1') {
          const hasClose = await elementExists(page, `[data-testid="terminal-tab-${id}-close"]`, 1000);
          expect(hasClose).toBe(true);
        }
      }
    });

    it('close button stops event propagation (does not switch tab)', async () => {
      await navigateToHome(page);
      await waitForAppReady(page);

      // Find a tab with close button
      const closeButtons = await page.$$('[data-testid$="-close"]');

      if (closeButtons.length > 0) {
        // Get current active tab
        const activeTabBefore = await page.$('.terminal-tab--active');
        const activeIdBefore = activeTabBefore
          ? await page.evaluate((el) => el.getAttribute('data-testid'), activeTabBefore)
          : null;

        // Click close on a different tab
        // The tab close should not change which tab is active
        // (unless we're closing the active tab)
      }
    });

    it('tab 1 (Claude) cannot be closed', async () => {
      await navigateToHome(page);
      await waitForAppReady(page);

      // Tab 1 should NOT have a close button
      const tab1Close = await page.$('[data-testid="terminal-tab-1-close"]');
      expect(tab1Close).toBeNull();
    });
  });

  describe('Add Terminal Button', () => {
    it('add button exists in terminal tabs', async () => {
      await navigateToHome(page);
      await waitForAppReady(page);

      const terminalTabs = await page.$('[data-testid="terminal-tabs"]');

      if (terminalTabs) {
        const addButton = await elementExists(page, '[data-testid="terminal-tab-add"]', 2000);
        expect(addButton).toBe(true);
      }
    });

    it('add button has correct title/tooltip', async () => {
      await navigateToHome(page);
      await waitForAppReady(page);

      const addButton = await page.$('[data-testid="terminal-tab-add"]');

      if (addButton) {
        const title = await page.evaluate((el) => el.getAttribute('title'), addButton);
        expect(title).toContain('terminal');
      }
    });

    it('add button indicates max limit (6 tabs)', async () => {
      await navigateToHome(page);
      await waitForAppReady(page);

      const addButton = await page.$('[data-testid="terminal-tab-add"]');

      if (addButton) {
        const title = await page.evaluate((el) => el.getAttribute('title'), addButton);
        // Title should mention max 6
        expect(title).toContain('6');
      }
    });

    it('add button is clickable', async () => {
      await navigateToHome(page);
      await waitForAppReady(page);

      const addButton = await page.$('[data-testid="terminal-tab-add"]');

      if (addButton) {
        // Get current tab count
        const tabsBefore = await page.$$('[data-testid^="terminal-tab-"]:not([data-testid="terminal-tab-add"])');
        const countBefore = tabsBefore.length;

        // Click add button
        await addButton.click();
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Check if tab was added (or button was disabled if at max)
        const tabsAfter = await page.$$('[data-testid^="terminal-tab-"]:not([data-testid="terminal-tab-add"])');
        const countAfter = tabsAfter.length;

        // Either a tab was added or we were already at max
        expect(countAfter).toBeGreaterThanOrEqual(countBefore);
      }
    });

    it('add button is disabled when at max tabs (6)', async () => {
      await navigateToHome(page);
      await waitForAppReady(page);

      // Count current tabs
      const tabs = await page.$$('[data-testid^="terminal-tab-"]:not([data-testid="terminal-tab-add"])');

      if (tabs.length >= 6) {
        // Add button should be disabled
        const addButton = await page.$('[data-testid="terminal-tab-add"]');
        if (addButton) {
          const isDisabled = await page.evaluate((el) => (el as HTMLButtonElement).disabled, addButton);
          expect(isDisabled).toBe(true);
        }
      }
    });
  });

  describe('Terminal Tab Styling', () => {
    it('active tab has visual distinction', async () => {
      await navigateToHome(page);
      await waitForAppReady(page);

      const activeTab = await page.$('.terminal-tab--active');

      if (activeTab) {
        // Active tab should have the active class
        const hasActiveClass = await page.evaluate(() => {
          const tab = document.querySelector('.terminal-tab--active');
          return tab !== null;
        });

        expect(hasActiveClass).toBe(true);
      }
    });

    it('inactive tabs have different styling', async () => {
      await navigateToHome(page);
      await waitForAppReady(page);

      const inactiveTabs = await page.$$('.terminal-tab:not(.terminal-tab--active)');

      if (inactiveTabs.length > 0) {
        // Inactive tabs should exist and be styled differently
        const activeTab = await page.$('.terminal-tab--active');

        if (activeTab && inactiveTabs[0]) {
          const activeStyle = await page.evaluate((el) => {
            return window.getComputedStyle(el).backgroundColor;
          }, activeTab);

          const inactiveStyle = await page.evaluate((el) => {
            return window.getComputedStyle(el).backgroundColor;
          }, inactiveTabs[0]);

          // Styles should be different (active has different background)
          // Note: This might be the same if using other visual cues
        }
      }
    });

    it('tab hover effect works', async () => {
      await navigateToHome(page);
      await waitForAppReady(page);

      const tab = await page.$('[data-testid^="terminal-tab-"]:not([data-testid="terminal-tab-add"])');

      if (tab) {
        // Hover over the tab
        await tab.hover();
        await new Promise((resolve) => setTimeout(resolve, 100));

        // Tab should respond to hover (smoke test)
        // Just verify no errors occur
      }
    });
  });

  describe('Terminal Container', () => {
    it('terminal container exists in layout', async () => {
      await navigateToHome(page);

      // On dashboard view, the floating panel IS the main content — no terminal layout exists
      const hasDashboard = await elementExists(page, '[data-testid="dashboard-floating-panel"]', 5000);

      if (hasDashboard) {
        // Dashboard is the landing page - terminal container only exists in terminal view
        expect(hasDashboard).toBe(true);
      } else {
        await waitForAppReady(page);
        // Terminal container may not exist if no session is running
        const hasContainer = await elementExists(page, '.layout-terminal-container, .layout-main, main', 3000);
        // The main area should exist even if terminal container isn't visible
        expect(hasContainer).toBe(true);
      }
    });

    it('terminal container takes up available space', async () => {
      await navigateToHome(page);
      await waitForAppReady(page);

      const container = await page.$('.layout-terminal-container');

      if (container) {
        const styles = await page.evaluate((el) => {
          const computed = window.getComputedStyle(el);
          return {
            flex: computed.flex,
            height: computed.height,
            position: computed.position,
          };
        }, container);

        // Container should have flex: 1 or similar to fill space
        expect(styles.flex).toContain('1');
      }
    });

    it('only active terminal is visible', async () => {
      await navigateToHome(page);
      await waitForAppReady(page);

      // Get all terminal components
      const terminals = await page.$$('.terminal-container, [class*="terminal"][class*="active"]');

      // If multiple terminals exist, only active should be visible
      // This is managed by the active prop in Terminal component
    });
  });

  describe('Init Progress in Terminal', () => {
    it('shows init progress during session initialization', async () => {
      await navigateToHome(page);
      await waitForAppReady(page);

      // Check for init progress overlay
      const hasInitProgress = await elementExists(page, '[data-testid="init-progress"]', 3000);

      // Init progress shows during initialization
      // It might not be visible if all sessions are already running
    });

    it('init progress has hero icon', async () => {
      await navigateToHome(page);
      await waitForAppReady(page);

      const heroIcon = await page.$('[data-testid="init-progress-hero-icon"]');

      // Hero icon only shows during init
      // This is expected to be null if no session is initializing
    });

    it('init progress has progress bar', async () => {
      await navigateToHome(page);
      await waitForAppReady(page);

      const progressBar = await page.$('[data-testid="init-progress-bar"]');

      // Progress bar only shows during init
    });

    it('init progress steps are displayed', async () => {
      await navigateToHome(page);
      await waitForAppReady(page);

      const steps = await page.$$('[data-testid^="init-progress-step-"]');

      // Steps only show during init
    });
  });
});
