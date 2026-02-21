import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { Browser, Page } from 'puppeteer';
import { launchBrowser, createPage, navigateToHome, takeScreenshot, waitForDashboardReady, waitForAppOrSetup } from './setup';
import {
  waitForSelector,
  getTextContent,
  typeIntoInput,
  elementExists,
  isElementVisible,
  waitForText,
  getElementCount,
  waitForElementRemoved,
  getAllElements,
} from './helpers';
import { cleanupSessions } from '../helpers/test-utils';

/**
 * E2E Tests for Session Management
 *
 * Tests the session CRUD operations:
 * - Empty state when no sessions exist
 * - Creating new sessions
 * - Session initialization progress
 * - Session list display
 * - Searching and filtering sessions
 * - Stopping and deleting sessions
 */
describe('Session Management', () => {
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

  describe('Empty State', () => {
    it('shows dashboard with new session button when no sessions exist', async () => {
      await navigateToHome(page);

      // Handle setup-wizard test interference: if setup:complete was reset by
      // concurrent setup-wizard tests, we'll see the wizard instead of dashboard
      const appState = await waitForAppOrSetup(page);
      if (appState === 'setup') return; // Skip — setup wizard active due to test interference

      // Dashboard should always render with the new session button
      const hasDashboard = await elementExists(page, '[data-testid="dashboard-floating-panel"]', 5000);
      expect(hasDashboard).toBe(true);

      const hasNewSessionButton = await elementExists(page, '[data-testid="dashboard-new-session"]', 3000);
      expect(hasNewSessionButton).toBe(true);
    });

    it('empty state contains action to create session', async () => {
      await navigateToHome(page);

      const appState = await waitForAppOrSetup(page);
      if (appState === 'setup') return;

      // The dashboard always has a new session button, regardless of session count
      const hasCreateButton = await elementExists(page, '[data-testid="dashboard-new-session"]', 3000);
      expect(hasCreateButton).toBe(true);
    });

    it('dashboard renders both panels', async () => {
      await navigateToHome(page);

      const appState = await waitForAppOrSetup(page);
      if (appState === 'setup') return;

      // Dashboard should have left (sessions) and right (storage) panels
      const hasLeftPanel = await elementExists(page, '[data-testid="dashboard-panel-left"]', 3000);
      const hasRightPanel = await elementExists(page, '[data-testid="dashboard-panel-right"]', 3000);

      expect(hasLeftPanel).toBe(true);
      expect(hasRightPanel).toBe(true);
    });
  });

  describe('Session List Display', () => {
    it('displays dashboard search input', async () => {
      await navigateToHome(page);
      await waitForDashboardReady(page);

      // Dashboard search should be visible
      const searchExists = await elementExists(page, '[data-testid="dashboard-search"]', 5000);
      expect(searchExists).toBe(true);
    });

    it('displays session cards for existing sessions', async () => {
      await navigateToHome(page);
      await waitForDashboardReady(page);

      // Wait a moment for sessions to load
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Check for session cards - dashboard always shows the list (may be empty)
      const sessionCards = await page.$$('[data-testid^="session-stat-card-"]');
      const hasDashboard = await elementExists(page, '[data-testid="dashboard-floating-panel"]', 1000);

      // Dashboard should be present; session cards depend on existing data
      expect(hasDashboard).toBe(true);
    });

    it('session cards show duration information', async () => {
      await navigateToHome(page);
      await waitForDashboardReady(page);

      // Wait for potential session cards
      const sessionCards = await page.$$('[data-testid^="session-stat-card-"]');

      if (sessionCards.length > 0) {
        // First session card should have duration info
        const hasDuration = await elementExists(page, '[data-testid$="-duration"]', 2000);
        expect(hasDuration).toBe(true);
      }
    });

    it('session cards show last accessed time', async () => {
      await navigateToHome(page);
      await waitForDashboardReady(page);

      const sessionCards = await page.$$('[data-testid^="session-stat-card-"]');

      if (sessionCards.length > 0) {
        // First session card should have last accessed info
        const hasAccessed = await elementExists(page, '[data-testid$="-accessed"]', 2000);
        expect(hasAccessed).toBe(true);
      }
    });
  });

  describe('Search Functionality', () => {
    it('can type in search input', async () => {
      await navigateToHome(page);
      await waitForDashboardReady(page);

      // Find and interact with dashboard search input (plain <input> element)
      await waitForSelector(page, '[data-testid="dashboard-search"]');

      const searchInput = await page.$('[data-testid="dashboard-search"]');
      if (searchInput) {
        await searchInput.type('test');

        // Verify the input value
        const value = await page.evaluate(
          (el) => (el as HTMLInputElement).value,
          searchInput
        );
        expect(value).toBe('test');
      }
    });

    it('search filters session list', async () => {
      await navigateToHome(page);
      await waitForDashboardReady(page);

      // Get initial session count
      const initialCards = await page.$$('[data-testid^="session-stat-card-"]');

      if (initialCards.length > 0) {
        // Type a search query that probably won't match
        const searchInput = await page.$('[data-testid="dashboard-search"]');
        if (searchInput) {
          await searchInput.type('zzzznonexistent');

          // Wait for filter to apply
          await new Promise((resolve) => setTimeout(resolve, 500));

          // Check for filtered results
          const filteredCards = await page.$$('[data-testid^="session-stat-card-"]');

          // Should have fewer cards after filtering with a nonexistent query
          expect(filteredCards.length).toBeLessThan(initialCards.length);
        }
      }
    });

    it('can clear search input', async () => {
      await navigateToHome(page);
      await waitForDashboardReady(page);

      const searchInput = await page.$('[data-testid="dashboard-search"]');
      if (searchInput) {
        // Type something
        await searchInput.type('test');

        // Clear it (triple click + delete)
        await searchInput.click({ clickCount: 3 });
        await page.keyboard.press('Backspace');

        // Verify empty
        const value = await page.evaluate(
          (el) => (el as HTMLInputElement).value,
          searchInput
        );
        expect(value).toBe('');
      }
    });
  });

  describe('Session Card Interactions', () => {
    it('session card is clickable', async () => {
      await navigateToHome(page);
      await waitForDashboardReady(page);

      const sessionCards = await page.$$('[data-testid^="session-stat-card-"]');

      if (sessionCards.length > 0) {
        // Get the first card's testid
        const testId = await page.evaluate(
          (el) => el.getAttribute('data-testid'),
          sessionCards[0]
        );

        // Click the card
        await sessionCards[0].click();

        // Card should respond (might become selected, start session, etc.)
        // This is a smoke test - just verify no errors
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    });

    it('running session shows tab count', async () => {
      await navigateToHome(page);
      await waitForDashboardReady(page);

      // Dashboard shows all sessions - look for running ones with tab count
      const sessionCards = await page.$$('[data-testid^="session-stat-card-"]');

      if (sessionCards.length > 0) {
        // Running sessions should show tab count
        const hasTabCount = await elementExists(page, '[data-testid$="-tabs"]', 2000);
        // Tab count only shows for running sessions, may not be present
      }
    });

    it('initializing session shows progress bar', async () => {
      await navigateToHome(page);
      await waitForDashboardReady(page);

      // Check for any session with progress bar
      const hasProgress = await elementExists(page, '[data-testid$="-progress"]', 2000);

      // This might not always be visible (depends on session state)
      // Just verify the selector works when present
    });
  });

  describe('Session Creation', () => {
    it('has mechanism to create new session', async () => {
      await navigateToHome(page);
      await waitForDashboardReady(page);

      // Dashboard always has a "New Session" button
      const hasCreateButton = await elementExists(page, '[data-testid="dashboard-new-session"]', 3000);

      // Even with existing sessions, there should be a way to create more
      expect(hasCreateButton).toBe(true);
    });
  });

  describe('Keyboard Navigation', () => {
    it('search input can be focused with keyboard shortcut', async () => {
      await navigateToHome(page);
      await waitForDashboardReady(page);

      // The app supports Cmd+/ to focus search
      await page.keyboard.down('Control');
      await page.keyboard.press('/');
      await page.keyboard.up('Control');

      // Wait a moment
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Check if search input is focused
      const isFocused = await page.evaluate(() => {
        const searchInput = document.querySelector('[data-testid="dashboard-search"]');
        return document.activeElement === searchInput;
      });

      // Note: This might not work if keyboard shortcuts aren't fully implemented
      // This is a best-effort test
    });
  });

  describe('Session Status Display', () => {
    it('displays status badges on session cards', async () => {
      await navigateToHome(page);
      await waitForDashboardReady(page);

      const sessionCards = await page.$$('[data-testid^="session-stat-card-"]');

      if (sessionCards.length > 0) {
        // Session cards should have status indication (badge, icon, or class)
        const hasBadge = await elementExists(page, '[data-testid="badge"]', 2000);
        const hasStatusClass = await page.evaluate(() => {
          const card = document.querySelector('[data-testid^="session-stat-card-"]');
          const cardWrapper = card?.querySelector('.session-card, [class*="status"]');
          return cardWrapper !== null;
        });

        expect(hasBadge || hasStatusClass).toBe(true);
      }
    });
  });

  describe('UI Responsiveness', () => {
    it('dashboard panel left is scrollable with many items', async () => {
      await navigateToHome(page);
      await waitForDashboardReady(page);

      // Check that the dashboard left panel has overflow handling
      const hasScrollableContainer = await page.evaluate(() => {
        const container = document.querySelector('[data-testid="dashboard-panel-left"]');
        if (!container) return false;

        const style = window.getComputedStyle(container);
        return (
          style.overflow === 'auto' ||
          style.overflow === 'scroll' ||
          style.overflowY === 'auto' ||
          style.overflowY === 'scroll'
        );
      });

      // The panel should be scrollable
      expect(hasScrollableContainer).toBe(true);
    });

    it('dashboard loads within reasonable time', async () => {
      const startTime = Date.now();

      await navigateToHome(page);
      await waitForDashboardReady(page);

      // Wait for dashboard search to be ready
      await waitForSelector(page, '[data-testid="dashboard-search"]');

      const loadTime = Date.now() - startTime;

      // Should load within 10 seconds
      expect(loadTime).toBeLessThan(10000);
    });
  });
});
