// CI-only browser coverage of the pinned renderer; no real session or model.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const client = new URL('../../image/pi-web/node_modules/@jmfederico/pi-web/dist/client/', import.meta.url);
const chromePlugin = new URL('../../image/pi-web/codeflare-chrome/browser/', import.meta.url);
const appHtml = await readFile(new URL('index.html', client));
const css = await readFile(new URL('footer.css', chromePlugin), 'utf8');
const palette = await readFile(new URL('graphite.css', chromePlugin), 'utf8');
const workspaceCss = await Promise.all(['layout', 'header', 'pi-web-chat', 'dashboard', 'dashboard-card'].map(file =>
  readFile(new URL(`../../web-ui/src/styles/${file}.css`, import.meta.url), 'utf8')));
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
  composer.chatNavigation = document.createElement('button');
  composer.chatNavigation.textContent = 'Jump to end';
  composer.canStop = true;
  await composer.updateComplete;
  const editor = composer.shadowRoot;
  const attach = editor.querySelector('[data-composer-action="attach"]');
  const dimensions = element => [element.getBoundingClientRect().width, element.getBoundingClientRect().height];
  const verifySize = (target, reference) => {
    const [width, height] = dimensions(target);
    const [expectedWidth, expectedHeight] = dimensions(reference);
    if (!width || !height || width !== expectedWidth || height !== expectedHeight) {
      throw Error('Attach files must match Send and Stop button and icon sizes: ' + [width, height, expectedWidth, expectedHeight]);
    }
  };
  if (!dimensions(editor.querySelector('.editor-chat-navigation'))[0]) throw Error('stock composer jumps missing');
  editor.adoptedStyleSheets = [...editor.adoptedStyleSheets, sheet];
  const jumps = editor.querySelector('.editor-chat-navigation');
  jumps.querySelector('button').focus();
  if (dimensions(jumps).some(Boolean) || editor.activeElement === jumps.querySelector('button')) throw Error('composer jumps must not render or take focus');
  for (const selector of ['.send-button', '.stop-button']) {
    const action = editor.querySelector(selector);
    verifySize(attach, action);
    verifySize(attach.querySelector('svg'), action.querySelector('svg'));
  }
  for (const [tag, action, navigation] of [
    ['app-context-bar', 'button.context-action-button:not([data-navigation-trigger])', '[data-navigation-trigger]'],
    ['app-navigation-panel', 'button.actions-button', 'header .panel-toggle'],
  ]) {
    const bar = document.body.appendChild(document.createElement(tag));
    if (tag === 'app-navigation-panel') {
      bar.style.inlineSize = '320px';
      bar.onTogglePanel = () => {};
      bar.canStartSession = true;
    }
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
    const hidden = tag === 'app-navigation-panel'
      ? [...scope.querySelectorAll('header machine-switcher, project-list, navigation-section-resize-handle')]
      : [...scope.querySelectorAll('.context-item')].slice(0, -1);
    if (!hidden.length || hidden.some(visible)) throw Error(tag + ': redundant workspace identity and project controls must be hidden');
    const sessions = tag === 'app-navigation-panel'
      ? scope.querySelector('session-list')
      : scope.querySelector('.context-item:last-child button');
    await sessions?.updateComplete;
    if (!visible(sessions) || tag === 'app-navigation-panel' && !visible(sessions.shadowRoot.querySelector('.start-session-button:not(:disabled)'))) {
      throw Error(tag + ': Sessions and its available + control must remain visible');
    }
  }
  const tabs = document.body.appendChild(document.createElement('app-mobile-main-tabs'));
  tabs.tabs = [{ id: 'chat', label: 'Chat' }, { id: 'files:workspace.files', label: 'Files' }];
  tabs.onShowNavigation = () => {};
  await tabs.updateComplete;
  const tabsRoot = tabs.shadowRoot;
  tabsRoot.adoptedStyleSheets = [...tabsRoot.adoptedStyleSheets, sheet];
  for (const title of ['Chat', 'Files']) if (!dimensions(tabsRoot.querySelector('[title="' + title + '"]'))[0]) throw Error(title + ' tab must remain visible');
  const live = line('system', 'text', 'fixture live SYSTEM');
  chat.messages = [...messages, live];
  await chat.updateComplete;
  check('article.msg.system', false);
  if (root.querySelectorAll('article.msg.system').length !== 2 || !chat.messages.includes(live)) {
    throw Error('the live SYSTEM entry did not render as a hidden row');
  }
  // Use the real workspace styles with the outer header and Chat shell boxes.
  const layoutCss = ${JSON.stringify(workspaceCss.join('\n')).replaceAll('<', '\\u003c')};
  for (const width of [390, 640, 641, 1024, 1440]) {
    const viewport = document.createElement('iframe');
    viewport.style.cssText = 'position:fixed;left:-3000px;top:0;border:0;width:' + width + 'px;height:844px';
    viewport.srcdoc = '<!doctype html><style>:root{--header-height:48px}' + layoutCss + '</style>' +
      '<div class="layout"><div class="layout-workspace layout-workspace--chat"><header class="header">Codeflare</header>' +
      '<div class="layout-middle" style="--chat-compact-height:200px"><iframe class="pi-web-chat__frame" title="Pi Chat"></iframe></div></div></div>';
    await new Promise(resolve => {
      viewport.addEventListener('load', resolve, { once: true });
      document.body.appendChild(viewport);
    });
    const doc = viewport.contentDocument;
    const header = doc.querySelector('header');
    const middle = doc.querySelector('.layout-middle');
    const frame = doc.querySelector('.pi-web-chat__frame');
    const compactHeader = header.getBoundingClientRect();
    const compactFrame = frame.getBoundingClientRect();
    middle.style.removeProperty('--chat-compact-height');
    const fullHeader = header.getBoundingClientRect();
    const fullFrame = frame.getBoundingClientRect();
    const aligned = (head, chat) => head.left === chat.left && head.right === chat.right;
    if (!aligned(compactHeader, compactFrame) || !aligned(fullHeader, fullFrame) || compactFrame.height !== 200 || fullFrame.height <= compactFrame.height) {
      throw Error(width + ': expected aligned compact and full Chat sizing');
    }
    if (width <= 640) {
      if (compactHeader.top !== 0 || fullHeader.top !== 0 || fullFrame.width !== width || fullFrame.top !== fullHeader.bottom || fullFrame.bottom !== 844
        || Math.abs(compactFrame.top - (844 + compactHeader.bottom - compactFrame.height) / 2) > 1) {
        throw Error(width + ': mobile header must stay at the top while compact Chat centers in the space below');
      }
    } else if ([ [compactHeader, compactFrame], [fullHeader, fullFrame] ].some(([head, chat]) =>
      head.top <= 0 || head.bottom !== chat.top || Math.abs(head.top + chat.bottom - 844) > 1)) {
      throw Error(width + ': above the phone breakpoint the header must stay with the centered frame');
    }
    // The shared Profile component styles must clip only the email, not grow its menu.
    const profile = doc.createElement('div');
    profile.className = 'header-user-dropdown header-user-dropdown--profile header-user-dropdown--portal' +
      (width <= 640 ? ' header-user-dropdown--sheet' : '');
    profile.style.cssText = '--space-1:4px;--space-2:8px;--space-3:12px;--text-sm:13px;--font-semibold:600;--font-mono:monospace;animation:none';
    if (width > 640) profile.style.cssText += ';width:155px;right:25vw;--profile-menu-right:' + width / 4 + 'px';
    profile.innerHTML = '<div class="header-user-email"><span>a@example.test</span></div><div class="header-user-profile-actions"><button>Usage</button></div>';
    doc.body.appendChild(profile);
    const label = profile.querySelector('span');
    const win = viewport.contentWindow;
    const menuWidth = profile.getBoundingClientRect().width;
    if (label.scrollWidth > label.clientWidth) throw Error(width + ': a short Profile email must fit');
    const longEmail = 'x'.repeat(300) + '@example.test';
    label.textContent = longEmail;
    const badge = label.getBoundingClientRect();
    if (Math.abs(badge.width - width * 0.9) > 1 || badge.left < 0 || badge.right > width + 1 ||
        label.scrollWidth <= label.clientWidth || win.getComputedStyle(label).textOverflow !== 'ellipsis' ||
        profile.getBoundingClientRect().width !== menuWidth || label.textContent !== longEmail) {
      throw Error(width + ': a long Profile email must ellipsize in the viewport without widening the menu or losing its full text');
    }
    if (width === 1024 || width === 1440) {
      const dashboard = doc.createElement('div');
      dashboard.className = 'dashboard-container';
      dashboard.style.cssText = 'position:fixed;inset:0;--dashboard-panel-margin:12px;--dashboard-max-width:840px;--dashboard-left-width:340px;--transition-base:150ms ease;--space-4:16px;animation:none';
      dashboard.innerHTML = '<div class="dashboard-panel-wrapper dashboard-panel-wrapper--disclosure dashboard-panel-wrapper--summary"><div class="dashboard-panel"><div class="dashboard-panel-header">Codeflare</div><div class="dashboard-panel-body dashboard-panel-body--disclosure"><div class="dashboard-panel-left"><div class="tips-card"><div class="dashboard-card__text">Open a pull request and get reviewers to check your changes in parallel.</div></div><div class="dashboard-new-session-wrapper"><button class="dashboard-new-session-btn">+ New Session</button></div></div><div class="dashboard-panel-right" hidden>Storage</div></div></div></div>';
      doc.body.appendChild(dashboard);
      const wrapper = dashboard.querySelector('.dashboard-panel-wrapper');
      const side = dashboard.querySelector('.dashboard-panel-right');
      const button = dashboard.querySelector('.dashboard-new-session-btn');
      const top = button.getBoundingClientRect().top;
      const closedWidth = wrapper.getBoundingClientRect().width;
      for (const expanding of [true, false]) {
        wrapper.classList.toggle('dashboard-panel-wrapper--summary', !expanding);
        side.hidden = !expanding;
        const start = performance.now();
        do {
          await new Promise(resolve => requestAnimationFrame(resolve));
          if (Math.abs(button.getBoundingClientRect().top - top) > 1) {
            throw Error(width + ': New Session moved vertically while ' + (expanding ? 'opening' : 'closing') + ' the side panel');
          }
        } while (performance.now() - start < 250);
        if (expanding ? wrapper.getBoundingClientRect().width <= closedWidth || !dimensions(side)[0]
          : Math.abs(wrapper.getBoundingClientRect().width - closedWidth) > 1 || dimensions(side).some(Boolean)) {
          throw Error(width + ': unexpected settled side-panel layout');
        }
      }
    }
    viewport.remove();
  }
  result = 'pass';
} catch (error) {
  result = 'fail: ' + String(error).slice(0, 500);
}
await fetch('/fixture-result', { method: 'POST', body: result });
</script></body>`;

// REQ-AGENT-274: boot the actual pinned app and load the production browser
// plugin through its manifest. Only the gateway data is a fixture; this does
// not claim a writer was transferred (the packaged Host smoke covers that).
const generation = 17;
const attachment = '/api/pi-web/browserfixture/g/17/a/f3bbca20-f953-4113-b03d-3aa71a866b40/';
const cwd = '/home/user/workspace';
const [bound, savedPointer, savedKeyboard] = [
  'a0000000-0000-4000-8000-000000000001',
  'a0000000-0000-4000-8000-000000000002',
  'a0000000-0000-4000-8000-000000000003',
];
const created = '2026-11-01T00:00:00.000Z';
const ids = [bound, savedPointer, savedKeyboard];
const gateway = new Map(Object.entries({
  'api/config': { config: {}, effectiveConfig: {}, configSources: {}, enforcedSettings: {} },
  'api/machines': { machines: [{ id: 'local', name: 'Codeflare', kind: 'local', status: 'online', createdAt: created, updatedAt: created }] },
  'api/machines/local/health': { machineId: 'local', ok: true, status: 'online', checkedAt: created },
  'api/machines/local/projects': [{ id: 'fixture-project', name: 'Fixture', path: cwd, createdAt: created }],
  'api/machines/local/projects/fixture-project/workspaces': {
    status: 'folder', projectId: 'fixture-project', diagnostics: [],
    workspaces: [{ id: 'fixture-workspace', projectId: 'fixture-project', label: 'Fixture', path: cwd, isMain: true, effectiveConfig: {} }],
  },
  'api/machines/local/sessions': ids.map((id, index) => ({
    id, cwd, path: `/fixture/pi/${id}.jsonl`, name: `Fixture conversation ${index + 1}`,
    created, modified: created, persisted: true, messageCount: 0, firstMessage: '',
  })),
  'pi-web-plugins/manifest.json': {
    lifecycleVersion: 2, terminalMode: 'recovery-disabled',
    plugins: [
      { id: 'codeflare-chrome', module: './codeflare-chrome/fixture.js', machineSpecific: false },
      { id: 'files', module: './files-fixture.js', machineSpecific: false },
    ],
  },
}));
// Observe the public selection state from the real plugin context. The wrapper
// neither supplies a fake selection nor invokes any stock control handler.
const pluginFixture = `import plugin from './index.js';
export default { ...plugin, activate(context) {
  const activated = plugin.activate(context);
  window.fixtureSelection = context.selection;
  return activated;
} };`;
const mime = { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };

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
  const pathname = new URL(req.url, 'http://fixture').pathname;
  const scoped = pathname.startsWith(attachment) ? pathname.slice(attachment.length) : undefined;
  if (req.method === 'POST' && scoped === '_intent') {
    req.resume();
    res.writeHead(202).end();
    return;
  }
  if (req.method === 'GET' && scoped === '') {
    res.writeHead(200, { 'content-type': 'text/html' }).end(appHtml);
    return;
  }
  if (req.method === 'GET' && gateway.has(scoped)) {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(gateway.get(scoped)));
    return;
  }
  const snapshot = /^api\/machines\/local\/sessions\/([\w-]+)\/transcript-snapshot$/.exec(scoped)?.[1];
  if (req.method === 'GET' && ids.includes(snapshot)) {
    const status = { sessionId: snapshot, persisted: true, isStreaming: false, isCompacting: false, isBashRunning: false,
      pendingMessageCount: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 };
    res.writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ page: { messages: [], start: 0, total: 0 }, status, seq: 0, partial: false }));
    return;
  }
  if (scoped === 'pi-web-plugins/codeflare-chrome/fixture.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' }).end(pluginFixture);
    return;
  }
  if (scoped === 'pi-web-plugins/files-fixture.js') {
    // Supply a destination to stock navigation, not a custom navigation control.
    res.writeHead(200, { 'content-type': 'text/javascript' }).end(`export default {
      apiVersion: 5, name: 'Fixture Files', activate: ({ html }) => ({ contributions: {
        workspacePanels: [{ id: 'workspace.files', title: 'Files', render: () => html\`<p data-fixture-files>Fixture Files</p>\` }],
      } }),
    };`);
    return;
  }
  const pluginAsset = /^pi-web-plugins\/codeflare-chrome\/(index\.js|transcript-intent\.js|footer\.css)$/.exec(scoped)?.[1];
  const name = /^assets\/([\w.-]+)$/.exec(scoped ?? pathname.slice(1))?.[1];
  if (pluginAsset || name && assets.includes(name)) {
    try {
      const bytes = await readFile(pluginAsset ? new URL(pluginAsset, chromePlugin) : new URL(`assets/${name}`, client));
      servedModules++;
      res.writeHead(200, { 'content-type': mime[extname(pluginAsset ?? name)] ?? 'application/octet-stream' }).end(bytes);
      return;
    } catch { res.writeHead(500).end(); return; }
  }
  res.writeHead(404).end();
});
// Chromium's private DevTools pipe shares the existing CI browser process and
// does not expose a debug port. Input.dispatch* produces trusted DOM events.
function connectDevTools(child, onEvent) {
  const [input, output] = child.stdio.slice(3);
  const pending = new Map();
  let sequence = 0;
  let buffered = '';
  output.setEncoding('utf8');
  output.on('data', chunk => {
    const messages = (buffered + chunk).split('\0');
    buffered = messages.pop();
    for (const message of messages) {
      const reply = JSON.parse(message);
      if (reply.method) { onEvent(reply); continue; }
      const pair = pending.get(reply.id);
      if (!pair) continue;
      pending.delete(reply.id);
      if (reply.error) pair.reject(Error(reply.error.message));
      else pair.resolve(reply.result);
    }
  });
  return (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    input.write(JSON.stringify({ id, method, params, sessionId }) + '\0', error => {
      if (!error) return;
      pending.delete(id);
      reject(error);
    });
  });
}

async function verifyStockTranscriptControls(child, origin) {
  const requests = [];
  const cdp = connectDevTools(child, ({ method, params }) => {
    if (method === 'Network.requestWillBeSent') {
      const { requestId, request: { method, url, postData, headers } } = params;
      const { pathname } = new URL(url);
      if (pathname.endsWith('/_intent') || method === 'POST' && /\/api\/(?:machines\/local\/)?sessions$/.test(pathname)) {
        const contentType = Object.entries(headers).find(([name]) => name.toLowerCase() === 'content-type')?.[1];
        requests.push({ requestId, request: { method, url, postData, contentType } });
      }
    } else if (method === 'Network.responseReceived') {
      const record = requests.find(({ requestId }) => requestId === params.requestId);
      if (record) record.status = params.response.status;
    }
  });
  const { targetInfos } = await cdp('Target.getTargets');
  const target = targetInfos.find(({ type, url }) => type === 'page' && url === `${origin}/`);
  assert.ok(target, 'the stock rendering fixture must have a Chromium page');
  const { sessionId } = await cdp('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  const send = (method, params) => cdp(method, params, sessionId);
  await send('Page.enable');
  await send('Network.enable', { maxPostDataSize: 4096 });
  const page = async expression => {
    const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (exceptionDetails) throw Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  };
  const until = async (label, read, accepts) => {
    const expires = Date.now() + 6000;
    let last;
    do {
      try { last = await read(); }
      catch (error) {
        if (!/Execution context was destroyed|Cannot find (?:default )?(?:execution )?context/i.test(error.message)) throw error;
      }
      if (accepts(last)) return last;
      await delay(50);
    } while (Date.now() < expires);
    throw Error(`${label}: last observed ${JSON.stringify(last)}; requests=${JSON.stringify(requests)}`);
  };
  const app = id => `${origin}${attachment}?project=fixture-project&workspace=fixture-workspace&session=${id}&view=chat`;
  const list = `document.querySelector('pi-web-app')?.shadowRoot?.querySelector('app-navigation-panel')?.shadowRoot
    ?.querySelector('session-list')?.shadowRoot`;
  const plus = 'button.start-session-button:not(:disabled)';
  const row = id => `.action-row[data-session-id="${id}"][data-archived="false"][data-selecting="false"]`;
  const state = () => page(`(() => {
    const list = ${list};
    const selection = window.fixtureSelection?.getSnapshot();
    return { url: location.href, loadedAt: performance.timeOrigin, workspace: selection?.selectedWorkspace?.path,
      selected: selection?.selectedSession?.id, current: list?.querySelector('[aria-current="true"][data-session-id]')?.dataset.sessionId,
      ids: [...(list?.querySelectorAll('.action-row[data-session-id]') ?? [])].map(row => row.dataset.sessionId).sort(),
      pending: !!list?.querySelector('.pending-session-row'),
      plus: !!list?.querySelector(${JSON.stringify(plus)})?.checkVisibility({ visibilityProperty: true }) };
  })()`);
  const waitCurrent = (label, id, previousLoad) => until(label, state, value => value?.url === app(id)
    && value.loadedAt !== previousLoad && value.workspace === cwd && value.selected === id && value.current === id && value.plus);
  const navigate = async id => {
    const { errorText } = await send('Page.navigate', { url: app(id) });
    assert.equal(errorText, undefined);
    await waitCurrent('stock deep link', id);
  };
  const reload = async () => {
    const { loadedAt } = await state();
    await send('Page.reload');
    await waitCurrent('stock reload', bound, loadedAt);
  };
  const afterRender = () => page('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))');
  const verifyPassive = async label => {
    await afterRender();
    assert.deepEqual(requests, [], `${label} must not send an intent or stock creation request`);
  };

  await navigate(savedPointer);
  await verifyPassive('deep link to another conversation');
  await navigate(bound);
  await page(`(() => {
    history.pushState(null, '', ${JSON.stringify(app(savedPointer))});
    history.pushState(null, '', ${JSON.stringify(app(bound))});
    history.back();
  })()`);
  await waitCurrent('stock Back', savedPointer);
  await verifyPassive('Back to another conversation');
  await page('history.forward()');
  await waitCurrent('stock Forward', bound);
  await verifyPassive('Forward to the bound conversation');
  await reload();
  await verifyPassive('reload');

  async function click(selector) {
    const point = await page(`(() => {
      const list = ${list};
      const control = list?.querySelector(${JSON.stringify(selector)});
      if (!control?.checkVisibility({ visibilityProperty: true })) return null;
      control.scrollIntoView({ block: 'nearest' });
      const rect = control.getBoundingClientRect();
      const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
      return control.contains(list.elementFromPoint(x, y)) ? { x, y } : null;
    })()`);
    assert.ok(point, `stock control must be visible and hit-testable: ${selector}`);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, ...point });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1, ...point });
  }
  const expected = [];
  async function verifyIntent(label, body) {
    expected.push(body);
    await until(label, () => requests[expected.length - 1]?.status, status => status !== undefined);
    await afterRender();
    assert.deepEqual(requests.map(({ request, status }) => ({ ...request, postData: request.postData && JSON.parse(request.postData), status })),
      expected.map(postData => ({ method: 'POST', url: `${origin}${attachment}_intent`, postData, contentType: 'application/json', status: 202 })), label);
    const current = await state();
    assert.deepEqual({ url: current.url, selected: current.selected, row: current.current, ids: current.ids, pending: current.pending },
      { url: app(bound), selected: bound, row: bound, ids, pending: false }, `${label} must leave takeover to the parent attachment`);
  }

  await click(plus);
  await verifyIntent('trusted pointer on stock +', { generation, cwd, action: 'new' });
  await reload();
  await click(row(savedPointer));
  await verifyIntent('trusted pointer on stock history', { generation, cwd, action: 'select', id: savedPointer });
  await reload();
  assert.equal(await page(`(() => {
    const list = ${list};
    const control = list?.querySelector(${JSON.stringify(row(savedKeyboard))});
    control?.focus();
    return !!control && list.activeElement === control;
  })()`), true, 'eligible history row must accept focus');
  const enter = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 };
  await send('Input.dispatchKeyEvent', { type: 'keyDown', ...enter });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...enter });
  await verifyIntent('trusted Enter on stock history', { generation, cwd, action: 'select', id: savedKeyboard });

  const noticeSelector = "document.querySelector('pi-web-app').shadowRoot.querySelector('conversation-sync-notice')";
  // Drive the real pinned notice through its two warning states without a live upstream.
  await page(`(() => { ${noticeSelector}.state = 'stale'; })()`);
  const notice = () => page(`(() => {
    const warning = ${noticeSelector}?.shadowRoot?.querySelector('[role="status"]');
    return { text: warning?.textContent?.trim(), visible: !!warning?.getClientRects().length };
  })()`);
  await until('stock stale notice rendered but hidden', notice, value => value?.text?.includes('Chat may be out of date.') && !value.visible);
  await page(`(() => { ${noticeSelector}.state = 'interrupted'; })()`);
  await until('stock refresh failure remains visible', notice, value => value?.visible && value.text.includes('Could not refresh messages.'));

  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  const appRoot = "document.querySelector('pi-web-app')?.shadowRoot";
  const contextBar = `${appRoot}?.querySelector('app-context-bar')`;
  const picker = `${contextBar}?.shadowRoot?.querySelector('.context-item:last-child button')`;
  await until('stock mobile session picker', () => page(`!!(${picker})`), Boolean);
  // Provide successive stock session summaries to the same rendered header.
  const setSummary = overrides => page(`(async () => {
    const bar = ${contextBar};
    bar.session = { ...bar.session, ...${JSON.stringify(overrides)} };
    await bar.updateComplete;
    const button = ${picker};
    const title = button.querySelector('.context-value');
    button.focus();
    return { title: title.textContent, visible: !!title.getClientRects().length,
      focusable: button === bar.shadowRoot.activeElement, label: button.getAttribute('aria-label') };
  })()`);
  const hidden = await setSummary({ name: null, firstMessage: '(no messages)', messageCount: 0 });
  assert.equal(hidden.title, '(no messages)', 'stock sentinel should still be present in the stock markup');
  assert.equal(hidden.visible, false, 'hide the visible empty-session title');
  assert.ok(hidden.focusable && hidden.label?.includes('(no messages)'), 'keep the stock picker and accessible label');
  const sent = await setSummary({ firstMessage: 'First sent message', messageCount: 1 });
  assert.equal(sent.title, 'First sent message');
  assert.equal(sent.visible, true, 'show the real title once it is available');
  assert.equal((await setSummary({ firstMessage: '(no messages)' })).visible, true, 'keep genuine first-message text matching the sentinel');
  assert.equal((await setSummary({ messageCount: 0 })).visible, false, 'hide the sentinel even when only the summary count changes');
  assert.equal((await setSummary({ name: '(no messages)' })).visible, true, 'keep an authored name matching the sentinel even on an empty transcript');
  assert.equal((await setSummary({ name: null })).visible, false, 'return to the hidden sentinel without removing the picker');
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  const press = async expression => {
    assert.ok(await page(`(() => { const button = ${expression}; if (!button?.checkVisibility()) return false; button.focus(); return document.hasFocus() && button.getRootNode().activeElement === button; })()`));
    // Unlike the custom history-row keydown handler, native buttons need the
    // Enter character event synthesized by CDP from the keydown text.
    await send('Input.dispatchKeyEvent', { type: 'keyDown', ...enter, text: '\r', unmodifiedText: '\r' });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...enter });
  };
  const openSessions = async () => {
    await press(picker);
    const mobilePlus = `${appRoot}?.querySelector('main.navigation-view .mobile-navigation-panel app-navigation-panel')?.shadowRoot?.querySelector('session-list')?.shadowRoot?.querySelector('${plus}')`;
    await until('mobile Sessions via focused picker', () => page(`({ view: new URL(location.href).searchParams.get('view'), plus: Boolean((${mobilePlus})?.checkVisibility({ visibilityProperty: true })) })`), value => value?.view === 'navigation' && value.plus);
  };
  await openSessions();

  const mobileTabs = `${appRoot}?.querySelector('app-mobile-main-tabs')?.shadowRoot`;
  const hamburger = `${mobileTabs}?.querySelector('.navigation-menu-button')`;
  const files = `${mobileTabs}?.querySelector('[title="Files"]')`;
  const chat = `${mobileTabs}?.querySelector('[title="Chat"]')`;
  const openMobile = async (pinnedIds, readyTab) => {
    await page(`localStorage.setItem('pi-web:navigation-preferences', ${JSON.stringify(JSON.stringify({ pinnedIds, mobileCollapsed: false }))})`);
    const { loadedAt } = await state();
    await page(`history.replaceState(null, '', ${JSON.stringify(app(bound))})`);
    await send('Page.reload');
    await until('mobile pinned tab ready', () => page(`performance.timeOrigin !== ${loadedAt} && Boolean((${readyTab})?.checkVisibility())`), Boolean);
  };
  const filesId = 'files:workspace.files';
  const filesContent = `${appRoot}?.querySelector('workspace-panel')?.shadowRoot?.querySelector('[data-fixture-files]')`;
  const filesSelected = `new URL(location.href).searchParams.get('tool') === '${filesId}' && Boolean((${filesContent})?.checkVisibility({ visibilityProperty: true, opacityProperty: true }))`;
  const expectHiddenHamburger = (label, activeTab) => until(label + ': both tabs available without redundant navigation', () => page(`(() => {
    const button = ${hamburger};
    button?.focus();
    return Boolean((${chat})?.checkVisibility() && (${files})?.checkVisibility()
      && (${activeTab})?.getAttribute('aria-pressed') === 'true'
      && button && !button.checkVisibility() && button.getRootNode().activeElement !== button);
  })()`), Boolean);
  await openMobile(['chat', filesId], files);
  await expectHiddenHamburger('Chat active', chat);
  await press(files);
  await until('Files content visible with both tabs pinned', () => page(filesSelected), Boolean);
  await expectHiddenHamburger('Files active', files);
  const chatSelected = `(${appRoot}?.querySelector('main')?.classList.contains('chat-view') && new URL(location.href).searchParams.get('view') === 'chat')`;
  await press(chat);
  await until('pinned Chat tab opens directly from Files', () => page(chatSelected), Boolean);

  const viaNavigation = async (label, arrived) => {
    await until('stock navigation fallback', () => page(`Boolean((${hamburger})?.checkVisibility())`), Boolean);
    await press(hamburger);
    const destination = `Array.from(${appRoot}?.querySelector('navigation-dialog')?.shadowRoot?.querySelectorAll('button.destination-button') ?? []).find(button => button.textContent.trim() === ${JSON.stringify(label)})`;
    await until(label + ' navigation destination', () => page(`Boolean((${destination})?.checkVisibility())`), Boolean);
    await press(destination);
    await until(label + ' destination opens', () => page(arrived), Boolean);
  };
  await openSessions();
  assert.ok(await page(`Boolean((${chat})?.checkVisibility() && (${files})?.checkVisibility())`), 'both tabs remain pinned while unpinned Sessions is active');
  await viaNavigation('Chat', chatSelected);

  await openMobile(['chat'], chat);
  assert.ok(await page(`!(${files})`), 'saved preference leaves Files unpinned');
  await viaNavigation('Files', filesSelected);

  await openMobile([filesId], files);
  assert.ok(await page(`!(${chat})`), 'saved preference leaves Chat unpinned');
  await press(files);
  await until('pinned Files tab opens', () => page(filesSelected), Boolean);
  await viaNavigation('Chat', chatSelected);
}

