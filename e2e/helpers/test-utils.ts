import puppeteer, { Browser, Page } from 'puppeteer';
import { BASE_URL } from '../config';

/**
 * E2E Test Utilities
 *
 * Additional utilities for E2E testing with Puppeteer.
 * Extends the base helpers with container-specific and journey-specific functions.
 */

// Re-export BASE_URL for consumers that import it from here
export { BASE_URL } from '../config';
export const TEST_EMAIL = 'user@example.com';

// Timeouts
export const TIMEOUTS = {
  DEFAULT: 30000,
  CONTAINER_INIT: 150000,  // 2.5 minutes for container startup
  SESSION_CREATE: 60000,   // 1 minute for session creation
  TERMINAL_CONNECT: 45000, // 45 seconds for terminal connection
  NETWORK: 10000,          // 10 seconds for network requests
} as const;

/**
 * Create a new browser instance with default settings
 */
export async function createBrowser(): Promise<Browser> {
  return puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  });
}

/**
 * Login using DEV_MODE bypass
 * DEV_MODE=true in wrangler.toml allows auth bypass with SERVICE_TOKEN_EMAIL
 */
export async function loginWithDevMode(page: Page): Promise<void> {
  // Set CF Access header to simulate authenticated user
  await page.setExtraHTTPHeaders({
    'CF-Access-Authenticated-User-Email': TEST_EMAIL,
  });

  await page.goto(BASE_URL, { waitUntil: 'networkidle2' });

  // Wait for either dashboard or setup wizard
  await page.waitForSelector('[data-testid="header-logo"], [data-testid="setup-wizard"], .setup-wizard', {
    timeout: TIMEOUTS.DEFAULT,
  });
}

/**
 * Wait for container to become ready (running status)
 * Polls session status until container shows "running" or timeout
 */
export async function waitForContainerReady(page: Page, timeout: number = TIMEOUTS.CONTAINER_INIT): Promise<boolean> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    // Check for running status badge
    const isRunning = await page.evaluate(() => {
      const badge = document.querySelector('.session-status-badge[data-status="success"]');
      const statusText = badge?.textContent?.toLowerCase() || '';
      return statusText.includes('running') || statusText.includes('live');
    });

    if (isRunning) {
      // Verify metrics are showing (indicates container is truly ready)
      const hasMetrics = await page.evaluate(() => {
        return !!document.querySelector('.session-card-metrics');
      });

      if (hasMetrics) {
        return true;
      }
    }

    // Check if init progress is complete
    const progressComplete = await page.evaluate(() => {
      const progress = document.querySelector('[data-testid="init-progress"]');
      if (!progress) return true; // No progress = either complete or not started
      const text = progress.textContent?.toLowerCase() || '';
      return text.includes('ready') || text.includes('complete');
    });

    if (progressComplete) {
      return true;
    }

    // Wait before next check
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  return false;
}

/**
 * Wait for terminal tabs to be available
 */
