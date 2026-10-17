import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareChromeTimeouts } from '../patch-chrome-devtools-timeouts.mjs';

// CI supplies the exact locked SDK tree and a test-only Chromium executable.
// No package resolution, browser download, Cloudflare request or server is needed.
test('REQ-BROWSER-009 AC3: the real Chrome SDK applies six-minute page and remote protocol defaults', { timeout: 60_000 }, async t => {
  assert.ok(process.env.CHROME_SDK_ROOT, 'CI must supply the locked Chrome SDK tree');
  assert.ok(process.env.CI_CHROMIUM_EXECUTABLE, 'CI must supply its Chromium executable');
  const root = resolve(process.env.CHROME_SDK_ROOT);
  // The same guarded image transformation, including safe repeated preparation.
  prepareChromeTimeouts(root);
  prepareChromeTimeouts(root);
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
  let manager;
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

    // Attach through the actual SDK's public remote-browser boundary. A public
    // CDP evaluation that never resolves observes Puppeteer's default deadline;
    // only the platform clock is accelerated, not the CDP implementation.
    const { BrowserManager } = await import(pathToFileURL(resolve(root, 'build/src/BrowserManager.js')).href);
    manager = new BrowserManager({ wsEndpoint: browser.wsEndpoint() });
    const remote = await manager.ensureBrowser();
    const [remotePage] = await remote.pages();
    const cdp = await remotePage.createCDPSession();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let settled = false;
    const outcome = cdp.send('Runtime.evaluate', { expression: 'new Promise(() => {})', awaitPromise: true })
      .then(() => { settled = true; return undefined; }, error => { settled = true; return error; });
    t.mock.timers.tick(359999);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false, 'remote CDP must not retain the upstream three-minute deadline');
    t.mock.timers.tick(1);
    const error = await outcome;
    assert.match(error?.message ?? '', /Runtime\.evaluate timed out/);
    t.mock.timers.reset();
    await cdp.detach();
  } finally {
    t.mock.timers.reset();
    try { await manager?.close(); await wrapper?.dispose(); }
    finally { await browser.close(); }
  }
});
