import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Browser, Page } from 'puppeteer';
import {
  launchBrowser, createTestPage, navigateToDashboard, checkSetupComplete, registerScreenshotOnFailure,
  createSessionViaApi, deleteSessionViaApi, startContainerViaApi,
} from '../helpers';
import { apiRequest } from '../setup';
import { TIMEOUTS } from '../config';

const isSetup = await checkSetupComplete();

describe.skipIf(!isSetup)('Session lifecycle', () => {
  let browser: Browser;
  let page: Page;
  let sessionId: string;

  registerScreenshotOnFailure(() => page);

  beforeAll(async () => {
    browser = await launchBrowser();
    page = await createTestPage(browser);
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
    await page.waitForSelector('[data-testid="create-session-dialog"]', { timeout: TIMEOUTS.DIALOG });
    await page.click('[data-testid="csd-agent-bash"]');
    // Init progress screen replaces dashboard while container starts
    await page.waitForSelector('[data-testid="init-progress"]', { timeout: TIMEOUTS.DASHBOARD });
    // Wait for container to become ready and Open button to appear
    await page.waitForSelector('[data-testid="init-progress-open-btn"]', { timeout: TIMEOUTS.SESSION_NAV });
    await page.click('[data-testid="init-progress-open-btn"]');
    // Now terminal view loads with header
    await page.waitForSelector('[data-testid="header-logo"]', { timeout: TIMEOUTS.TERMINAL_READY });
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
    await page.waitForSelector('[data-testid="terminal-tabs"]', { timeout: TIMEOUTS.SESSION_NAV });
    const tabs = await page.$('[data-testid="terminal-tabs"]');
    expect(tabs).toBeTruthy();
  });

  it('navigates back to dashboard and shows session card', { retry: 2 }, async () => {
    // Full page navigation to dashboard — in-page back button may not render
    // dashboard if initializingSessionIds was not cleared after startup.
    await navigateToDashboard(page);
    // Wait for session card to appear
    await page.waitForFunction(
      () => document.querySelector('[data-testid^="session-stat-card-"]') !== null,
      { timeout: TIMEOUTS.DASHBOARD }
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
      { timeout: TIMEOUTS.TERMINAL_READY }
    );
    const cpu = await page.$('[data-testid^="session-stat-card-"][data-testid$="-metric-cpu"]');
    expect(cpu).toBeTruthy();
  });

  it('stops session via context menu', async () => {
    await page.click(`[data-testid="session-stat-card-${sessionId}-menu"]`);
    await page.waitForSelector('[data-testid="session-context-menu"]', { timeout: TIMEOUTS.DIALOG });
    await page.click('[data-testid="context-menu-stop"]');
    // Wait for status to change — dot loses --success variant when stopped
    await page.waitForFunction(
      () => {
        const dot = document.querySelector('[data-testid^="session-stat-card-"] .session-stat-card__dot');
        return dot && !dot.classList.contains('session-stat-card__dot--success');
      },
      { timeout: TIMEOUTS.TERMINAL_READY, polling: TIMEOUTS.CONTAINER_POLL_INTERVAL }
    );
  });

  it('deletes session via context menu', async () => {
    await page.click(`[data-testid="session-stat-card-${sessionId}-menu"]`);
    await page.waitForSelector('[data-testid="session-context-menu"]', { timeout: TIMEOUTS.DIALOG });
    await page.click('[data-testid="context-menu-delete"]');
    await page.waitForSelector('[data-testid="context-menu-delete-confirm"]', { timeout: TIMEOUTS.DIALOG });
    await page.click('[data-testid="context-menu-delete-confirm"]');
    // Wait for card to disappear
    await page.waitForFunction(
      () => document.querySelector('[data-testid^="session-stat-card-"]') === null,
      { timeout: TIMEOUTS.DASHBOARD }
    );
  });

  it('dashboard returns to empty state', async () => {
    const cards = await page.$$('[data-testid^="session-stat-card-"]');
    expect(cards.length).toBe(0);
  });

  it('should auto-start container when clicking stopped session', { retry: 2 }, async () => {
    // Create a session via API (container is stopped by default)
    const session = await createSessionViaApi({ agentType: 'bash' });
    const autoStartId = session.id;
    try {
      await navigateToDashboard(page);
      // Wait for session card to appear
      await page.waitForFunction(
        (id: string) => !!document.querySelector(`[data-testid="session-stat-card-${id}"]`),
        { timeout: TIMEOUTS.SESSION_CARD, polling: TIMEOUTS.CONTAINER_POLL_INTERVAL },
        autoStartId
      );
      // Click the session card to navigate into it (use evaluate for mobile hit-test reliability)
      await page.evaluate((id: string) => {
        const el = document.querySelector(`[data-testid="session-stat-card-${id}"]`);
        if (!el) throw new Error(`Element not found: session-stat-card-${id}`);
        (el as HTMLElement).click();
      }, autoStartId);
      // Init progress screen should appear (container starting)
      await page.waitForSelector('[data-testid="init-progress"]', { timeout: TIMEOUTS.SESSION_NAV });
      // Wait for "Open" button to appear (container ready)
      await page.waitForSelector('[data-testid="init-progress-open-btn"]', { timeout: TIMEOUTS.SESSION_NAV });
      await page.evaluate(() => {
        const el = document.querySelector('[data-testid="init-progress-open-btn"]');
        if (!el) throw new Error('Element not found: init-progress-open-btn');
        (el as HTMLElement).click();
      });
      // Terminal view should load
      await page.waitForSelector('[data-testid="header-logo"]', { timeout: TIMEOUTS.TERMINAL_READY });
    } finally {
      await deleteSessionViaApi(autoStartId);
    }
  });

  it('should show delete confirmation on first click', { retry: 2 }, async () => {
    const session = await createSessionViaApi({ agentType: 'bash' });
    const confirmId = session.id;
    try {
      await navigateToDashboard(page);
      // Wait for session card
      await page.waitForFunction(
        (id: string) => !!document.querySelector(`[data-testid="session-stat-card-${id}"]`),
        { timeout: TIMEOUTS.SESSION_CARD, polling: TIMEOUTS.CONTAINER_POLL_INTERVAL },
        confirmId
      );
      // Open context menu (use evaluate for mobile hit-test reliability)
      await page.evaluate((id: string) => {
        const el = document.querySelector(`[data-testid="session-stat-card-${id}-menu"]`);
        if (!el) throw new Error(`Element not found: session-stat-card-${id}-menu`);
        (el as HTMLElement).click();
      }, confirmId);
      await page.waitForSelector('[data-testid="session-context-menu"]', { timeout: TIMEOUTS.DIALOG });
      // First click on delete shows confirmation
      await page.evaluate(() => {
        const el = document.querySelector('[data-testid="context-menu-delete"]');
        if (!el) throw new Error('Element not found: context-menu-delete');
        (el as HTMLElement).click();
      });
      await page.waitForSelector('[data-testid="context-menu-delete-confirm"]', { timeout: TIMEOUTS.DIALOG });
      const confirmBtn = await page.$('[data-testid="context-menu-delete-confirm"]');
      expect(confirmBtn).toBeTruthy();
      // Second click actually deletes
      await page.evaluate(() => {
        const el = document.querySelector('[data-testid="context-menu-delete-confirm"]');
        if (!el) throw new Error('Element not found: context-menu-delete-confirm');
        (el as HTMLElement).click();
      });
      await page.waitForFunction(
        (id: string) => !document.querySelector(`[data-testid="session-stat-card-${id}"]`),
        { timeout: TIMEOUTS.DASHBOARD },
        confirmId
      );
    } catch (err) {
      // Clean up on test failure
      await deleteSessionViaApi(confirmId);
      throw err;
    }
  });

  it('should display metrics after container ready', { retry: 2 }, async () => {
    const session = await createSessionViaApi({ agentType: 'bash' });
    const metricsId = session.id;
    try {
      // Start container via API and wait for ready
      await startContainerViaApi(metricsId);
      await navigateToDashboard(page);
      // Navigate to session view to trigger waitForContainerReady in page context
      await page.waitForFunction(
        (id: string) => !!document.querySelector(`[data-testid="session-stat-card-${id}"]`),
        { timeout: TIMEOUTS.SESSION_CARD, polling: TIMEOUTS.CONTAINER_POLL_INTERVAL },
        metricsId
      );
      // Wait for metrics to appear on the card (collectMetrics pushes every 5s)
      await page.waitForFunction(
        (id: string) => {
          const cpu = document.querySelector(`[data-testid="session-stat-card-${id}-metric-cpu"]`);
          return cpu !== null;
        },
        { timeout: TIMEOUTS.TERMINAL_READY, polling: TIMEOUTS.CONTAINER_POLL_INTERVAL },
        metricsId
      );
      const cpu = await page.$(`[data-testid="session-stat-card-${metricsId}-metric-cpu"]`);
      expect(cpu).toBeTruthy();
    } finally {
      await deleteSessionViaApi(metricsId);
    }
  });
});