export async function waitForTerminalTabs(page: Page, timeout: number = TIMEOUTS.TERMINAL_CONNECT): Promise<boolean> {
  try {
    await page.waitForSelector('[data-testid="terminal-tabs"]', {
      visible: true,
      timeout,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the current session count
 */
export async function getSessionCount(page: Page): Promise<number> {
  const cards = await page.$$('[data-testid^="session-card-"]');
  return cards.length;
}

/**
 * Get the current terminal tab count
 */
export async function getTerminalTabCount(page: Page): Promise<number> {
  const tabs = await page.$$('[data-testid^="terminal-tab-"]:not([data-testid="terminal-tab-add"])');
  return tabs.length;
}

/**
 * Create a new session and return its ID
 */
export async function createSession(page: Page): Promise<string | null> {
  // Find create session button
  const createButton = await page.$('[data-testid="empty-state-action"], .session-list-header button, [aria-label*="create" i]');

  if (!createButton) {
    return null;
  }

  const countBefore = await getSessionCount(page);

  await createButton.click();

  // Wait for new session to appear
  await new Promise(resolve => setTimeout(resolve, 3000));

  const countAfter = await getSessionCount(page);

  if (countAfter > countBefore) {
    // Get the newest session's ID
    const cards = await page.$$('[data-testid^="session-card-"]');
    if (cards.length > 0) {
      const sessionId = await page.evaluate(
        (el) => el.getAttribute('data-session-id') || el.getAttribute('data-testid')?.replace('session-card-', ''),
        cards[0]
      );
      return sessionId;
    }
  }

  return null;
}

/**
 * Select a session by clicking on its card
 */
export async function selectSession(page: Page, sessionId?: string): Promise<boolean> {
  const selector = sessionId
    ? `[data-session-id="${sessionId}"], [data-testid="session-card-${sessionId}"]`
    : '[data-testid^="session-card-"]';

  const card = await page.$(selector);

  if (!card) {
    return false;
  }

  await card.click();
  await new Promise(resolve => setTimeout(resolve, 500));

  return true;
}

/**
 * Delete a session
 */
export async function deleteSession(page: Page, sessionId: string): Promise<boolean> {
  // Find the session card
  const card = await page.$(`[data-session-id="${sessionId}"], [data-testid="session-card-${sessionId}"]`);

  if (!card) {
    return false;
  }

  // Hover to reveal action buttons
  await card.hover();
  await new Promise(resolve => setTimeout(resolve, 300));

  // Find and click delete button
  const deleteBtn = await page.$(`[data-testid="${sessionId}-delete-btn"], [data-testid$="-delete-btn"]`);

  if (!deleteBtn) {
    return false;
  }

  await deleteBtn.click();

  // Handle confirmation dialog
  const confirmBtn = await page.$('[data-testid="confirm-delete-btn"]');
  if (confirmBtn) {
    await confirmBtn.click();
  }

  // Wait for deletion
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Verify session is gone
  const sessionStillExists = await page.$(`[data-session-id="${sessionId}"]`);
  return !sessionStillExists;
}

/**
 * Switch to a specific terminal tab
 */
export async function switchToTerminalTab(page: Page, tabIndex: number): Promise<boolean> {
  const tabs = await page.$$('[data-testid^="terminal-tab-"]:not([data-testid="terminal-tab-add"])');

  if (tabIndex >= tabs.length) {
    return false;
  }

  await tabs[tabIndex].click();
  await new Promise(resolve => setTimeout(resolve, 300));

  // Verify tab is active
  const isActive = await page.evaluate(
    (el) => el.classList.contains('terminal-tab--active'),
    tabs[tabIndex]
  );

  return isActive;
}

/**
 * Add a new terminal tab
 */
export async function addTerminalTab(page: Page): Promise<boolean> {
  const countBefore = await getTerminalTabCount(page);

  const addButton = await page.$('[data-testid="terminal-tab-add"]');
  if (!addButton) {
    return false;
  }

  // Check if button is disabled
  const isDisabled = await page.evaluate((el) => (el as HTMLButtonElement).disabled, addButton);
  if (isDisabled) {
    return false; // At max tabs
  }

  await addButton.click();
  await new Promise(resolve => setTimeout(resolve, 500));

  const countAfter = await getTerminalTabCount(page);
  return countAfter > countBefore;
}

/**
 * Enable tiling mode with specified layout
 */
export async function enableTiling(page: Page, layout: 'tabbed' | '2-split' | '3-split' | '4-grid'): Promise<boolean> {
  const tilingButton = await page.$('[data-testid="tiling-button"]');
  if (!tilingButton) {
    return false;
  }

  await tilingButton.click();

  try {
    await page.waitForSelector('[data-testid="tiling-overlay"]', { timeout: 3000 });
  } catch {
    return false;
  }

  const optionSelector = `[data-testid="tiling-option-${layout}"]`;
  const option = await page.$(optionSelector);

  if (!option) {
    // Close overlay
    const backdrop = await page.$('[data-testid="tiling-overlay-backdrop"]');
    if (backdrop) await backdrop.click();
    return false;
  }

  await option.click();
  await new Promise(resolve => setTimeout(resolve, 500));

  return true;
}

/**
 * Check if app is showing main dashboard or setup wizard
 */
export async function isMainAppAvailable(page: Page): Promise<boolean> {
  const hasHeader = await page.evaluate(() => {
    return !!document.querySelector('[data-testid="header-logo"]');
  });
  return hasHeader;
}

/**
 * Make an API request and return response details
 */
export async function apiRequest(
  page: Page,
  path: string,
  options: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {}
): Promise<{
  status: number;
  body: unknown;
  headers: Record<string, string>;
}> {
  return page.evaluate(async (baseUrl, requestPath, opts) => {
    const res = await fetch(`${baseUrl}${requestPath}`, {
      method: opts.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(opts.headers || {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });

    let body;
    try {
      body = await res.json();
    } catch {
      try {
        body = await res.text();
      } catch {
        body = null;
      }
    }

    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      headers[key] = value;
    });

    return {
      status: res.status,
      body,
      headers,
    };
  }, BASE_URL, path, options);
}

/**
 * Take a screenshot for debugging
 */
export async function takeDebugScreenshot(page: Page, name: string): Promise<void> {
  const timestamp = Date.now();
  const filename = `/tmp/e2e-debug-${name}-${timestamp}.png`;

  await page.screenshot({
    path: filename,
    fullPage: true,
  });

  console.log(`Debug screenshot saved: ${filename}`);
}

/**
 * Wait for a specific API response
 */
export async function waitForApiResponse(
  page: Page,
  urlPattern: string | RegExp,
  timeout: number = TIMEOUTS.NETWORK
): Promise<{ status: number; body: unknown } | null> {
  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      page.off('response', handler);
      resolve(null);
    }, timeout);

    const handler = async (response: { url: () => string; status: () => number; json: () => Promise<unknown> }) => {
      const url = response.url();
      const matches = typeof urlPattern === 'string'
        ? url.includes(urlPattern)
        : urlPattern.test(url);

      if (matches) {
        clearTimeout(timeoutId);
        page.off('response', handler);

        try {
          const body = await response.json();
          resolve({ status: response.status(), body });
        } catch {
          resolve({ status: response.status(), body: null });
        }
      }
    };

    page.on('response', handler);
  });
}

