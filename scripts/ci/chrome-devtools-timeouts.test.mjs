import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// CI supplies the exact locked SDK tree and a test-only Chromium executable.
// No package resolution, browser download, Cloudflare request or server is needed.
test('REQ-BROWSER-006 AC8: the real Chrome SDK applies six-minute page defaults', { timeout: 60_000 }, async () => {
  assert.ok(process.env.CHROME_SDK_ROOT, 'CI must supply the locked Chrome SDK tree');
  assert.ok(process.env.CI_CHROMIUM_EXECUTABLE, 'CI must supply its Chromium executable');
  const root = resolve(process.env.CHROME_SDK_ROOT);
  const { McpPage } = await import(pathToFileURL(resolve(root, 'build/src/McpPage.js')).href);
  const { puppeteer, Locator } = await import(pathToFileURL(resolve(root, 'build/src/third_party/index.js')).href);
  const browser = await puppeteer.launch({
    executablePath: process.env.CI_CHROMIUM_EXECUTABLE,
    headless: true,
    // Disposable CI-only blank page: no credentials, user profile or remote navigation.
    // This does not alter the operational Browser Run browser's sandbox policy.
    args: ['--no-sandbox'],
    timeout: 30_000,
  });
  let wrapper;
  try {
    const page = await browser.newPage();
    wrapper = new McpPage(page, 1, {
      locatorClass: Locator,
      hasNetworkBlockOrAllowlist: false,
      // Omit navigationTimeout: observe the SDK default, not a test override.
    });
    wrapper.updateTimeouts();
    assert.deepEqual([page.getDefaultTimeout(), page.getDefaultNavigationTimeout()], [360_000, 360_000]);

    // Page selection/emulation reapplies these defaults, not a one-off mutation.
    page.setDefaultTimeout(1);
    page.setDefaultNavigationTimeout(2);
    wrapper.updateTimeouts();
    assert.deepEqual([page.getDefaultTimeout(), page.getDefaultNavigationTimeout()], [360_000, 360_000]);
  } finally {
    try { await wrapper?.dispose(); }
    finally { await browser.close(); }
  }
});
