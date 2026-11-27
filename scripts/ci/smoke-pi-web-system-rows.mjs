// CI-only browser coverage of the pinned renderer; no real session or model.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const client = new URL('../../image/pi-web/node_modules/@jmfederico/pi-web/dist/client/', import.meta.url);
const css = await readFile(new URL('../../image/pi-web/codeflare-chrome/browser/footer.css', import.meta.url), 'utf8');
const palette = await readFile(new URL('../../image/pi-web/codeflare-chrome/browser/graphite.css', import.meta.url), 'utf8');
const assets = await readdir(new URL('assets/', client));
const mains = assets.filter(name => /^main-[\w-]+\.js$/.test(name));
assert.equal(mains.length, 1, 'expected one pinned stock client entry');

const fixture = `<!doctype html><title>Pi Web SYSTEM rows</title><body>
<script type="module">
let result;
try {
  await import('/assets/${mains[0]}');
  const chat = document.body.appendChild(document.createElement('chat-view'));
  const line = (role, type, text) => ({ role, parts: [{ type, text }] });
  const messages = [line('user', 'text', 'fixture user'), line('assistant', 'text', 'fixture reply'),
    line('system', 'text', 'fixture saved SYSTEM'), line('system', 'thinking', 'fixture grouped SYSTEM')];
  chat.messages = messages;
  chat.messageTotal = messages.length;
  await chat.updateComplete;
  const root = chat.shadowRoot;
  const group = root.querySelector('details');
  if (!group.open) {
    group.open = true;
    group.dispatchEvent(new Event('toggle'));
    await chat.updateComplete;
  }
  const check = (selector, display) => {
    const rows = [...root.querySelectorAll(selector)];
    if (!rows.length || rows.some(row => (getComputedStyle(row).display !== 'none') !== display)) {
      throw Error(selector + ': expected visible=' + display);
    }
  };
  check('article.msg.system', true);
  check('section.group-msg.system', true);
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(${JSON.stringify(css).replaceAll('<', '\\u003c')});
  root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
  check('article.msg.system', false);
  check('section.group-msg.system', false);
  check('article.msg.user', true);
  check('article.msg.assistant', true);
  const theme = new CSSStyleSheet();
  theme.replaceSync(${JSON.stringify(palette).replaceAll('<', '\\u003c')});
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, theme];
  root.adoptedStyleSheets = [...root.adoptedStyleSheets, theme];
  const surface = document.body.appendChild(document.createElement('div'));
  surface.style.backgroundColor = 'var(--pi-bg)';
  if (getComputedStyle(surface).backgroundColor !== 'rgba(24, 24, 24, 0.2)') throw Error('Graphite base must be 80% transparent');
  const user = getComputedStyle(root.querySelector('article.msg.user'));
  const agent = getComputedStyle(root.querySelector('article.msg.assistant'));
  if (user.backgroundColor === agent.backgroundColor || !(parseFloat(user.borderInlineStartWidth) > parseFloat(agent.borderInlineStartWidth))) {
    throw Error('Codeflare palette must distinguish user messages from agent replies');
  }
  const typeStatus = { model: { id: 'fixture-model', provider: 'fixture' }, thinkingLevel: 'off',
    tokens: { input: 100, output: 30 }, contextUsage: { percent: 5, contextWindow: 2600 }, cost: 0, pendingMessageCount: 0 };
  const composer = document.body.appendChild(document.createElement('prompt-editor'));
  const status = document.body.appendChild(document.createElement('status-bar'));
  composer.status = status.status = typeStatus;
  await Promise.all([composer.updateComplete, status.updateComplete]);
  for (const element of [composer, status]) element.shadowRoot.adoptedStyleSheets = [...element.shadowRoot.adoptedStyleSheets, theme];
  const boundary = root.querySelector('.history-boundary');
  const bodySize = user.fontSize;
  for (const target of [boundary.querySelector('span'), boundary.querySelector('small'),
    composer.shadowRoot.querySelector('.cm-content'), composer.shadowRoot.querySelector('.prompt-placeholder'),
    composer.shadowRoot.querySelector('.select-model'), ...Array.from(status.shadowRoot.querySelectorAll('.bar > span')).slice(0, 3)]) {
    if (!target || getComputedStyle(target).fontSize !== bodySize) throw Error('Chat controls must match the message font size');
  }
  if (!(parseFloat(getComputedStyle(boundary).paddingBlockStart) > 0)) throw Error('Session beginning needs top padding');
  for (const [tag, action, navigation] of [
    ['app-context-bar', 'button.context-action-button:not([data-navigation-trigger])', '[data-navigation-trigger]'],
    ['app-navigation-panel', 'button.actions-button', 'header machine-switcher'],
  ]) {
    const bar = document.body.appendChild(document.createElement(tag));
    if (tag === 'app-navigation-panel') bar.style.inlineSize = '320px';
    bar.onShowActions = () => {};
    bar.onShowNavigation = () => {};
    bar.refreshControl = document.createElement('app-refresh-control');
    await bar.updateComplete;
    const scope = bar.shadowRoot;
    const targets = [scope.querySelector(action), scope.querySelector('app-refresh-control')];
    const visible = node => node && node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0;
    if (!targets.every(visible)) throw Error(tag + ': stock controls missing');
    scope.adoptedStyleSheets = [...scope.adoptedStyleSheets, sheet];
    if (targets.some(visible)) throw Error(tag + ': Actions and Refresh must be completely hidden');
    if (!visible(scope.querySelector(navigation))) throw Error(tag + ': navigation must remain available');
  }
  const live = line('system', 'text', 'fixture live SYSTEM');
  chat.messages = [...messages, live];
  await chat.updateComplete;
  check('article.msg.system', false);
  if (root.querySelectorAll('article.msg.system').length !== 2 || !chat.messages.includes(live)) {
    throw Error('the live SYSTEM entry did not render as a hidden row');
  }
  result = 'pass';
} catch (error) {
  result = 'fail: ' + String(error).slice(0, 500);
}
await fetch('/fixture-result', { method: 'POST', body: result });
</script></body>`;

