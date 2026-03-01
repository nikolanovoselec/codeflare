import puppeteer, { Browser, HTTPRequest, Page } from 'puppeteer';
import { afterEach } from 'vitest';
import { apiRequest, BASE_URL } from './setup';
import { IS_MOBILE, SUITE_PREFIX, TIMEOUTS } from './config';

const CF_ACCESS_CLIENT_ID = process.env.CF_ACCESS_CLIENT_ID!;
const CF_ACCESS_CLIENT_SECRET = process.env.CF_ACCESS_CLIENT_SECRET!;
const SERVICE_AUTH_SECRET = process.env.CF_ACCESS_CLIENT_SECRET!;

/** Workspace-relative directory for E2E failure artifacts (screenshots, HTML dumps). */
const E2E_ARTIFACTS_DIR = new URL('../e2e-artifacts', import.meta.url).pathname;

/** Extract origin from BASE_URL for request interception scope check. */
const BASE_ORIGIN = new URL(BASE_URL).origin;

export async function launchBrowser(): Promise<Browser> {
  return puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });
}

export async function createPage(browser: Browser): Promise<Page> {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });

  // Set extra HTTP headers — needed for API fetch calls made within the page context
  // (e.g. waitForContainerReady's page.waitForFunction that calls fetch()).
  await page.setExtraHTTPHeaders({
    'CF-Access-Client-Id': CF_ACCESS_CLIENT_ID,
    'CF-Access-Client-Secret': CF_ACCESS_CLIENT_SECRET,
    'X-Service-Auth': SERVICE_AUTH_SECRET,
  });

  // Request interception: inject CF Access service token headers on EVERY request,
  // including redirect targets. setExtraHTTPHeaders may not survive CF Access 302
  // redirects, but request interception catches each request individually.
  await page.setRequestInterception(true);
  page.on('request', (request: HTTPRequest) => {
    const url = request.url();
    // Only inject auth headers for requests to our app's origin.
    // Third-party requests (e.g. CF Access login page assets) should not get our tokens.
    if (url.startsWith(BASE_ORIGIN)) {
      const headers = request.headers();
      request.continue({
        headers: {
          ...headers,
          'CF-Access-Client-Id': CF_ACCESS_CLIENT_ID,
          'CF-Access-Client-Secret': CF_ACCESS_CLIENT_SECRET,
          'X-Service-Auth': SERVICE_AUTH_SECRET,
        },
      });
    } else {
      request.continue();
    }
  });

  // Disable CSS animations/transitions in CI to prevent "not clickable" failures
  // from panel slide-in animations and other CSS transitions.
  await page.evaluateOnNewDocument(() => {
    const style = document.createElement('style');
    style.innerHTML = '*, *::before, *::after { transition: none !important; animation: none !important; scroll-behavior: auto !important; }';
    document.head.appendChild(style);
  });
  return page;
}

export async function createMobilePage(browser: Browser): Promise<Page> {
  const page = await createPage(browser);
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1');
  return page;
}

export async function createTestPage(browser: Browser): Promise<Page> {
  return IS_MOBILE ? createMobilePage(browser) : createPage(browser);
}

export async function navigateToDashboard(page: Page): Promise<void> {
  await page.goto(BASE_URL, { waitUntil: 'networkidle2' });
  try {
    await page.waitForSelector('[data-testid="dashboard"], [data-testid="dashboard-floating-panel"]', { timeout: TIMEOUTS.DASHBOARD });
  } catch (err) {
    const html = await page.content();
    console.error('[E2E] navigateToDashboard failed — page content (first 500 chars):\n', html.slice(0, 500));
    await page.screenshot({ path: `${E2E_ARTIFACTS_DIR}/e2e-navigate-fail-${Date.now()}.png`, fullPage: true });
    throw err;
  }
}

