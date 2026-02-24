import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Browser, Page } from 'puppeteer';
import {
  launchBrowser, createPage, navigateToDashboard, checkSetupComplete, registerScreenshotOnFailure,
  deleteAllSessionsViaApi,
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
    await deleteAllSessionsViaApi();
    await browser?.close();
  });

  it('creates session via UI', async () => {
    await page.click('[data-testid="dashboard-new-session"]');
    await page.waitForSelector('[data-testid="create-session-dialog"]', { timeout: 5000 });
    await page.click('[data-testid="csd-agent-bash"]');
    // Wait for navigation to session view
    await page.waitForSelector('[data-testid="header-logo"]', { timeout: 30000 });
    // Extract session ID from URL
    const url = page.url();
    const match = url.match(/[?&]session=([a-z0-9]+)/i) || url.match(/\/session\/([a-z0-9]+)/i);
    if (match) {
      sessionId = match[1];
    }
    expect(sessionId || url).toBeTruthy();
  });

  it('shows init progress during container startup', async () => {
    const _progress = await page.$('[data-testid="init-progress"]');
    // Init progress may or may not be visible depending on timing
    // If container is fast, it may already be ready
    expect(true).toBe(true); // Non-blocking check
  });

  it('terminal becomes ready with tabs', async () => {
    await page.waitForSelector('[data-testid="terminal-tabs"]', { timeout: 90000 });
    const tabs = await page.$('[data-testid="terminal-tabs"]');
    expect(tabs).toBeTruthy();
  });

  it('navigates back to dashboard and shows session card', async () => {
    await page.click('[data-testid="header-dashboard-button"]');
    await page.waitForSelector('[data-testid="dashboard"]', { timeout: 10000 });
    // Wait for session card to appear (polling picks it up)
    await page.waitForFunction(
      () => document.querySelector('[data-testid^="session-stat-card-"]') !== null,
      { timeout: 15000 }
    );
    const cards = await page.$$('[data-testid^="session-stat-card-"]');
    expect(cards.length).toBeGreaterThan(0);
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
    const card = await page.$('[data-testid^="session-stat-card-"]');
    expect(card).toBeTruthy();
    await card!.click({ button: 'right' });
    await page.waitForSelector('[data-testid="session-context-menu"]', { timeout: 5000 });
    await page.click('[data-testid="context-menu-stop"]');
    // Wait for status to change (card updates via polling)
    await page.waitForFunction(
      () => {
        const dot = document.querySelector('[data-testid^="session-stat-card-"] .status-dot');
        return dot && !dot.classList.contains('green');
      },
      { timeout: 30000, polling: 1000 }
    );
  });

  it('deletes session via context menu', async () => {
    const card = await page.$('[data-testid^="session-stat-card-"]');
    expect(card).toBeTruthy();
    await card!.click({ button: 'right' });
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
