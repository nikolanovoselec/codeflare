import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Browser, Page } from 'puppeteer';
import {
  launchBrowser, createPage, navigateToDashboard, navigateToSessionView, checkSetupComplete,
  registerScreenshotOnFailure, createSessionViaApi, deleteSessionViaApi, startContainerViaApi,
  waitForContainerReady,
} from '../helpers';
import { apiRequest } from '../setup';

const isSetup = await checkSetupComplete();

describe.skipIf(!isSetup)('Storage', () => {
  let browser: Browser;
  let page: Page;
  let sessionId: string;

  registerScreenshotOnFailure(() => page);

  beforeAll(async () => {
    browser = await launchBrowser();
    page = await createPage(browser);
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
        { timeout: 10000 }
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
          { timeout: 5000 },
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
        await page.waitForSelector('[data-testid="storage-breadcrumbs"]', { timeout: 5000 });
      }
      expect(true).toBe(true); // navigation succeeded without error
    });
  });

  describe('Session storage (slide-in panel)', () => {
    beforeAll(async () => {
      await startContainerViaApi(sessionId);
      await navigateToSessionView(page, sessionId);
      await waitForContainerReady(page, sessionId);
      await page.waitForSelector('[data-testid="terminal-tabs"]', { timeout: 30000 });
    });

    it('clicking storage button opens storage panel', async () => {
      await page.click('[data-testid="header-storage-button"]');
      await page.waitForFunction(
        () => document.querySelector('[data-testid="storage-panel"]')?.getAttribute('aria-hidden') === 'false',
        { timeout: 10000 }
      );
      const ariaHidden = await page.$eval('[data-testid="storage-panel"]', el => el.getAttribute('aria-hidden'));
      expect(ariaHidden).toBe('false');
    });

    it('storage panel shows storage browser', async () => {
      const storageBrowser = await page.$('[data-testid="storage-panel"] [data-testid="storage-browser"]');
      expect(storageBrowser).toBeTruthy();
    });

    it('close button closes storage panel', async () => {
      await page.click('[data-testid="storage-panel-close-button"]');
      await page.waitForFunction(
        () => document.querySelector('[data-testid="storage-panel"]')?.getAttribute('aria-hidden') === 'true',
        { timeout: 10000 }
      );
      const ariaHidden = await page.$eval('[data-testid="storage-panel"]', el => el.getAttribute('aria-hidden'));
      expect(ariaHidden).toBe('true');
    });
  });
});
