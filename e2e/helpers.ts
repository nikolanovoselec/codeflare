import puppeteer, { Browser, Page } from 'puppeteer';
import { afterEach } from 'vitest';
import { apiRequest, BASE_URL } from './setup';

const CF_ACCESS_CLIENT_ID = process.env.CF_ACCESS_CLIENT_ID!;
const CF_ACCESS_CLIENT_SECRET = process.env.CF_ACCESS_CLIENT_SECRET!;
const SERVICE_AUTH_SECRET = process.env.CF_ACCESS_CLIENT_SECRET!;

export async function launchBrowser(): Promise<Browser> {
  return puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });
}

export async function createPage(browser: Browser): Promise<Page> {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  await page.setExtraHTTPHeaders({
    'CF-Access-Client-Id': CF_ACCESS_CLIENT_ID,
    'CF-Access-Client-Secret': CF_ACCESS_CLIENT_SECRET,
    'X-Service-Auth': SERVICE_AUTH_SECRET,
  });
  return page;
}

export async function navigateToDashboard(page: Page): Promise<void> {
  await page.goto(BASE_URL, { waitUntil: 'networkidle2' });
  try {
    await page.waitForSelector('[data-testid="dashboard"], [data-testid="dashboard-floating-panel"]', { timeout: 15000 });
  } catch (err) {
    const html = await page.content();
    console.error('[E2E] navigateToDashboard failed — page content (first 500 chars):\n', html.slice(0, 500));
    await page.screenshot({ path: `/tmp/e2e-navigate-fail-${Date.now()}.png`, fullPage: true });
    throw err;
  }
}

export async function navigateToSessionView(page: Page, sessionId: string): Promise<void> {
  // Verify session exists via API before navigating
  const verifyRes = await apiRequest('/api/sessions');
  if (verifyRes.ok) {
    const data = await verifyRes.json();
    const ids = (data.sessions || []).map((s: { id: string }) => s.id);
    const found = ids.includes(sessionId);
    console.log(`[E2E] navigateToSessionView: API has ${ids.length} sessions. Target ${sessionId} ${found ? 'FOUND' : 'NOT FOUND'}. IDs: ${JSON.stringify(ids)}`);
    if (!found) {
      throw new Error(`[E2E] navigateToSessionView: session ${sessionId} does not exist in API response`);
    }
  }

  await navigateToDashboard(page);

  // Wait for any session cards to render (SolidJS loads sessions async)
  const hasCards = await page.waitForFunction(
    () => document.querySelectorAll('[data-testid^="session-stat-card-"]').length > 0,
    { timeout: 15000 }
  ).then(() => true).catch(() => false);

  if (!hasCards) {
    // No cards at all — dump page state for debugging
    const pageUrl = page.url();
    const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 500) || '');
    throw new Error(`[E2E] navigateToSessionView: no session cards rendered after 15s. URL: ${pageUrl}. Body: ${bodyText}`);
  }

  // Check if our specific card exists
  const cardSelector = `[data-testid="session-stat-card-${sessionId}"]`;
  const specificCard = await page.$(cardSelector);
  if (!specificCard) {
    const allCards = await page.evaluate(() => {
      const cards = document.querySelectorAll('[data-testid^="session-stat-card-"]');
      return Array.from(cards).map(c => c.getAttribute('data-testid'));
    });
    throw new Error(`[E2E] navigateToSessionView: card for ${sessionId} not found. Cards on page: ${JSON.stringify(allCards)}`);
  }

  await page.click(cardSelector);
  // Could land on either init progress (stopped session) or terminal view (running session)
  const firstElement = await page.waitForSelector(
    '[data-testid="init-progress-open-btn"], [data-testid="header-logo"]',
    { timeout: 90000 }
  );
  if (firstElement) {
    const testId = await page.evaluate(el => el?.getAttribute('data-testid'), firstElement);
    if (testId === 'init-progress-open-btn') {
      await firstElement.click();
      await page.waitForSelector('[data-testid="header-logo"]', { timeout: 30000 });
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
        await page.screenshot({ path: `/tmp/e2e-fail-${name}-${Date.now()}.png`, fullPage: true });
      }
    }
  });
}

export async function createSessionViaApi(opts?: { name?: string; agentType?: string }): Promise<{ id: string; name: string }> {
  const body: Record<string, string> = {};
  if (opts?.name) body.name = opts.name;
  if (opts?.agentType) body.agentType = opts.agentType;
  const res = await apiRequest('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Failed to create session: ${res.status}`);
  const data = await res.json();
  return { id: data.session.id, name: data.session.name };
}

export async function deleteSessionViaApi(id: string): Promise<void> {
  await apiRequest(`/api/sessions/${id}`, { method: 'DELETE' });
}

export async function deleteAllSessionsViaApi(): Promise<void> {
  const res = await apiRequest('/api/sessions');
  if (!res.ok) return;
  const data = await res.json();
  const sessions = data.sessions;
  if (!Array.isArray(sessions)) return;
  await Promise.all(sessions.map((s: { id: string }) => deleteSessionViaApi(s.id)));
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
    { timeout: 60000, polling: 1000 },
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
