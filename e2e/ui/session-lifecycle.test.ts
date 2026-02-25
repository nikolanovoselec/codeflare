import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Browser, Page } from 'puppeteer';
import {
  launchBrowser, createPage, navigateToDashboard, checkSetupComplete, registerScreenshotOnFailure,
  deleteSessionViaApi,
} from '../helpers';
import { apiRequest } from '../setup';

const isSetup = await checkSetupComplete();

describe.skipIf(!isSetup)('Session lifecycle', () => {
  let browser: Browser;
  let page: Page;
  let sessionId: string;

  registerScreenshotOnFailure(() => page);

  beforeAll(async () => {
    browser = await launchBrowser();
    page = await createPage(browser);
    // Seed getting-started files for storage visibility
    await apiRequest('/api/storage/seed/getting-started', { method: 'POST' });
    await navigateToDashboard(page);
  });

  afterAll(async () => {
    if (sessionId) await deleteSessionViaApi(sessionId);
    await browser?.close();
  });

  it('creates session via UI', async () => {
    await page.click('[data-testid="dashboard-new-session"]');
    await page.waitForSelector('[data-testid="create-session-dialog"]', { timeout: 5000 });
    await page.click('[data-testid="csd-agent-bash"]');
    // Init progress screen replaces dashboard while container starts
    await page.waitForSelector('[data-testid="init-progress"]', { timeout: 15000 });
    // Wait for container to become ready and Open button to appear
    await page.waitForSelector('[data-testid="init-progress-open-btn"]', { timeout: 90000 });
    await page.click('[data-testid="init-progress-open-btn"]');
    // Now terminal view loads with header
    await page.waitForSelector('[data-testid="header-logo"]', { timeout: 30000 });
    // Extract session ID from URL (hash or query params)
    const url = page.url();
    const match = url.match(/[?&#]session=([a-z0-9]+)/i) || url.match(/\/session\/([a-z0-9]+)/i);
    if (match) {
      sessionId = match[1];
    }
    // If URL didn't contain session ID, we'll extract it from the dashboard card later
    expect(sessionId || url).toBeTruthy();
  });

  it('terminal becomes ready with tabs', async () => {
    await page.waitForSelector('[data-testid="terminal-tabs"]', { timeout: 90000 });
    const tabs = await page.$('[data-testid="terminal-tabs"]');
    expect(tabs).toBeTruthy();
  });

  it('navigates back to dashboard and shows session card', async () => {
    // Full page navigation to dashboard — in-page back button may not render
    // dashboard if initializingSessionIds was not cleared after startup.
    await navigateToDashboard(page);
    // Wait for session card to appear
    await page.waitForFunction(
      () => document.querySelector('[data-testid^="session-stat-card-"]') !== null,
      { timeout: 15000 }
    );
    const cards = await page.$$('[data-testid^="session-stat-card-"]');
    expect(cards.length).toBeGreaterThan(0);
    // If sessionId wasn't captured from URL, extract from the card's data-testid
    if (!sessionId) {
      const testId = await cards[0].evaluate(el => el.getAttribute('data-testid'));
      // data-testid="session-stat-card-{id}" -> extract id
      const cardMatch = testId?.match(/^session-stat-card-(.+)$/);
      if (cardMatch) {
        sessionId = cardMatch[1];
      }
    }
    expect(sessionId).toBeTruthy();
  });

  it('session card shows metrics', async () => {
    // Metrics may take a few seconds to populate via collectMetrics heartbeat
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid^="session-stat-card-"][data-testid$="-metric-cpu"]');
        return el !== null;
      },
      { timeout: 30000 }
    );
    const cpu = await page.$('[data-testid^="session-stat-card-"][data-testid$="-metric-cpu"]');
    expect(cpu).toBeTruthy();
  });

  it('stops session via context menu', async () => {
    // Click the three-dot menu trigger (not right-click -- no contextmenu handler on card)
    await page.click(`[data-testid="session-stat-card-${sessionId}-menu"]`);
    await page.waitForSelector('[data-testid="session-context-menu"]', { timeout: 5000 });
    await page.click('[data-testid="context-menu-stop"]');
    // Wait for status to change — dot loses --success variant when stopped
    await page.waitForFunction(
      () => {
        const dot = document.querySelector('[data-testid^="session-stat-card-"] .session-stat-card__dot');
        return dot && !dot.classList.contains('session-stat-card__dot--success');
      },
      { timeout: 30000, polling: 1000 }
    );
  });

  it('deletes session via context menu', async () => {
    // Click the three-dot menu trigger (not right-click -- no contextmenu handler on card)
    await page.click(`[data-testid="session-stat-card-${sessionId}-menu"]`);
    await page.waitForSelector('[data-testid="session-context-menu"]', { timeout: 5000 });
    await page.click('[data-testid="context-menu-delete"]');
    await page.waitForSelector('[data-testid="context-menu-delete-confirm"]', { timeout: 5000 });
    await page.click('[data-testid="context-menu-delete-confirm"]');
    // Wait for card to disappear
    await page.waitForFunction(
      () => document.querySelector('[data-testid^="session-stat-card-"]') === null,
      { timeout: 15000 }
    );
  });

  it('dashboard returns to empty state', async () => {
    const cards = await page.$$('[data-testid^="session-stat-card-"]');
    expect(cards.length).toBe(0);
  });
});
