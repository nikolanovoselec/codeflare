import puppeteer, { Browser, HTTPRequest, Page } from 'puppeteer';
import { afterEach } from 'vitest';
import { apiRequest, BASE_URL } from './setup';

const CF_ACCESS_CLIENT_ID = process.env.CF_ACCESS_CLIENT_ID!;
const CF_ACCESS_CLIENT_SECRET = process.env.CF_ACCESS_CLIENT_SECRET!;
const SERVICE_AUTH_SECRET = process.env.CF_ACCESS_CLIENT_SECRET!;

/**
 * Exchange CF Access service token headers for a CF_Authorization cookie JWT.
 *
 * CF Access returns a Set-Cookie: CF_Authorization=<JWT> on the initial request
 * when valid service token headers are present. We use `redirect: 'manual'` to
 * capture the 302 response (which carries the Set-Cookie) before any redirect.
 *
 * Returns the JWT string, or null if the cookie was not returned (e.g. local dev
 * without CF Access in front).
 */
async function getCfAccessCookie(baseUrl: string): Promise<string | null> {
  const clientId = process.env.CF_ACCESS_CLIENT_ID;
  const clientSecret = process.env.CF_ACCESS_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.warn('[E2E] CF_ACCESS_CLIENT_ID/SECRET not set — skipping cookie exchange');
    return null;
  }

  try {
    const res = await fetch(baseUrl, {
      redirect: 'manual',
      headers: {
        'CF-Access-Client-Id': clientId,
        'CF-Access-Client-Secret': clientSecret,
      },
    });

    const setCookie = res.headers.get('set-cookie') ?? res.headers.get('Set-Cookie');
    if (!setCookie) {
      console.warn('[E2E] No Set-Cookie header in CF Access response — cookie exchange skipped');
      return null;
    }

    // Set-Cookie may contain multiple cookies separated by commas (or multiple headers).
    // Look for CF_Authorization=<value> in the header.
    const match = setCookie.match(/CF_Authorization=([^;]+)/);
    if (!match) {
      console.warn('[E2E] CF_Authorization cookie not found in Set-Cookie header — cookie exchange skipped');
      return null;
    }

    console.log('[E2E] Successfully exchanged service token for CF_Authorization cookie');
    return match[1];
  } catch (err) {
    console.warn('[E2E] CF Access cookie exchange failed:', err);
    return null;
  }
}

/** Extract hostname from a URL string (e.g. 'https://codeflare.novoselec.ch' -> 'codeflare.novoselec.ch'). */
function extractDomain(url: string): string {
  return new URL(url).hostname;
}

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

  // Exchange service token for CF_Authorization cookie so that page.goto()
  // navigations pass through CF Access without being intercepted by the login page.
  // CF Access evaluates Service Auth policies first, so the cookie carries
  // the service auth identity for subsequent browser requests.
  const cfJwt = await getCfAccessCookie(BASE_URL);
  if (cfJwt) {
    const domain = extractDomain(BASE_URL);
    await page.setCookie({
      name: 'CF_Authorization',
      value: cfJwt,
      domain,
      path: '/',
      httpOnly: true,
      secure: true,
    });
  }

  // Request interception: inject CF Access service token headers on EVERY request,
  // including redirect targets. This is the belt-and-suspenders approach —
  // setExtraHTTPHeaders may not survive CF Access 302 redirects, but request
  // interception catches each request individually before it's sent.
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
  // Verify session exists via direct GET (avoids KV list eventual consistency).
  // Retry up to 10 times with 2s intervals (~20s total) to handle KV propagation delay.
  let verified = false;
  for (let attempt = 0; attempt < 10; attempt++) {
    const res = await apiRequest(`/api/sessions/${sessionId}`);
    if (res.ok) {
      verified = true;
      console.log(`[E2E] navigateToSessionView: session ${sessionId} verified on attempt ${attempt + 1}`);
      break;
    }
    console.log(`[E2E] navigateToSessionView: session ${sessionId} not found (attempt ${attempt + 1}/10, status ${res.status})`);
    await new Promise(r => setTimeout(r, 2000));
  }
  if (!verified) {
    throw new Error(`[E2E] navigateToSessionView: session ${sessionId} not found after 10 retries (KV propagation timeout)`);
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
      { timeout: 20000, polling: 1000 },
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
