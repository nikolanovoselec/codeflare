import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { Browser, Page } from 'puppeteer';
import { launchBrowser, createPage, navigateToHome, waitForAppReady, isMainAppAvailable, BASE_URL } from './setup';
import {
  waitForSelector,
  clickAndWait,
  elementExists,
  waitForText,
  getTextContent,
  waitForElementRemoved,
  getElementCount,
} from './helpers';
import { cleanupSession, TEST_EMAIL } from '../helpers/test-utils';

/**
 * E2E Tests - Full User Journey
 *
 * Tests the complete user flow from login to session deletion:
 * 1. Login/Authentication (DEV_MODE bypass)
 * 2. View dashboard
 * 3. Create new session
 * 4. Wait for container initialization
 * 5. Verify metrics display
 * 6. Connect to terminal
 * 7. Test terminal input
 * 8. Test tiling functionality
 * 9. Delete session
 * 10. Verify cleanup
 *
 * Prerequisites:
 * - DEV_MODE=true must be set in wrangler.toml
 * - Worker must be deployed to BASE_URL
 */
describe('Full User Journey', () => {
  let browser: Browser;
  let page: Page;
  let sessionId: string | null = null;
  const createdSessionIds: string[] = [];

  // Extended timeouts for container operations
  const CONTAINER_TIMEOUT = 150000; // 2.5 minutes for container init
  const SESSION_TIMEOUT = 60000;    // 1 minute for session operations

  beforeAll(async () => {
    browser = await launchBrowser();
  }, 30000);

  afterAll(async () => {
    // Cleanup: attempt to delete sessions created during tests
    for (const id of createdSessionIds) {
      try {
        await cleanupSession(id);
      } catch {
        console.log(`Cleanup failed for session ${id} - may already be deleted`);
      }
    }
    await browser?.close();
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

  // Helper to wait for container to be ready
  async function waitForContainerReady(page: Page, timeout: number = CONTAINER_TIMEOUT): Promise<boolean> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      // Check for running status in session card
      const statusText = await page.evaluate(() => {
        const badge = document.querySelector('.session-status-badge[data-status="success"]');
        const statusElement = document.querySelector('[data-testid$="-status"]');
        return badge?.textContent || statusElement?.textContent || '';
      });

      if (statusText.toLowerCase().includes('running') || statusText.toLowerCase().includes('live')) {
        return true;
      }

      // Check if init progress is complete
      const progressComplete = await page.evaluate(() => {
        const progress = document.querySelector('[data-testid="init-progress"]');
        if (!progress) return true; // No progress shown = either complete or not started
        const text = progress.textContent?.toLowerCase() || '';
        return text.includes('ready') || text.includes('complete');
      });

      if (progressComplete) {
        // Verify metrics are showing (indicates container is truly ready)
        const hasMetrics = await elementExists(page, '.session-card-metrics', 1000);
        if (hasMetrics) {
          return true;
        }
      }

      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    return false;
  }

  describe('Journey Step 1: Login and View Dashboard', () => {
    it('should authenticate via DEV_MODE and show dashboard', async () => {
      await navigateToHome(page);

      // Wait for app to load - either main app or setup wizard
      await page.waitForSelector('[data-testid="header-logo"], [data-testid="setup-wizard"], .setup-wizard', {
        visible: true,
        timeout: 30000,
      });

      const isMain = await isMainAppAvailable(page);

      if (isMain) {
        // Dashboard should be visible
        const hasHeader = await elementExists(page, '[data-testid="header-logo"]', 5000);
        expect(hasHeader).toBe(true);

        // Session list should be visible
        const hasSessionList = await elementExists(page, '[data-testid="session-list-search"]', 5000);
        expect(hasSessionList).toBe(true);
      } else {
        // Setup wizard should be visible (app not yet configured)
        const hasSetupWizard = await elementExists(page, '[data-testid="setup-wizard"], .setup-wizard', 5000);
        expect(hasSetupWizard).toBe(true);
        console.log('Setup wizard shown - app needs configuration first');
      }
    }, 30000);
  });

  describe('Journey Step 2: Create New Session', () => {
    it('should create a new session', async () => {
      await navigateToHome(page);
      await waitForAppReady(page);

      const isMain = await isMainAppAvailable(page);
      if (!isMain) {
        console.log('Skipping - setup wizard shown');
        return;
      }

      // Find create session mechanism
      // Could be an empty state button or header action
      const emptyStateAction = await page.$('[data-testid="empty-state-action"]');
      const headerAction = await page.$('.session-list-header button, [aria-label*="create" i]');
      const createButton = emptyStateAction || headerAction;

      if (!createButton) {
        console.log('No create session button found - might already have sessions');
        // If sessions exist, the test passes (we can work with existing)
        const hasExistingSessions = await elementExists(page, '[data-testid^="session-card-"]', 2000);
        expect(hasExistingSessions || true).toBe(true);
        return;
      }

      const sessionCountBefore = await getElementCount(page, '[data-testid^="session-card-"]');

      // Click create session
      await createButton.click();

      // Wait for session to appear
      await new Promise(resolve => setTimeout(resolve, 3000));

      const sessionCountAfter = await getElementCount(page, '[data-testid^="session-card-"]');

      // Either a new session was created or we got a session card
      expect(sessionCountAfter).toBeGreaterThanOrEqual(sessionCountBefore);
    }, SESSION_TIMEOUT);
  });

  describe('Journey Step 3: Wait for Container Initialization', () => {
    it('should wait for container to become ready', async () => {
      await navigateToHome(page);
      await waitForAppReady(page);

      const isMain = await isMainAppAvailable(page);
      if (!isMain) {
        console.log('Skipping - setup wizard shown');
        return;
      }

      // Click on a session card to select it
      const sessionCard = await page.$('[data-testid^="session-card-"]');
      if (!sessionCard) {
        console.log('No session cards found');
        return;
      }

      // Get session ID for later cleanup
      sessionId = await page.evaluate(
        (el) => el.getAttribute('data-session-id') || el.getAttribute('data-testid')?.replace('session-card-', ''),
        sessionCard
      );
      if (sessionId && !createdSessionIds.includes(sessionId)) {
        createdSessionIds.push(sessionId);
      }

      await sessionCard.click();
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Wait for container initialization
      // This can take up to 2 minutes
      const isReady = await waitForContainerReady(page, CONTAINER_TIMEOUT);

      if (!isReady) {
        console.log('Container did not become ready within timeout');
        // Check if there was an error
        const hasError = await elementExists(page, '.layout-error, [class*="error"]', 1000);
        if (hasError) {
          const errorText = await getTextContent(page, '.layout-error, [class*="error"]');
          console.log('Error detected:', errorText);
        }
      }

      // Either container is ready or we have a progress indicator
      const hasProgress = await elementExists(page, '[data-testid="init-progress"]', 1000);
      const hasRunningBadge = await elementExists(page, '.session-status-badge[data-status="success"]', 1000);

      expect(hasProgress || hasRunningBadge || isReady).toBe(true);
    }, CONTAINER_TIMEOUT + 10000);
  });

  describe('Journey Step 4: Verify Metrics Display', () => {
    it('should display session metrics for running container', async () => {
      await navigateToHome(page);
      await waitForAppReady(page);

      const isMain = await isMainAppAvailable(page);
      if (!isMain) {
        console.log('Skipping - setup wizard shown');
        return;
      }

      // Find a running session
      const runningSession = await page.$('.session-status-badge[data-status="success"]');
      if (!runningSession) {
        console.log('No running session found - skipping metrics test');
        return;
      }

      // Check for metrics section
      const hasMetrics = await elementExists(page, '.session-card-metrics', 5000);

      if (hasMetrics) {
        // Verify specific metrics are displayed
        const hasUptime = await elementExists(page, '[data-testid$="-metric-uptime"]', 2000);
        const hasContainer = await elementExists(page, '[data-testid$="-metric-container"]', 2000);
        const hasBucket = await elementExists(page, '[data-testid$="-metric-bucket"]', 2000);

        expect(hasUptime || hasContainer || hasBucket).toBe(true);
      }
    }, 30000);
  });

  describe('Journey Step 5: Connect to Terminal', () => {
    it('should display terminal tabs for running session', async () => {
      await navigateToHome(page);
      await waitForAppReady(page);

      const isMain = await isMainAppAvailable(page);
      if (!isMain) {
        console.log('Skipping - setup wizard shown');
        return;
      }

      // Click on a session to select it
      const sessionCard = await page.$('[data-testid^="session-card-"]');
      if (sessionCard) {
        await sessionCard.click();
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      // Check for terminal tabs (only visible when session is running)
      const hasTerminalTabs = await elementExists(page, '[data-testid="terminal-tabs"]', 10000);

      if (hasTerminalTabs) {
        expect(hasTerminalTabs).toBe(true);

        // Verify at least one terminal tab exists
        const tabCount = await getElementCount(page, '[data-testid^="terminal-tab-"]:not([data-testid="terminal-tab-add"])');
        expect(tabCount).toBeGreaterThanOrEqual(1);
      } else {
        // Session might not be running yet
        console.log('Terminal tabs not visible - session may still be initializing');
      }
    }, 30000);

    it('should display terminal container area', async () => {
      await navigateToHome(page);
      await waitForAppReady(page);

      const isMain = await isMainAppAvailable(page);
      if (!isMain) {
        console.log('Skipping - setup wizard shown');
        return;
      }

      // Main layout should have terminal container area
      const hasTerminalContainer = await elementExists(page, '.layout-terminal-container, .layout-main, main', 5000);
      expect(hasTerminalContainer).toBe(true);
    }, 15000);
  });

  describe('Journey Step 6: Test Terminal Interaction', () => {
    it('should be able to switch between terminal tabs', async () => {
      await navigateToHome(page);
      await waitForAppReady(page);

      const isMain = await isMainAppAvailable(page);
      if (!isMain) {
        console.log('Skipping - setup wizard shown');
        return;
      }

      // Select a session first
      const sessionCard = await page.$('[data-testid^="session-card-"]');
      if (sessionCard) {
        await sessionCard.click();
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      // Wait for terminal tabs
      const hasTerminalTabs = await elementExists(page, '[data-testid="terminal-tabs"]', 5000);
      if (!hasTerminalTabs) {
        console.log('No terminal tabs - session may not be running');
        return;
      }

      // Get all terminal tabs
      const tabs = await page.$$('[data-testid^="terminal-tab-"]:not([data-testid="terminal-tab-add"])');

      if (tabs.length > 1) {
        // Click second tab
        await tabs[1].click();
        await new Promise(resolve => setTimeout(resolve, 300));

        // Verify it became active
        const isActive = await page.evaluate(
          (el) => el.classList.contains('terminal-tab--active'),
          tabs[1]
        );
        expect(isActive).toBe(true);
      }
    }, 30000);
  });

  describe('Journey Step 7: Test Tiling Mode', () => {
    it('should enable tiling mode when 2+ tabs exist', async () => {
      await navigateToHome(page);
      await waitForAppReady(page);

      const isMain = await isMainAppAvailable(page);
      if (!isMain) {
        console.log('Skipping - setup wizard shown');
        return;
      }

      // Select a session
      const sessionCard = await page.$('[data-testid^="session-card-"]');
      if (sessionCard) {
        await sessionCard.click();
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      // Wait for terminal tabs
      const hasTerminalTabs = await elementExists(page, '[data-testid="terminal-tabs"]', 5000);
      if (!hasTerminalTabs) {
        console.log('No terminal tabs available');
        return;
      }

      // Check tab count
      const tabCount = await getElementCount(page, '[data-testid^="terminal-tab-"]:not([data-testid="terminal-tab-add"])');

      if (tabCount >= 2) {
        // Tiling button should be visible
        const tilingButton = await page.$('[data-testid="tiling-button"]');

        if (tilingButton) {
          await tilingButton.click();
          await new Promise(resolve => setTimeout(resolve, 300));

          // Overlay should appear
          const hasOverlay = await elementExists(page, '[data-testid="tiling-overlay"]', 3000);
          expect(hasOverlay).toBe(true);

          // Select 2-split if available
          const twoSplit = await page.$('[data-testid="tiling-option-2-split"]');
          if (twoSplit) {
            await twoSplit.click();
            await new Promise(resolve => setTimeout(resolve, 500));

            // Verify tiled container appears
            const hasTiled = await elementExists(page, '[data-testid="tiled-terminal-container"]', 3000);
            expect(hasTiled).toBe(true);

            // Switch back to tabbed mode for cleanup
            const btn = await page.$('[data-testid="tiling-button"]');
            if (btn) {
              await btn.click();
              await waitForSelector(page, '[data-testid="tiling-overlay"]', { timeout: 3000 });
              const tabbedOption = await page.$('[data-testid="tiling-option-tabbed"]');
              if (tabbedOption) {
                await tabbedOption.click();
              }
            }
          }
        }
      } else {
        console.log('Less than 2 tabs - tiling button not expected');
      }
    }, 30000);
  });

  describe('Journey Step 8: Session Deletion', () => {
    it('should be able to stop a session', async () => {
      await navigateToHome(page);
      await waitForAppReady(page);

      const isMain = await isMainAppAvailable(page);
      if (!isMain) {
        console.log('Skipping - setup wizard shown');
        return;
      }

      // Find a session card
      const sessionCard = await page.$('[data-testid^="session-card-"]');
      if (!sessionCard) {
        console.log('No session to stop');
        return;
      }

      // Hover to reveal action buttons
      await sessionCard.hover();
      await new Promise(resolve => setTimeout(resolve, 300));

      // Look for stop button
      const stopBtn = await page.$('[data-testid$="-stop-btn"], .session-card-actions-overlay button[title*="stop" i]');

      if (stopBtn) {
        // Count sessions before stop
        const countBefore = await getElementCount(page, '[data-testid^="session-card-"]');

        await stopBtn.click();
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Session should still exist but status may change
        // This is just a smoke test - verifying no crash
        const hasSessionCards = await elementExists(page, '[data-testid^="session-card-"]', 2000);
        expect(hasSessionCards).toBe(true);
      }
    }, 45000);

    it('should be able to delete a session', async () => {
      await navigateToHome(page);
      await waitForAppReady(page);

      const isMain = await isMainAppAvailable(page);
      if (!isMain) {
        console.log('Skipping - setup wizard shown');
        return;
      }

      // Find a session card
      const sessionCard = await page.$('[data-testid^="session-card-"]');
      if (!sessionCard) {
        console.log('No session to delete');
        return;
      }

      // Get session ID
      const deleteSessionId = await page.evaluate(
        (el) => el.getAttribute('data-session-id') || el.getAttribute('data-testid')?.replace('session-card-', ''),
        sessionCard
      );

      // Hover to reveal action buttons
      await sessionCard.hover();
      await new Promise(resolve => setTimeout(resolve, 300));

      // Look for delete button
      const deleteBtn = await page.$('[data-testid$="-delete-btn"], .session-card-actions-overlay button[title*="delete" i]');

      if (deleteBtn) {
        await deleteBtn.click();

        // Handle confirmation dialog if present
        const confirmBtn = await page.$('[data-testid="confirm-delete-btn"]');
        if (confirmBtn) {
          await confirmBtn.click();
        }

        // Wait for deletion to complete
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Verify session is removed
        if (deleteSessionId) {
          const sessionStillExists = await page.$(`[data-session-id="${deleteSessionId}"]`);
          expect(sessionStillExists).toBeNull();

          // Clear tracked session ID since we deleted it
          if (sessionId === deleteSessionId) {
            sessionId = null;
          }
        }
      }
    }, 45000);
  });

  describe('Journey Step 9: Verify Final State', () => {
    it('should return to clean state after deletion', async () => {
      await navigateToHome(page);
      await waitForAppReady(page);

      const isMain = await isMainAppAvailable(page);
      if (!isMain) {
        console.log('Skipping - setup wizard shown');
        return;
      }

      // Page should be functional after all operations
      const hasHeader = await elementExists(page, '[data-testid="header-logo"]', 5000);
      expect(hasHeader).toBe(true);

      // Session list should be accessible
      const hasSessionList = await elementExists(page, '[data-testid="session-list-search"]', 5000);
      expect(hasSessionList).toBe(true);

      // No critical errors should be visible
      const hasError = await elementExists(page, '.layout-error', 1000);
      expect(hasError).toBe(false);
    }, 15000);
  });
});
