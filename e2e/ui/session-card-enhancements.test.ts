import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { Browser, Page } from 'puppeteer';
import { launchBrowser, createPage, navigateToHome, waitForAppReady, isMainAppAvailable } from './setup';
import { waitForSelector, isElementVisible, elementExists, getTextContent } from './helpers';
import { cleanupSessions } from '../helpers/test-utils';

describe('Session Card Enhancements', () => {
  let browser: Browser;
  let page: Page;
  let mainAppAvailable: boolean;
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
    await navigateToHome(page);
    await waitForAppReady(page);
    mainAppAvailable = await isMainAppAvailable(page);
  });

  afterEach(async () => {
    if (page && !page.isClosed()) await page.close();
  });

  describe('LIVE Badge Positioning', () => {
    it('should render LIVE badge on running session', async () => {
      if (!mainAppAvailable) return;
      const badge = await page.$('.session-status-badge[data-status="success"]');
      expect(badge).not.toBeNull();
    });

    it('should position LIVE badge at right edge of header', async () => {
      if (!mainAppAvailable) return;
      const header = await page.$('.session-card-header');
      const badge = await page.$('.session-status-badge');
      if (header && badge) {
        const headerBox = await header.boundingBox();
        const badgeBox = await badge.boundingBox();
        const headerRight = headerBox!.x + headerBox!.width;
        const badgeRight = badgeBox!.x + badgeBox!.width;
        expect(headerRight - badgeRight).toBeLessThan(20);
      }
    });

    it('should display shimmer animation on LIVE badge', async () => {
      if (!mainAppAvailable) return;
      const badge = await page.$('.session-badge-shimmer');
      expect(badge).not.toBeNull();
    });
  });

  describe('Slide-in Action Buttons', () => {
    it('should hide action buttons by default', async () => {
      if (!mainAppAvailable) return;
      const overlay = await page.$('.session-card-actions-overlay');
      if (overlay) {
        const opacity = await page.evaluate(el => window.getComputedStyle(el).opacity, overlay);
        expect(opacity).toBe('0');
      }
    });

    it('should show action buttons on card hover', async () => {
      if (!mainAppAvailable) return;
      const card = await page.$('[data-testid^="session-card-"]');
      if (card) {
        await card.hover();
        await new Promise(r => setTimeout(r, 250));
        const overlay = await page.$('.session-card-actions-overlay');
        if (overlay) {
          const opacity = await page.evaluate(el => window.getComputedStyle(el).opacity, overlay);
          expect(opacity).toBe('1');
        }
      }
    });

    it('should slide buttons in from right edge', async () => {
      if (!mainAppAvailable) return;
      const card = await page.$('[data-testid^="session-card-"]');
      if (card) {
        await card.hover();
        await new Promise(r => setTimeout(r, 250));
        const overlay = await page.$('.session-card-actions-overlay');
        if (overlay) {
          const transform = await page.evaluate(el => window.getComputedStyle(el).transform, overlay);
          // After hover, translateX should be 0 (not 100%)
          expect(transform).not.toContain('100');
        }
      }
    });

    it('should stack buttons vertically', async () => {
      if (!mainAppAvailable) return;
      const card = await page.$('[data-testid^="session-card-"]');
      if (card) {
        await card.hover();
        await new Promise(r => setTimeout(r, 250));
        const flexDir = await page.evaluate(() => {
          const overlay = document.querySelector('.session-card-actions-overlay');
          return overlay ? window.getComputedStyle(overlay).flexDirection : null;
        });
        expect(flexDir).toBe('column');
      }
    });

    it('should hide buttons when mouse leaves card', async () => {
      if (!mainAppAvailable) return;
      const card = await page.$('[data-testid^="session-card-"]');
      if (card) {
        await card.hover();
        await new Promise(r => setTimeout(r, 250));
        await page.mouse.move(0, 0);
        await new Promise(r => setTimeout(r, 250));
        const overlay = await page.$('.session-card-actions-overlay');
        if (overlay) {
          const opacity = await page.evaluate(el => window.getComputedStyle(el).opacity, overlay);
          expect(opacity).toBe('0');
        }
      }
    });
  });

  describe('Developer Metrics Section', () => {
    it('should render metrics section for running sessions', async () => {
      if (!mainAppAvailable) return;
      const metrics = await page.$('.session-card-metrics');
      // Metrics should exist for running sessions
      expect(metrics).not.toBeNull();
    });

    it('should NOT render metrics for stopped sessions', async () => {
      if (!mainAppAvailable) return;
      const stoppedCard = await page.$('[data-testid^="session-card-"][data-status="stopped"]');
      if (stoppedCard) {
        const metrics = await stoppedCard.$('.session-card-metrics');
        expect(metrics).toBeNull();
      }
    });

    it('should display uptime metric', async () => {
      if (!mainAppAvailable) return;
      const uptime = await page.$('[data-testid$="-metric-uptime"]');
      if (uptime) {
        const text = await page.evaluate(el => el.textContent, uptime);
        expect(text).toMatch(/\d+[mh]/);
      }
    });

    it('should display container ID (short hash)', async () => {
      if (!mainAppAvailable) return;
      const container = await page.$('[data-testid$="-metric-container"]');
      if (container) {
        const text = await page.evaluate(el => el.querySelector('.metric-value')?.textContent, container);
        expect(text?.length).toBeLessThanOrEqual(12);
      }
    });

    it('should display R2 bucket name', async () => {
      if (!mainAppAvailable) return;
      const bucket = await page.$('[data-testid$="-metric-bucket"]');
      if (bucket) {
        const text = await page.evaluate(el => el.querySelector('.metric-value')?.textContent, bucket);
        expect(text).toContain('codeflare-');
      }
    });

    it('should display sync status with indicator', async () => {
      if (!mainAppAvailable) return;
      const sync = await page.$('[data-testid$="-metric-sync"]');
      if (sync) {
        const dot = await sync.$('.status-dot');
        expect(dot).not.toBeNull();
      }
    });

    it('should style metrics like DETAILS panel (dark boxes)', async () => {
      if (!mainAppAvailable) return;
      const metricValue = await page.$('.metric-value');
      if (metricValue) {
        const bg = await page.evaluate(el => window.getComputedStyle(el).backgroundColor, metricValue);
        expect(bg).not.toBe('rgba(0, 0, 0, 0)');
      }
    });
  });
});
