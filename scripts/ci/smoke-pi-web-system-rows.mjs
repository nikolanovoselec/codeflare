// CI-only browser coverage of the pinned renderer; no real session or model.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const client = new URL('../../image/pi-web/node_modules/@jmfederico/pi-web/dist/client/', import.meta.url);
const css = await readFile(new URL('../../image/pi-web/codeflare-chrome/browser/footer.css', import.meta.url), 'utf8');
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
  console.log('Stock Chat hides standalone and grouped SYSTEM rows without hiding ordinary messages');
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