/**
 * Cleanup a session via API
 * Used in afterAll hooks to clean up sessions created during tests
 */
export async function cleanupSession(sessionId: string): Promise<void> {
  try {
    await fetch(`${BASE_URL}/api/sessions/${sessionId}`, {
      method: 'DELETE',
      headers: { 'CF-Access-Authenticated-User-Email': TEST_EMAIL },
    });
  } catch (e) {
    console.warn(`Failed to cleanup session ${sessionId}:`, e);
  }
}

/**
 * Cleanup multiple sessions via API
 * Used in afterAll hooks to clean up sessions created during tests
 */
export async function cleanupSessions(sessionIds: string[]): Promise<void> {
  for (const sessionId of sessionIds) {
    await cleanupSession(sessionId);
  }
}

/**
 * Cleanup ALL sessions via API
 * Used in global afterAll to ensure clean state after E2E test run
 * IMPORTANT: Call this at the end of E2E test suite to avoid leftover sessions
 */
export async function cleanupAllSessions(): Promise<{ deleted: number; failed: number }> {
  let deleted = 0;
  let failed = 0;

  try {
    // Fetch all sessions
    const response = await fetch(`${BASE_URL}/api/sessions`, {
      method: 'GET',
      headers: { 'CF-Access-Authenticated-User-Email': TEST_EMAIL },
    });

    if (!response.ok) {
      console.warn(`Failed to fetch sessions for cleanup: ${response.status}`);
      return { deleted, failed };
    }

    const data = await response.json() as { sessions?: Array<{ id: string; name: string }> };
    const sessions = data.sessions || [];

    console.log(`[E2E Cleanup] Found ${sessions.length} sessions to clean up`);

    // Delete each session
    for (const session of sessions) {
      try {
        const deleteResponse = await fetch(`${BASE_URL}/api/sessions/${session.id}`, {
          method: 'DELETE',
          headers: { 'CF-Access-Authenticated-User-Email': TEST_EMAIL },
        });

        if (deleteResponse.ok) {
          deleted++;
          console.log(`[E2E Cleanup] Deleted session: ${session.name} (${session.id})`);
        } else {
          failed++;
          console.warn(`[E2E Cleanup] Failed to delete session ${session.id}: ${deleteResponse.status}`);
        }
      } catch (e) {
        failed++;
        console.warn(`[E2E Cleanup] Error deleting session ${session.id}:`, e);
      }
    }

    console.log(`[E2E Cleanup] Complete: ${deleted} deleted, ${failed} failed`);
  } catch (e) {
    console.error('[E2E Cleanup] Failed to cleanup sessions:', e);
  }

  return { deleted, failed };
}

/**
 * Restore the setup:complete flag in KV
 * IMPORTANT: Call this after any test that resets setup state
 * Prevents production setup wizard from appearing after E2E tests
 */
export async function restoreSetupComplete(): Promise<boolean> {
  try {
    // We can't directly write to KV from tests, but we can use a special endpoint
    // The setup-wizard.test.ts resets setup state, so we need to restore it

    // Option 1: Call configure endpoint (requires valid token - won't work in tests)
    // Option 2: Add a restore endpoint that only works in DEV_MODE

    // For now, we'll make a POST to a restore endpoint
    const response = await fetch(`${BASE_URL}/api/setup/restore-for-tests`, {
      method: 'POST',
      headers: { 'CF-Access-Authenticated-User-Email': TEST_EMAIL },
    });

    if (response.ok) {
      console.log('[E2E] Restored setup:complete flag');
      return true;
    } else {
      console.warn(`[E2E] Failed to restore setup:complete: ${response.status}`);
      return false;
    }
  } catch (e) {
    console.error('[E2E] Error restoring setup:complete:', e);
    return false;
  }
}