const profile = await mkdtemp(join(tmpdir(), 'pi-web-system-rows-'));
let browser;
let browserClosed;
let deadline;
let stderr = '';
const diagnostics = () => `document loads=${fixtureLoads}, modules served=${servedModules}; Chromium stderr: ${stderr.trim()}`;
try {
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = spawn(process.env.CI_CHROMIUM_EXECUTABLE, [
    '--headless', '--no-sandbox', '--disable-background-networking', '--no-first-run',
    '--window-size=1440,1000', '--remote-debugging-pipe', `--user-data-dir=${profile}`, `${origin}/`,
  ], { detached: true, stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  browser.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2400); });
  browserClosed = new Promise(resolve => browser.once('close', (code, signal) => resolve({ code, signal })));
  await Promise.race([
    browserResult.then(async result => {
      assert.equal(result, 'pass', 'stock SYSTEM row fixture');
      console.log('Stock Chat hides selected transcript, navigation and composer controls and keeps the remaining controls usable');
      await verifyStockTranscriptControls(browser, origin);
      console.log('Stock Chat sends scoped transcript intents for trusted + and history activation, never for passive navigation');
    }),
    browserClosed.then(({ code, signal }) => {
      throw Error(`Chromium exited before the fixtures completed (${code ?? signal}); ${diagnostics()}`);
    }),
    new Promise((_, reject) => {
      browser.once('error', reject);
      deadline = setTimeout(() => reject(Error(`Timed out waiting for stock browser fixtures; ${diagnostics()}`)), 40_000);
    }),
  ]);
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
