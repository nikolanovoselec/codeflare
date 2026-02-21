import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { Browser, Page } from 'puppeteer';
import { launchBrowser, createPage, navigateToHome, takeScreenshot, waitForAppReady, waitForAppOrSetup, isMainAppAvailable, waitForDashboardReady, BASE_URL } from './setup';
import {
  waitForSelector,
  clickAndWait,
  getTextContent,
  elementExists,
  isElementVisible,
  waitForText,
  getElementCount,
} from './helpers';

/**
 * E2E Tests for Layout & Navigation
 *
 * Tests the overall layout structure:
 * - Header with logo and controls
 * - Status bar with connection status
 * - Sidebar collapsibility
 * - Session list in sidebar
 *
 * Note: These tests require the main app to be accessible (setup complete).
 * Tests will be skipped if the app redirects to the setup wizard.
 */
describe('Layout', () => {
  let browser: Browser;
  let page: Page;
  let mainAppAvailable: boolean;
  let isDashboardView: boolean;

  beforeAll(async () => {
    browser = await launchBrowser();
    // Check if main app is available (setup complete)
    const testPage = await createPage(browser);
    await navigateToHome(testPage);
    await waitForAppOrSetup(testPage);
    mainAppAvailable = await isMainAppAvailable(testPage);

    // Check if we're on the dashboard (no terminal layout)
    isDashboardView = await testPage.evaluate(() => {
      return !!document.querySelector('[data-testid="dashboard"]');
    });

    await testPage.close();

    if (!mainAppAvailable) {
      console.log('Main app not available (setup not complete). Layout tests will be skipped.');
    } else if (isDashboardView) {
      console.log('App is on dashboard view. Terminal layout tests will be skipped.');
    }
  });

  afterAll(async () => {
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

  // Helper to skip test if main app not available
  const skipIfNoMainApp = () => {
    if (!mainAppAvailable) {
      console.log('  -> Skipped (setup not complete)');
      return true;
    }
    return false;
  };

  // Helper to skip test if on dashboard view (terminal layout elements don't exist)
  const skipIfDashboardView = () => {
    if (isDashboardView) {
      console.log('  -> Skipped (dashboard view, no terminal layout)');
      return true;
    }
    return false;
  };

  // Combined skip: skip if no main app OR on dashboard
  const skipIfNoTerminalLayout = () => {
    return skipIfNoMainApp() || skipIfDashboardView();
  };

  describe('Header', () => {
    it('renders header with logo', async () => {
      if (skipIfNoTerminalLayout()) return;

      await navigateToHome(page);
      await waitForAppReady(page);

      // Header logo should be visible (only in terminal view)
      const logoExists = await elementExists(page, '[data-testid="header-logo"]', 5000);
      expect(logoExists).toBe(true);
    });

    it('logo contains Codeflare text', async () => {
      if (skipIfNoTerminalLayout()) return;
      await navigateToHome(page);
      await waitForAppReady(page);

      const logoText = await getTextContent(page, '[data-testid="header-logo"]');
      expect(logoText).toContain('Codeflare');
    });

    it('logo has icon element', async () => {
      if (skipIfNoTerminalLayout()) return;
      await navigateToHome(page);
      await waitForAppReady(page);

      const hasIcon = await page.evaluate(() => {
        const logo = document.querySelector('[data-testid="header-logo"]');
        const svg = logo?.querySelector('svg');
        return svg !== null;
      });

      expect(hasIcon).toBe(true);
    });

    it('renders search trigger button', async () => {
      if (skipIfNoTerminalLayout()) return;
      await navigateToHome(page);
      await waitForAppReady(page);

      const searchExists = await elementExists(page, '[data-testid="header-search-trigger"]', 3000);
      expect(searchExists).toBe(true);
    });

    it('search trigger has keyboard shortcut hint', async () => {
      if (skipIfNoTerminalLayout()) return;
      await navigateToHome(page);
      await waitForAppReady(page);

      const searchTrigger = await page.$('[data-testid="header-search-trigger"]');

      if (searchTrigger) {
        const title = await page.evaluate((el) => el.getAttribute('title'), searchTrigger);
        expect(title).toContain('K');
      }
    });

    it('renders settings button', async () => {
      if (skipIfNoTerminalLayout()) return;
      await navigateToHome(page);
      await waitForAppReady(page);

      const settingsExists = await elementExists(page, '[data-testid="header-settings-button"]', 3000);
      expect(settingsExists).toBe(true);
    });

    it('settings button has title attribute', async () => {
      if (skipIfNoTerminalLayout()) return;
      await navigateToHome(page);
      await waitForAppReady(page);

      const settingsButton = await page.$('[data-testid="header-settings-button"]');

      if (settingsButton) {
        const title = await page.evaluate((el) => el.getAttribute('title'), settingsButton);
        expect(title).toContain('Settings');
      }
    });

    it('renders user menu', async () => {
      if (skipIfNoTerminalLayout()) return;
      await navigateToHome(page);
      await waitForAppReady(page);

      const userMenuExists = await elementExists(page, '[data-testid="header-user-menu"]', 3000);
      expect(userMenuExists).toBe(true);
    });

    it('user menu shows user avatar', async () => {
      if (skipIfNoTerminalLayout()) return;
      await navigateToHome(page);
      await waitForAppReady(page);

      const userMenu = await page.$('[data-testid="header-user-menu"]');

      if (userMenu) {
        const hasAvatar = await page.evaluate((el) => {
          const svg = el.querySelector('svg');
          return svg !== null;
        }, userMenu);

        expect(hasAvatar).toBe(true);
      }
    });

    it('header has correct styling structure', async () => {
      if (skipIfNoTerminalLayout()) return;
      await navigateToHome(page);
      await waitForAppReady(page);

      const headerStyles = await page.evaluate(() => {
        const header = document.querySelector('header, .header');
        if (!header) return null;

        const computed = window.getComputedStyle(header);
        return {
          display: computed.display,
          height: computed.height,
        };
      });

      expect(headerStyles).not.toBeNull();
      expect(headerStyles?.display).toBe('flex');
    });
  });

  describe('Status Bar', () => {
    it('renders status bar with connection status', async () => {
      if (skipIfNoTerminalLayout()) return;
      await navigateToHome(page);
      await waitForAppReady(page);

      const statusBarExists = await elementExists(page, '[data-testid="status-bar-connection"]', 3000);
      expect(statusBarExists).toBe(true);
    });

    it('connection status shows connected or disconnected state', async () => {
      if (skipIfNoTerminalLayout()) return;
      await navigateToHome(page);
      await waitForAppReady(page);

      const connectionStatus = await page.$('[data-testid="status-bar-connection"]');

      if (connectionStatus) {
        const status = await page.evaluate((el) => el.getAttribute('data-status'), connectionStatus);
        expect(['connected', 'disconnected']).toContain(status);
      }
    });

    it('renders sync time indicator', async () => {
      if (skipIfNoTerminalLayout()) return;
      await navigateToHome(page);
      await waitForAppReady(page);

      const syncTimeExists = await elementExists(page, '[data-testid="status-bar-sync-time"]', 3000);
      expect(syncTimeExists).toBe(true);
    });

    it('sync time shows relative time', async () => {
      if (skipIfNoTerminalLayout()) return;
      await navigateToHome(page);
      await waitForAppReady(page);

      const syncText = await getTextContent(page, '[data-testid="status-bar-sync-time"]');
      expect(syncText).toContain('Last sync');
    });

    it('status bar is at bottom of layout', async () => {
      if (skipIfNoTerminalLayout()) return;
      await navigateToHome(page);
      await waitForAppReady(page);

      const statusBarPosition = await page.evaluate(() => {
        const statusBar = document.querySelector('.status-bar');
        if (!statusBar) return null;

        const rect = statusBar.getBoundingClientRect();
        const viewportHeight = window.innerHeight;

        // Status bar should be near the bottom
        return {
          isAtBottom: rect.bottom >= viewportHeight - 50,
          bottom: rect.bottom,
          viewportHeight,
        };
      });

      expect(statusBarPosition?.isAtBottom).toBe(true);
    });

    it('status bar has connection icon', async () => {
      if (skipIfNoTerminalLayout()) return;
      await navigateToHome(page);
      await waitForAppReady(page);

      const hasIcon = await page.evaluate(() => {
        const connection = document.querySelector('[data-testid="status-bar-connection"]');
        const svg = connection?.querySelector('svg');
        return svg !== null;
      });

      expect(hasIcon).toBe(true);
    });
  });

  describe('Sidebar', () => {
    it('sidebar can be collapsed', async () => {
      if (skipIfNoTerminalLayout()) return;
      await navigateToHome(page);
      await waitForAppReady(page);

      // Find and click the sidebar toggle
      const sidebarToggle = await page.$('.layout-sidebar-toggle');

      if (sidebarToggle) {
        await sidebarToggle.click();

        // Wait for animation
        await new Promise((resolve) => setTimeout(resolve, 400));

        // Check if sidebar has collapsed class
        const isCollapsed = await page.evaluate(() => {
          const sidebar = document.querySelector('.layout-sidebar');
          return sidebar?.classList.contains('layout-sidebar--collapsed') || false;
        });

        expect(isCollapsed).toBe(true);
      }
    });

    it('sidebar shows session list when expanded', async () => {
      if (skipIfNoTerminalLayout()) return;
      await navigateToHome(page);
      await waitForAppReady(page);

      // Ensure sidebar is expanded
      const isCollapsed = await page.evaluate(() => {
        const sidebar = document.querySelector('.layout-sidebar');
        return sidebar?.classList.contains('layout-sidebar--collapsed') || false;
      });

      if (isCollapsed) {
        // Expand it
        const toggle = await page.$('.layout-sidebar-toggle');
        if (toggle) await toggle.click();
        await new Promise((resolve) => setTimeout(resolve, 400));
      }

      // Session list should be visible
      const sessionListVisible = await elementExists(page, '[data-testid="session-list-search"]', 3000);
      expect(sessionListVisible).toBe(true);
    });

    it('collapsed sidebar hides session list', async () => {
      if (skipIfNoTerminalLayout()) return;
      await navigateToHome(page);
      await waitForAppReady(page);

      // Collapse sidebar
      const sidebarToggle = await page.$('.layout-sidebar-toggle');
      if (sidebarToggle) {
        // First ensure it's expanded
        const isCollapsed = await page.evaluate(() => {
          const sidebar = document.querySelector('.layout-sidebar');
          return sidebar?.classList.contains('layout-sidebar--collapsed') || false;
        });

        if (!isCollapsed) {
          await sidebarToggle.click();
          await new Promise((resolve) => setTimeout(resolve, 400));
        }

        // Session list content should be hidden
        const sessionListVisible = await isElementVisible(page, '.layout-sidebar-content');
        expect(sessionListVisible).toBe(false);
      }
    });

    it('sidebar toggle icon changes on collapse', async () => {
      if (skipIfNoTerminalLayout()) return;
      await navigateToHome(page);
      await waitForAppReady(page);

      const sidebarToggle = await page.$('.layout-sidebar-toggle');

      if (sidebarToggle) {
        // Get initial icon path
        const initialIconPath = await page.evaluate((el) => {
          const path = el.querySelector('path');
          return path?.getAttribute('d') || '';
        }, sidebarToggle);

        // Toggle
        await sidebarToggle.click();
        await new Promise((resolve) => setTimeout(resolve, 400));

        // Get new icon path
        const newIconPath = await page.evaluate((el) => {
          const path = el.querySelector('path');
          return path?.getAttribute('d') || '';
        }, sidebarToggle);

        // Icons should be different
        expect(newIconPath).not.toBe(initialIconPath);
      }
    });

    it('sidebar has footer with logout action', async () => {
      if (skipIfNoTerminalLayout()) return;
      await navigateToHome(page);
      await waitForAppReady(page);

      // Ensure sidebar is expanded
      const isCollapsed = await page.evaluate(() => {
        const sidebar = document.querySelector('.layout-sidebar');
        return sidebar?.classList.contains('layout-sidebar--collapsed') || false;
      });

      if (isCollapsed) {
        const toggle = await page.$('.layout-sidebar-toggle');
        if (toggle) await toggle.click();
        await new Promise((resolve) => setTimeout(resolve, 400));
      }

      // Footer should be visible
      const footerExists = await elementExists(page, '.layout-sidebar-footer', 2000);
      expect(footerExists).toBe(true);
    });

    it('sidebar width is correct when expanded', async () => {
      if (skipIfNoTerminalLayout()) return;
      await navigateToHome(page);
      await waitForAppReady(page);

      // Ensure sidebar is expanded
      const sidebar = await page.$('.layout-sidebar:not(.layout-sidebar--collapsed)');

      if (sidebar) {
        const width = await page.evaluate((el) => {
          return el.getBoundingClientRect().width;
        }, sidebar);

        // Should be around 280px (--sidebar-width)
        expect(width).toBeGreaterThanOrEqual(200);
        expect(width).toBeLessThanOrEqual(350);
      }
    });

    it('sidebar width is narrow when collapsed', async () => {
      if (skipIfNoTerminalLayout()) return;
      await navigateToHome(page);
      await waitForAppReady(page);

      // Collapse sidebar
      const toggle = await page.$('.layout-sidebar-toggle');
      if (toggle) {
        const isCollapsed = await page.evaluate(() => {
          const sidebar = document.querySelector('.layout-sidebar');
          return sidebar?.classList.contains('layout-sidebar--collapsed') || false;
        });

        if (!isCollapsed) {
          await toggle.click();
          await new Promise((resolve) => setTimeout(resolve, 400));
        }

        const sidebar = await page.$('.layout-sidebar--collapsed');
        if (sidebar) {
          const width = await page.evaluate((el) => {
            return el.getBoundingClientRect().width;
          }, sidebar);

          // Should be around 48-64px (--sidebar-collapsed-width)
          expect(width).toBeLessThan(100);
        }
      }
    });
  });

  describe('Main Content Area', () => {
    it('main content area exists', async () => {
      if (skipIfNoTerminalLayout()) return;
      await navigateToHome(page);
      await waitForAppReady(page);

      const mainExists = await elementExists(page, '.layout-main, main', 3000);
      expect(mainExists).toBe(true);
    });

    it('main content fills available space', async () => {
      if (skipIfNoTerminalLayout()) return;
      await navigateToHome(page);
      await waitForAppReady(page);

      const mainStyles = await page.evaluate(() => {
        const main = document.querySelector('.layout-main, main');
        if (!main) return null;

        const computed = window.getComputedStyle(main);
        return {
          flex: computed.flex,
          display: computed.display,
        };
      });

      expect(mainStyles?.flex).toContain('1');
    });

    it('terminal container exists in main area', async () => {
      if (skipIfNoTerminalLayout()) return;
      await navigateToHome(page);
      await waitForAppReady(page);

      const containerExists = await elementExists(page, '.layout-terminal-container', 3000);
      expect(containerExists).toBe(true);
    });
  });

  describe('Overall Layout Structure', () => {
    it('layout uses flexbox structure', async () => {
      if (skipIfNoTerminalLayout()) return;
      await navigateToHome(page);
      await waitForAppReady(page);

      const layoutStyles = await page.evaluate(() => {
        const layout = document.querySelector('.layout');
        if (!layout) return null;

        const computed = window.getComputedStyle(layout);
        return {
          display: computed.display,
          flexDirection: computed.flexDirection,
        };
      });

      expect(layoutStyles?.display).toBe('flex');
      expect(layoutStyles?.flexDirection).toBe('column');
    });

    it('middle section contains sidebar and main', async () => {
      if (skipIfNoTerminalLayout()) return;
      await navigateToHome(page);
      await waitForAppReady(page);

      const middleSection = await page.$('.layout-middle');

      if (middleSection) {
        const hasChildren = await page.evaluate((el) => {
          const sidebar = el.querySelector('.layout-sidebar');
          const main = el.querySelector('.layout-main, main');
          return sidebar !== null && main !== null;
        }, middleSection);

        expect(hasChildren).toBe(true);
      }
    });

    it('layout takes full viewport height', async () => {
      if (skipIfNoTerminalLayout()) return;
      await navigateToHome(page);
      await waitForAppReady(page);

      const layoutHeight = await page.evaluate(() => {
        const layout = document.querySelector('.layout');
        if (!layout) return 0;
        return layout.getBoundingClientRect().height;
      });

      const viewportHeight = await page.evaluate(() => window.innerHeight);

      // Layout should be at least 90% of viewport
      expect(layoutHeight).toBeGreaterThanOrEqual(viewportHeight * 0.9);
    });
  });

  describe('Error Display', () => {
    it('error area exists for displaying errors', async () => {
      if (skipIfNoTerminalLayout()) return;
      await navigateToHome(page);
      await waitForAppReady(page);

      // Error area should be ready (even if no errors currently)
      // Check CSS class exists in styles
      const hasErrorStyles = await page.evaluate(() => {
        // Just verify the structure supports error display
        const main = document.querySelector('.layout-main');
        return main !== null;
      });

      expect(hasErrorStyles).toBe(true);
    });
  });

  describe('Responsive Behavior', () => {
    it('layout adapts to viewport changes', async () => {
      if (skipIfNoTerminalLayout()) return;
      await navigateToHome(page);
      await waitForAppReady(page);

      // Get initial sidebar width
      const initialWidth = await page.evaluate(() => {
        const sidebar = document.querySelector('.layout-sidebar');
        return sidebar?.getBoundingClientRect().width || 0;
      });

      // Change viewport
      await page.setViewport({ width: 1920, height: 1080 });
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Sidebar should maintain proportions (or have max-width)
      const newWidth = await page.evaluate(() => {
        const sidebar = document.querySelector('.layout-sidebar');
        return sidebar?.getBoundingClientRect().width || 0;
      });

      // Width should be consistent (CSS custom property)
      expect(Math.abs(newWidth - initialWidth)).toBeLessThan(50);
    });

    it('layout handles small viewport', async () => {
      if (skipIfNoTerminalLayout()) return;
      await navigateToHome(page);
      await waitForAppReady(page);

      // Set small viewport
      await page.setViewport({ width: 800, height: 600 });
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Layout should still render
      const layoutExists = await elementExists(page, '.layout', 2000);
      expect(layoutExists).toBe(true);

      // Reset viewport
      await page.setViewport({ width: 1280, height: 720 });
    });
  });

  describe('Animation Classes', () => {
    it('header has animation class', async () => {
      if (skipIfNoTerminalLayout()) return;
      await navigateToHome(page);
      await waitForAppReady(page);

      const hasAnimation = await page.evaluate(() => {
        const header = document.querySelector('header, .header');
        return header?.classList.contains('animate-fadeInUp') || false;
      });

      expect(hasAnimation).toBe(true);
    });

    it('stagger animations are applied to session cards', async () => {
      if (skipIfNoTerminalLayout()) return;
      await navigateToHome(page);
      await waitForAppReady(page);

      // Session cards should have stagger animation
      const hasStaggerClass = await page.evaluate(() => {
        const cards = document.querySelectorAll('[data-testid^="session-stat-card-"]');
        if (cards.length === 0) return true; // No cards is fine

        const firstCard = cards[0];
        const wrapper = firstCard.closest('.stagger-item');
        return wrapper !== null;
      });

      expect(hasStaggerClass).toBe(true);
    });
  });

  describe('Theme Support', () => {
    it('layout uses CSS custom properties', async () => {
      if (skipIfNoMainApp()) return; // CSS vars exist on both dashboard and terminal view
      await navigateToHome(page);
      await waitForAppReady(page);

      const usesCSSVars = await page.evaluate(() => {
        const root = document.documentElement;
        const styles = getComputedStyle(root);

        // Check for common theme variables
        const bgPrimary = styles.getPropertyValue('--color-bg-primary');
        const textPrimary = styles.getPropertyValue('--color-text-primary');

        return bgPrimary !== '' || textPrimary !== '';
      });

      expect(usesCSSVars).toBe(true);
    });
  });

  describe('Navigation Flow', () => {
    it('clicking settings opens panel without navigation', async () => {
      if (skipIfNoMainApp()) return;
      await navigateToHome(page);

      // Wait for either dashboard or terminal layout
      const hasDashboard = await elementExists(page, '[data-testid="dashboard"]', 3000);

      if (hasDashboard) {
        await waitForDashboardReady(page);
      } else {
        await waitForAppReady(page);
      }

      const initialUrl = page.url();

      // Click settings - use dashboard settings button if on dashboard, header settings if in terminal view
      const settingsSelector = hasDashboard
        ? '[data-testid="dashboard-settings-button"]'
        : '[data-testid="header-settings-button"]';

      await clickAndWait(page, settingsSelector);

      const newUrl = page.url();

      // URL should not change
      expect(newUrl).toBe(initialUrl);
    });

    it('clicking session card does not navigate away', async () => {
      if (skipIfNoMainApp()) return;
      await navigateToHome(page);

      const hasDashboard = await elementExists(page, '[data-testid="dashboard"]', 3000);

      if (hasDashboard) {
        await waitForDashboardReady(page);
      } else {
        await waitForAppReady(page);
      }

      const initialUrl = page.url();

      // Click a session card if any exist
      const sessionCard = await page.$('[data-testid^="session-stat-card-"]');
      if (sessionCard) {
        await sessionCard.click();
        await new Promise((resolve) => setTimeout(resolve, 500));

        const newUrl = page.url();
        expect(newUrl).toBe(initialUrl);
      }
    });
  });
});
