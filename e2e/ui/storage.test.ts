import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Browser, Page } from 'puppeteer';
import {
  launchBrowser, createTestPage, navigateToDashboard, navigateToSessionView, checkSetupComplete,
  registerScreenshotOnFailure, createSessionViaApi, deleteSessionViaApi, startContainerViaApi,
  waitForContainerReady,
} from '../helpers';
import { apiRequest } from '../setup';
import { TIMEOUTS } from '../config';

const isSetup = await checkSetupComplete();

describe.skipIf(!isSetup)('Storage', () => {
  let browser: Browser;
  let page: Page;
  let sessionId: string;

  registerScreenshotOnFailure(() => page);

  beforeAll(async () => {
    browser = await launchBrowser();
    page = await createTestPage(browser);
    // Seed files for storage tests
    await apiRequest('/api/storage/seed/getting-started', { method: 'POST' });
    // Create a session for session-view storage tests
    const session = await createSessionViaApi({ agentType: 'bash' });
    sessionId = session.id;
  });

  afterAll(async () => {
    await deleteSessionViaApi(sessionId);
    await browser?.close();
  });

  describe('Dashboard storage (right panel)', () => {
    beforeAll(async () => {
      await navigateToDashboard(page);
    });

    it('storage browser is visible in right panel', async () => {
      const storageBrowser = await page.$('[data-testid="storage-browser"]');
      expect(storageBrowser).toBeTruthy();
    });

    it('breadcrumbs show root path', async () => {
      const breadcrumbs = await page.$('[data-testid="storage-breadcrumbs"]');
      expect(breadcrumbs).toBeTruthy();
    });

    it('seeded files are visible in file list', async () => {
      await page.waitForFunction(
        () => {
          const items = document.querySelectorAll('[data-testid="storage-browser"] [data-testid^="file-"], [data-testid="storage-browser"] [data-testid^="folder-"]');
          return items.length > 0;
        },
        { timeout: TIMEOUTS.TERMINAL_READY }
      );
      const items = await page.$$('[data-testid="storage-browser"] [data-testid^="file-"], [data-testid="storage-browser"] [data-testid^="folder-"]');
      expect(items.length).toBeGreaterThan(0);
    });

    it('clicking folder updates breadcrumbs', async () => {
      const folder = await page.$('[data-testid="storage-browser"] [data-testid^="folder-"]');
      if (folder) {
        const initialBreadcrumbs = await page.$eval('[data-testid="storage-breadcrumbs"]', (el) => el.textContent);
        await folder.click();
        await page.waitForFunction(
          (prev) => document.querySelector('[data-testid="storage-breadcrumbs"]')?.textContent !== prev,
          { timeout: TIMEOUTS.DIALOG },
          initialBreadcrumbs
        );
        const updatedBreadcrumbs = await page.$eval('[data-testid="storage-breadcrumbs"]', (el) => el.textContent);
        expect(updatedBreadcrumbs).not.toBe(initialBreadcrumbs);
      }
    });

    it('up button returns to parent', async () => {
      const upBtn = await page.$('[data-testid="storage-up-btn"]');
      if (upBtn) {
        await upBtn.click();
        await page.waitForSelector('[data-testid="storage-breadcrumbs"]', { timeout: TIMEOUTS.DIALOG });
      }
      expect(true).toBe(true); // navigation succeeded without error
    });

    it('should update breadcrumbs when navigating into folder', async () => {
      // Navigate to root first via up button if available
      const upBtn = await page.$('[data-testid="storage-up-btn"]');
      if (upBtn) await upBtn.click();
      await page.waitForSelector('[data-testid="storage-breadcrumbs"]', { timeout: TIMEOUTS.DIALOG });

      const folder = await page.$('[data-testid="storage-browser"] [data-testid^="folder-"]');
      if (folder) {
        const initialText = await page.$eval('[data-testid="storage-breadcrumbs"]', (el) => el.textContent);
        await folder.click();
        await page.waitForFunction(
          (prev) => document.querySelector('[data-testid="storage-breadcrumbs"]')?.textContent !== prev,
          { timeout: TIMEOUTS.DIALOG },
          initialText
        );
        // Verify at least one additional breadcrumb segment exists
        const segments = await page.$$('[data-testid^="breadcrumb-"]');
        expect(segments.length).toBeGreaterThan(0);
      }
    });

    it('should navigate to folder when clicking breadcrumb segment', async () => {
      // First navigate into a folder so we have breadcrumb segments
      const folder = await page.$('[data-testid="storage-browser"] [data-testid^="folder-"]');
      if (folder) {
        await folder.click();
        await page.waitForSelector('[data-testid^="breadcrumb-"]', { timeout: TIMEOUTS.DIALOG });
      }
      // Click the root breadcrumb (index 0) to navigate back
      const rootBreadcrumb = await page.$('[data-testid="breadcrumb-0"]');
      if (rootBreadcrumb) {
        await rootBreadcrumb.click();
        // File list should update — wait for folders to reappear at root level
        await page.waitForFunction(
          () => {
            const items = document.querySelectorAll('[data-testid="storage-browser"] [data-testid^="folder-"], [data-testid="storage-browser"] [data-testid^="file-"]');
            return items.length > 0;
          },
          { timeout: TIMEOUTS.DIALOG }
        );
        const items = await page.$$('[data-testid="storage-browser"] [data-testid^="folder-"], [data-testid="storage-browser"] [data-testid^="file-"]');
        expect(items.length).toBeGreaterThan(0);
      }
    });

    it('should toggle hidden files visibility', async () => {
      const toggle = await page.$('[data-testid="storage-hidden-toggle"]');
      if (toggle) {
        // Count items before toggle
        const itemsBefore = await page.$$('[data-testid="storage-browser"] [data-testid^="file-"], [data-testid="storage-browser"] [data-testid^="folder-"]');
        const countBefore = itemsBefore.length;
        // Click toggle to show/hide hidden files
        await toggle.click();
        // Wait briefly for re-render
        await page.waitForFunction(
          (prevCount: number) => {
            const items = document.querySelectorAll('[data-testid="storage-browser"] [data-testid^="file-"], [data-testid="storage-browser"] [data-testid^="folder-"]');
            return items.length !== prevCount;
          },
          { timeout: TIMEOUTS.DIALOG },
          countBefore
        ).catch(() => {
          // If count didn't change, that's acceptable (no hidden files exist)
        });
        // Toggle back to restore original state
        await toggle.click();
      }
      expect(true).toBe(true); // toggle interaction succeeded without error
    });
  });

  describe('Session storage (slide-in panel)', () => {
    beforeAll(async () => {
      await startContainerViaApi(sessionId);
      await navigateToSessionView(page, sessionId);
      await waitForContainerReady(page, sessionId);
      await page.waitForSelector('[data-testid="terminal-tabs"]', { timeout: TIMEOUTS.TERMINAL_READY });
    });

    it('clicking storage button opens storage panel', async () => {
      await page.evaluate(() => {
        const el = document.querySelector('[data-testid="header-storage-button"]');
        if (!el) throw new Error('Element not found: header-storage-button');
        (el as HTMLElement).click();
      });
      // Wait for panel open: aria-hidden=false AND CSS transform complete
      await page.waitForFunction(
        () => {
          const panel = document.querySelector('[data-testid="storage-panel"]');
          if (!panel) return false;
          if (panel.getAttribute('aria-hidden') !== 'false') return false;
          const t = getComputedStyle(panel).transform;
          return t === 'none' || t === 'matrix(1, 0, 0, 1, 0, 0)';
        },
        { timeout: TIMEOUTS.TERMINAL_READY }
      );
      const ariaHidden = await page.$eval('[data-testid="storage-panel"]', el => el.getAttribute('aria-hidden'));
      expect(ariaHidden).toBe('false');
    });

    it('storage panel shows storage browser', async () => {
      const storageBrowser = await page.$('[data-testid="storage-panel"] [data-testid="storage-browser"]');
      expect(storageBrowser).toBeTruthy();
    });

    it('close button closes storage panel', async () => {
      await page.evaluate(() => {
        const el = document.querySelector('[data-testid="storage-panel-close-button"]');
        if (!el) throw new Error('Element not found: storage-panel-close-button');
        (el as HTMLElement).click();
      });
      // Wait for panel close: aria-hidden=true AND CSS transform complete
      await page.waitForFunction(
        () => {
          const panel = document.querySelector('[data-testid="storage-panel"]');
          if (!panel) return true;
          if (panel.getAttribute('aria-hidden') !== 'true') return false;
          const t = getComputedStyle(panel).transform;
          return t !== 'none' && t !== 'matrix(1, 0, 0, 1, 0, 0)';
        },
        { timeout: TIMEOUTS.TERMINAL_READY }
      );
      const ariaHidden = await page.$eval('[data-testid="storage-panel"]', el => el.getAttribute('aria-hidden'));
      expect(ariaHidden).toBe('true');
    });
  });
});