export async function navigateToSessionView(page: Page, sessionId: string): Promise<void> {
  // Verify session exists via direct GET (avoids KV list eventual consistency).
  // Retry up to TIMEOUTS.KV_PROPAGATION_RETRIES times with TIMEOUTS.KV_PROPAGATION_INTERVAL intervals.
  let verified = false;
  for (let attempt = 0; attempt < TIMEOUTS.KV_PROPAGATION_RETRIES; attempt++) {
    const res = await apiRequest(`/api/sessions/${sessionId}`);
    if (res.ok) {
      verified = true;
      console.log(`[E2E] navigateToSessionView: session ${sessionId} verified on attempt ${attempt + 1}`);
      break;
    }
    console.log(`[E2E] navigateToSessionView: session ${sessionId} not found (attempt ${attempt + 1}/${TIMEOUTS.KV_PROPAGATION_RETRIES}, status ${res.status})`);
    await new Promise(r => setTimeout(r, TIMEOUTS.KV_PROPAGATION_INTERVAL));
  }
  if (!verified) {
    throw new Error(`[E2E] navigateToSessionView: session ${sessionId} not found after ${TIMEOUTS.KV_PROPAGATION_RETRIES} retries (KV propagation timeout)`);
  }

  // Navigate to dashboard and wait for our specific session card.
  // Dashboard polls sessions every 5s, so card should appear within a few polls.
  // Retry with page reload if card doesn't appear (handles KV list eventual consistency).
  const cardSelector = `[data-testid="session-stat-card-${sessionId}"]`;
  let cardFound = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    await navigateToDashboard(page);
    cardFound = await page.waitForFunction(
      (sel: string) => !!document.querySelector(sel),
      { timeout: TIMEOUTS.SESSION_CARD, polling: TIMEOUTS.CONTAINER_POLL_INTERVAL },
      cardSelector
    ).then(() => true).catch(() => false);
    if (cardFound) break;
    console.log(`[E2E] navigateToSessionView: card for ${sessionId} not found on dashboard (attempt ${attempt + 1}/3), reloading...`);
  }
  if (!cardFound) {
    const allCards = await page.evaluate(() => {
      const cards = document.querySelectorAll('[data-testid^="session-stat-card-"]');
      return Array.from(cards).map(c => c.getAttribute('data-testid'));
    });
    throw new Error(`[E2E] navigateToSessionView: card for ${sessionId} not found after 3 page loads. Cards on page: ${JSON.stringify(allCards)}`);
  }

  // Use evaluate click for mobile hit-test reliability (card may be positioned differently
  // at 390px viewport or partially obscured by stacked layout)
  await page.evaluate((sel: string) => {
    (document.querySelector(sel) as HTMLElement)?.click();
  }, cardSelector);
  // Could land on either init progress (stopped session) or terminal view (running session)
  const firstElement = await page.waitForSelector(
    '[data-testid="init-progress-open-btn"], [data-testid="header-logo"]',
    { timeout: TIMEOUTS.SESSION_NAV }
  );
  if (firstElement) {
    const testId = await page.evaluate(el => el?.getAttribute('data-testid'), firstElement);
    if (testId === 'init-progress-open-btn') {
      await page.evaluate(() => {
        (document.querySelector('[data-testid="init-progress-open-btn"]') as HTMLElement)?.click();
      });
      await page.waitForSelector('[data-testid="header-logo"]', { timeout: TIMEOUTS.TERMINAL_READY });
    }
  }
}

export async function checkSetupComplete(): Promise<boolean> {
  const res = await apiRequest('/api/setup/status');
  if (!res.ok) return false;
  const data = await res.json();
  return data.configured === true;
}

export function registerScreenshotOnFailure(getPage: () => Page | null): void {
  afterEach(async (ctx) => {
    if (ctx.task.result?.state === 'fail') {
      const page = getPage();
      if (page) {
        const name = ctx.task.name.replace(/[^a-z0-9]/gi, '-').toLowerCase();
        const timestamp = Date.now();
        const fs = await import('fs');
        fs.mkdirSync(E2E_ARTIFACTS_DIR, { recursive: true });
        await page.screenshot({ path: `${E2E_ARTIFACTS_DIR}/e2e-fail-${name}-${timestamp}.png`, fullPage: true });
        // Dump page URL and HTML content for diagnostics
        try {
          const url = page.url();
          const html = await page.content();
          const diagnostics = `<!-- E2E Failure Diagnostics -->\n<!-- URL: ${url} -->\n<!-- Timestamp: ${new Date(timestamp).toISOString()} -->\n${html.slice(0, 2000)}`;
          fs.writeFileSync(`${E2E_ARTIFACTS_DIR}/e2e-fail-${name}-${timestamp}.html`, diagnostics);
        } catch {
          // Non-fatal: screenshot is primary, HTML dump is bonus
        }
      }
    }
  });
}

