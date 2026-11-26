// CI-only browser coverage of the pinned renderer; no real session or model.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const client = new URL('../../image/pi-web/node_modules/@jmfederico/pi-web/dist/client/', import.meta.url);
const css = await readFile(new URL('../../image/pi-web/codeflare-chrome/browser/footer.css', import.meta.url), 'utf8');
const assets = await readdir(new URL('assets/', client));
const mains = assets.filter(name => /^main-[\w-]+\.js$/.test(name));
assert.equal(mains.length, 1, 'expected one pinned stock client entry');

const fixture = `<!doctype html><title>Pi Web SYSTEM rows</title><body data-result="pending">
<script type="module">
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
  document.body.dataset.result = 'pass';
} catch (error) {
  document.body.dataset.result = 'fail';
  document.body.dataset.error = String(error);
}
</script></body>`;

const server = createServer(async (req, res) => {
  if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.end(fixture); return; }
  const name = /^\/assets\/([\w.-]+\.js)$/.exec(req.url)?.[1];
  if (name && assets.includes(name)) {
    try {
      const bytes = await readFile(new URL(`assets/${name}`, client));
      res.setHeader('content-type', 'text/javascript');
      res.end(bytes);
      return;
    } catch { res.writeHead(500).end(); return; }
  }
  res.writeHead(404).end();
});
const profile = await mkdtemp(join(tmpdir(), 'pi-web-system-rows-'));
try {
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const { stdout } = await promisify(execFile)(process.env.CI_CHROMIUM_EXECUTABLE, [
    '--headless', '--no-sandbox', '--disable-background-networking', `--user-data-dir=${profile}`,
    '--virtual-time-budget=5000', '--dump-dom', `http://127.0.0.1:${server.address().port}/`,
  ], { timeout: 20_000 });
  const outcome = stdout.match(/<body[^>]*>/)?.[0];
  assert.match(outcome ?? '', /data-result="pass"/, `stock SYSTEM row fixture: ${outcome}`);
  console.log('Stock Chat hides standalone and grouped SYSTEM rows without hiding ordinary messages');
} finally {
  server.close();
  await rm(profile, { recursive: true, force: true });
}