let reportResult;
const browserResult = new Promise(resolve => { reportResult = resolve; });
let fixtureLoads = 0;
let servedModules = 0;
const server = createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/fixture-result') {
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 2048) { res.writeHead(413).end(); return; }
        chunks.push(chunk);
      }
      res.writeHead(204).end();
      reportResult(Buffer.concat(chunks).toString('utf8'));
    } catch { res.destroy(); }
    return;
  }
  if (req.url === '/') {
    fixtureLoads++;
    res.setHeader('content-type', 'text/html');
    res.end(fixture);
    return;
  }
  const name = /^\/assets\/([\w.-]+\.js)$/.exec(req.url)?.[1];
  if (name && assets.includes(name)) {
    try {
      const bytes = await readFile(new URL(`assets/${name}`, client));
      servedModules++;
      res.setHeader('content-type', 'text/javascript');
      res.end(bytes);
      return;
    } catch { res.writeHead(500).end(); return; }
  }
  res.writeHead(404).end();
});
const profile = await mkdtemp(join(tmpdir(), 'pi-web-system-rows-'));
let browser;
let browserClosed;
let deadline;
let stderr = '';
const diagnostics = () => `document loads=${fixtureLoads}, modules served=${servedModules}; Chromium stderr: ${stderr.trim()}`;
try {
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  browser = spawn(process.env.CI_CHROMIUM_EXECUTABLE, [
    '--headless', '--no-sandbox', '--disable-background-networking', '--no-first-run',
    `--user-data-dir=${profile}`, `http://127.0.0.1:${server.address().port}/`,
  ], { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
  browser.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2400); });
  browserClosed = new Promise(resolve => browser.once('close', (code, signal) => resolve({ code, signal })));
  const result = await Promise.race([
    browserResult,
    browserClosed.then(({ code, signal }) => {
      throw Error(`Chromium exited before the fixture reported (${code ?? signal}); ${diagnostics()}`);
    }),
    new Promise((_, reject) => {
      browser.once('error', reject);
      deadline = setTimeout(() => reject(Error(`Timed out waiting for stock SYSTEM row fixture; ${diagnostics()}`)), 20_000);
    }),
  ]);
  assert.equal(result, 'pass', 'stock SYSTEM row fixture');
  console.log('Stock Chat hides SYSTEM rows and selected header controls and distinguishes user messages');
} finally {
  clearTimeout(deadline);
  if (browser?.pid) {
    try { process.kill(-browser.pid, 'SIGKILL'); }
    catch (error) {
      if (error.code !== 'ESRCH') {
        process.exitCode = 1;
        console.error('Unable to terminate Chromium process group:', error.code);
      }
    }
    let cleanupDeadline;
    try {
      await Promise.race([
        browserClosed,
        new Promise(resolve => { cleanupDeadline = setTimeout(resolve, 2000); }),
      ]);
    } finally {
      clearTimeout(cleanupDeadline);
      browser.stderr.destroy();
      browser.unref();
    }
  }
  server.close();
  await rm(profile, { recursive: true, force: true });
}