export async function createSessionViaApi(opts?: { name?: string; agentType?: string }): Promise<{ id: string; name: string }> {
  const body: Record<string, string> = {};
  body.name = opts?.name || `${SUITE_PREFIX}-Terminal`;
  if (opts?.agentType) body.agentType = opts.agentType;
  // Retry on 429 with increasing backoff (rate limit window is 60s)
  for (let attempt = 0; attempt < 8; attempt++) {
    const res = await apiRequest('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 429) {
      const delay = Math.min((attempt + 1) * 15_000, 60_000); // 15s, 30s, 45s, 60s, 60s, 60s, 60s, 60s
      console.log(`[E2E] createSessionViaApi: rate limited (429), retry in ${delay}ms (attempt ${attempt + 1}/8)`);
      await new Promise(r => setTimeout(r, delay));
      continue;
    }
    if (!res.ok) throw new Error(`Failed to create session: ${res.status}`);
    const data = await res.json();
    return { id: data.session.id, name: data.session.name };
  }
  throw new Error('Failed to create session: rate limited after 8 retries');
}

export async function deleteSessionViaApi(id: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await apiRequest(`/api/sessions/${id}`, { method: 'DELETE' });
    if (res.status === 429) {
      const delay = (attempt + 1) * 5000;
      console.log(`[E2E] deleteSessionViaApi: rate limited (429), retry in ${delay}ms (attempt ${attempt + 1}/3)`);
      await new Promise(r => setTimeout(r, delay));
      continue;
    }
    return;
  }
  console.warn(`[E2E] deleteSessionViaApi: rate limited after 3 retries for ${id}`);
}

export async function deleteAllSessionsViaApi(): Promise<void> {
  const res = await apiRequest('/api/sessions');
  if (!res.ok) return;
  const data = await res.json();
  const sessions = data.sessions;
  if (!Array.isArray(sessions)) return;
  // Delete sequentially with small delays to avoid 429 rate limiting
  for (const s of sessions) {
    await deleteSessionViaApi(s.id);
    await new Promise(r => setTimeout(r, 500));
  }
}

export async function startContainerViaApi(sessionId: string): Promise<void> {
  const res = await apiRequest(`/api/container/start?sessionId=${sessionId}`, { method: 'POST' });
  if (!res.ok) throw new Error(`Failed to start container: ${res.status}`);
}

export async function waitForContainerReady(page: Page, sessionId: string): Promise<void> {
  const baseUrl = BASE_URL;
  const clientId = CF_ACCESS_CLIENT_ID;
  const clientSecret = CF_ACCESS_CLIENT_SECRET;
  const serviceAuth = SERVICE_AUTH_SECRET;

  await page.waitForFunction(
    async (url: string, sid: string, cfId: string, cfSecret: string, svcAuth: string) => {
      try {
        const res = await fetch(`${url}/api/container/startup-status?sessionId=${sid}`, {
          headers: {
            'CF-Access-Client-Id': cfId,
            'CF-Access-Client-Secret': cfSecret,
            'X-Service-Auth': svcAuth,
            'X-Requested-With': 'fetch',
          },
        });
        if (!res.ok) return false;
        const data = await res.json();
        return data.stage === 'ready';
      } catch {
        return false;
      }
    },
    { timeout: TIMEOUTS.CONTAINER_STARTUP, polling: TIMEOUTS.CONTAINER_POLL_INTERVAL },
    baseUrl,
    sessionId,
    clientId,
    clientSecret,
    serviceAuth
  );
}

export async function stopSessionViaApi(sessionId: string): Promise<void> {
  await apiRequest(`/api/sessions/${sessionId}/stop`, { method: 'POST' });
}

export async function setPreference(key: string, value: unknown): Promise<void> {
  const res = await apiRequest('/api/preferences', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ [key]: value }),
  });
  if (!res.ok) throw new Error(`Failed to set preference ${key}: ${res.status}`);
}

export async function waitForContainerReadyViaApi(
  sessionId: string,
  timeoutMs: number = TIMEOUTS.CONTAINER_STARTUP
): Promise<{ elapsed: number; stage: string }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await apiRequest(`/api/container/startup-status?sessionId=${sessionId}`);
    if (!res.ok) {
      await new Promise(r => setTimeout(r, TIMEOUTS.CONTAINER_POLL_INTERVAL));
      continue;
    }
    const data = await res.json();
    if (data.stage === 'ready') return { elapsed: Date.now() - start, stage: 'ready' };
    if (data.stage === 'error') throw new Error(`Container startup error for ${sessionId}: ${data.error || data.message}`);
    await new Promise(r => setTimeout(r, TIMEOUTS.CONTAINER_POLL_INTERVAL));
  }
  throw new Error(`Container ${sessionId} did not reach ready within ${timeoutMs}ms`);
}
