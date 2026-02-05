import puppeteer, { Browser, Page, LaunchOptions } from 'puppeteer';

/**
 * Base URL for the web UI
 * Constructed from ACCOUNT_SUBDOMAIN + CLOUDFLARE_WORKER_NAME
 */
import { BASE_URL } from '../config';
export { BASE_URL };

/**
 * Default timeout for page operations (ms)
 */
export const DEFAULT_TIMEOUT = 30000;

/**
 * Default Puppeteer launch options
 */
const defaultLaunchOptions: LaunchOptions = {
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
  ],
};

/**
 * Launch a new browser instance
 */
export async function launchBrowser(
  options: LaunchOptions = {}
): Promise<Browser> {
  const browser = await puppeteer.launch({
    ...defaultLaunchOptions,
    ...options,
  });
  return browser;
}

/**
 * DEV_MODE email for bypassing CF Access auth
 */
const DEV_MODE_EMAIL = 'user@example.com';

/**
 * Create a new page with default settings
 * Sets up headers to simulate authenticated user in DEV_MODE
 */
export async function createPage(browser: Browser): Promise<Page> {
  const page = await browser.newPage();

  // Set default viewport
  await page.setViewport({
    width: 1280,
    height: 720,
  });

  // Set default timeout
  page.setDefaultTimeout(DEFAULT_TIMEOUT);

  // Set headers to simulate CF Access auth in DEV_MODE
  await page.setExtraHTTPHeaders({
    'CF-Access-Authenticated-User-Email': DEV_MODE_EMAIL,
  });

  return page;
}

/**
 * Navigate to a path on the base URL
 */
export async function navigateTo(page: Page, path: string = '/'): Promise<void> {
  const url = `${BASE_URL}${path}`;
  await page.goto(url, {
    waitUntil: 'networkidle2',
  });
}

/**
 * Navigate to the home page
 */
export async function navigateToHome(page: Page): Promise<void> {
  await navigateTo(page, '/');
}

/**
 * Wait for the app to be ready (initial load complete)
 */
export async function waitForAppReady(page: Page): Promise<void> {
  // Wait for the main app container to be visible
  await page.waitForSelector('[data-testid="app-root"], #root', {
    visible: true,
    timeout: DEFAULT_TIMEOUT,
  });
}

/**
 * Take a screenshot for debugging
 */
export async function takeScreenshot(
  page: Page,
  name: string
): Promise<Uint8Array> {
  const screenshot = await page.screenshot({
    fullPage: true,
  });
  return screenshot;
}

/**
 * Check if setup is complete and main app is accessible
 * Returns true if we're on the main app, false if we're on setup wizard
 *
 * Note: The header is hidden on the dashboard view, so we also check
 * for the dashboard floating panel to detect the main app.
 */
export async function isMainAppAvailable(page: Page): Promise<boolean> {
  // Check if we have the header (terminal view) or dashboard (landing page) vs setup wizard
  const hasMainApp = await page.evaluate(() => {
    return !!(
      document.querySelector('[data-testid="header-logo"]') ||
      document.querySelector('[data-testid="dashboard"]') ||
      document.querySelector('[data-testid="dashboard-floating-panel"]')
    );
  });
  return hasMainApp;
}

/**
 * Wait for either main app or setup wizard to be ready
 * Returns 'main' if on main app, 'setup' if on setup wizard
 */
export async function waitForAppOrSetup(page: Page): Promise<'main' | 'setup'> {
  await page.waitForSelector('[data-testid="header-logo"], [data-testid="dashboard"], [data-testid="dashboard-floating-panel"], [data-testid="setup-wizard"], .setup-wizard, .wizard-container', {
    visible: true,
    timeout: DEFAULT_TIMEOUT,
  });

  const isMain = await isMainAppAvailable(page);
  return isMain ? 'main' : 'setup';
}

/**
 * Wait for the dashboard to be ready
 * Use this when navigating to home with no active session
 */
export async function waitForDashboardReady(page: Page): Promise<void> {
  await page.waitForSelector('[data-testid="dashboard-floating-panel"]', {
    visible: true,
    timeout: DEFAULT_TIMEOUT,
  });
}
