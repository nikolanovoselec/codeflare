export type IdeAgentKind = 'pi' | 'claude' | 'none';

export interface WelcomeAction {
  readonly label: string;
  readonly command: string;
  readonly arguments: readonly unknown[];
}

export interface WelcomePresentation {
  readonly agentEnabled: boolean;
  readonly runtimeLabel: string;
  readonly continuityTitle: string;
  readonly continuityBody: string;
  readonly action: WelcomeAction;
}

export function normalizeIdeAgentKind(value: string | undefined): IdeAgentKind {
  return value === 'pi' || value === 'claude' ? value : 'none';
}

export function buildWelcomePresentation(kind: IdeAgentKind): WelcomePresentation {
  if (kind === 'pi') {
    return Object.freeze({
      agentEnabled: true,
      runtimeLabel: 'PI / NATIVE CHAT',
      continuityTitle: 'Native Pi continuity',
      continuityBody: 'Codeflare Chat runs the same Codeflare Pi agent environment in this container: the same agents, tools, skills, and MCPs, with an IDE-owned conversation.',
      action: Object.freeze({
        label: 'Open Codeflare Chat',
        command: 'workbench.action.chat.open',
        arguments: Object.freeze([
          Object.freeze({ query: '@codeflare ', isPartialQuery: true }),
        ]),
      }),
    });
  }
  if (kind === 'claude') {
    return Object.freeze({
      agentEnabled: true,
      runtimeLabel: 'CLAUDE / OFFICIAL PANEL',
      continuityTitle: 'Official Claude Code',
      continuityBody: 'The official panel runs the same Codeflare-managed Claude agent environment in this container: its agents, tools, skills, plugins, and available MCPs.',
      action: Object.freeze({
        label: 'Open Codeflare Chat',
        command: 'claude-vscode.sidebar.open',
        arguments: Object.freeze([]),
      }),
    });
  }
  return Object.freeze({
    agentEnabled: false,
    runtimeLabel: 'EDITOR / STANDARD',
    continuityTitle: 'Traditional editor mode',
    continuityBody: 'This session type does not inject an agent into VS Code. Editing, terminals, source control, debugging, and extensions remain fully functional.',
    action: Object.freeze({
      label: 'Explore workspace',
      command: 'workbench.view.explorer',
      arguments: Object.freeze([]),
    }),
  });
}

export function renderWelcomeHtml(
  presentation: WelcomePresentation,
  cspSource: string,
  nonce: string,
): string {
  if (!/^[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+$/i.test(cspSource)) {
    throw new TypeError('Invalid webview CSP source');
  }
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(nonce)) throw new TypeError('Invalid webview nonce');
  const runtimeLabel = escapeHtml(presentation.runtimeLabel);
  const continuityTitle = escapeHtml(presentation.continuityTitle);
  const continuityBody = escapeHtml(presentation.continuityBody);
  const actionLabel = escapeHtml(presentation.action.label);
  const agentState = presentation.agentEnabled ? 'CONNECTED' : 'NOT ATTACHED';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'">
<title>Codeflare</title>
<style nonce="${nonce}">
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  html, body { min-height: 100%; }
  body {
    margin: 0;
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    font-family: var(--vscode-font-family);
  }
  button { font: inherit; }
  .shell {
    width: min(1080px, calc(100% - 64px));
    margin: 0 auto;
    padding: clamp(56px, 9vh, 108px) 0 64px;
  }
  .masthead {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 24px;
    padding-bottom: 18px;
    border-bottom: 1px solid var(--vscode-panel-border);
  }
  .wordmark {
    display: flex;
    align-items: center;
    gap: 11px;
    color: var(--vscode-foreground);
    font-size: 13px;
    font-weight: 650;
    letter-spacing: .08em;
    text-transform: uppercase;
  }
  .mark { width: 22px; height: 22px; color: var(--vscode-charts-orange, #d66a45); }
  .runtime {
    color: var(--vscode-descriptionForeground);
    font-family: var(--vscode-editor-font-family);
    font-size: 11px;
    letter-spacing: .08em;
  }
  .hero {
    display: grid;
    grid-template-columns: minmax(0, 1.25fr) minmax(260px, .75fr);
    gap: clamp(40px, 7vw, 92px);
    padding: clamp(52px, 8vh, 88px) 0 60px;
    align-items: end;
  }
  .eyebrow {
    margin: 0 0 18px;
    color: var(--vscode-charts-orange, #d66a45);
    font-family: var(--vscode-editor-font-family);
    font-size: 12px;
    font-weight: 650;
    letter-spacing: .12em;
    text-transform: uppercase;
  }
  h1 {
    max-width: 760px;
    margin: 0;
    color: var(--vscode-editor-foreground);
    font-size: clamp(38px, 6vw, 68px);
    font-weight: 560;
    letter-spacing: -.045em;
    line-height: .98;
  }
  .lede {
    max-width: 700px;
    margin: 26px 0 0;
    color: var(--vscode-descriptionForeground);
    font-size: clamp(16px, 2vw, 19px);
    line-height: 1.55;
  }
  .action-block { border-left: 2px solid var(--vscode-charts-orange, #d66a45); padding-left: 22px; }
  .action-label {
    margin: 0 0 12px;
    color: var(--vscode-descriptionForeground);
    font-family: var(--vscode-editor-font-family);
    font-size: 11px;
    letter-spacing: .1em;
    text-transform: uppercase;
  }
  .primary {
    display: inline-flex;
    min-height: 40px;
    align-items: center;
    gap: 10px;
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 2px;
    padding: 9px 14px;
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
    cursor: pointer;
    transition: background-color 160ms ease, transform 160ms ease;
  }
  .primary:hover { background: var(--vscode-button-hoverBackground); transform: translateY(-1px); }
  .primary:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 3px; }
  .primary svg { width: 16px; height: 16px; }
  .plane {
    border-top: 1px solid var(--vscode-panel-border);
    border-bottom: 1px solid var(--vscode-panel-border);
  }
  .flow {
    display: grid;
    grid-template-columns: 1fr 44px 1fr 44px 1fr;
    align-items: center;
    min-height: 112px;
  }
  .node { padding: 22px 18px; }
  .node small {
    display: block;
    margin-bottom: 7px;
    color: var(--vscode-descriptionForeground);
    font-family: var(--vscode-editor-font-family);
    font-size: 10px;
    letter-spacing: .1em;
  }
  .node strong { font-size: 15px; font-weight: 570; }
  .connector { position: relative; height: 1px; background: var(--vscode-panel-border); }
  .connector::after {
    content: '';
    position: absolute;
    right: 0;
    top: -3px;
    width: 6px;
    height: 6px;
    border-top: 1px solid var(--vscode-descriptionForeground);
    border-right: 1px solid var(--vscode-descriptionForeground);
    transform: rotate(45deg);
  }
  .details {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    border-bottom: 1px solid var(--vscode-panel-border);
  }
  .detail { min-height: 190px; padding: 30px 26px 34px; }
  .detail + .detail { border-left: 1px solid var(--vscode-panel-border); }
  .index {
    display: block;
    margin-bottom: 34px;
    color: var(--vscode-charts-orange, #d66a45);
    font-family: var(--vscode-editor-font-family);
    font-size: 11px;
  }
  .detail h2 { margin: 0 0 10px; font-size: 16px; font-weight: 590; }
  .detail p { margin: 0; color: var(--vscode-descriptionForeground); font-size: 13px; line-height: 1.55; }
  .footer {
    display: flex;
    justify-content: space-between;
    gap: 24px;
    padding-top: 18px;
    color: var(--vscode-descriptionForeground);
    font-family: var(--vscode-editor-font-family);
    font-size: 10px;
    letter-spacing: .08em;
    text-transform: uppercase;
  }
  @media (max-width: 760px) {
    .shell { width: min(100% - 32px, 620px); padding-top: 36px; }
    .masthead { align-items: flex-start; flex-direction: column; gap: 10px; }
    .hero { grid-template-columns: 1fr; align-items: start; padding-top: 44px; }
    .flow { grid-template-columns: 1fr; padding: 14px 0; }
    .connector { width: 1px; height: 24px; margin-left: 24px; }
    .connector::after { right: -3px; top: auto; bottom: 0; transform: rotate(135deg); }
    .details { grid-template-columns: 1fr; }
    .detail { min-height: 0; }
    .detail + .detail { border-left: 0; border-top: 1px solid var(--vscode-panel-border); }
    .index { margin-bottom: 16px; }
    .footer { flex-direction: column; }
  }
  @media (prefers-reduced-motion: reduce) {
    .primary { transition: none; }
    .primary:hover { transform: none; }
  }
</style>
</head>
<body>
<main class="shell">
  <header class="masthead">
    <div class="wordmark">
      <svg class="mark" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M3 3h8v3H6v12h5v3H3V3Zm10 0h8v8h-3V6h-5V3Zm0 15h5v-5h3v8h-8v-3Z"/></svg>
      Codeflare
    </div>
    <div class="runtime">${runtimeLabel}</div>
  </header>

  <section class="hero">
    <div>
      <p class="eyebrow">Browser IDE / observability plane</p>
      <h1>Code directly.<br>See the whole system.</h1>
      <p class="lede">VS Code remains fully functional for traditional coding. Here, it also becomes the observability plane connecting direct edits with the agentic SDLC around them.</p>
    </div>
    <div class="action-block">
      <p class="action-label">Current plane · ${agentState}</p>
      <button class="primary" id="primary" type="button">
        ${actionLabel}
        <svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M3 7.25h7.2L7.4 4.4 8.8 3l5.2 5-5.2 5-1.4-1.4 2.8-2.85H3v-1.5Z"/></svg>
      </button>
    </div>
  </section>

  <section class="plane" aria-label="Codeflare execution plane">
    <div class="flow">
      <div class="node"><small>01 / EDIT</small><strong>Traditional VS Code</strong></div>
      <div class="connector" aria-hidden="true"></div>
      <div class="node"><small>02 / OBSERVE</small><strong>Shared workspace state</strong></div>
      <div class="connector" aria-hidden="true"></div>
      <div class="node"><small>03 / EXECUTE</small><strong>Native agent surface</strong></div>
    </div>
  </section>

  <section class="details">
    <article class="detail">
      <span class="index">01</span>
      <h2>A complete editor</h2>
      <p>Edit, navigate, debug, search, review source control, and use the integrated terminal exactly as you would in a traditional VS Code workspace.</p>
    </article>
    <article class="detail">
      <span class="index">02</span>
      <h2>One isolated runtime</h2>
      <p>The Browser IDE and your main Codeflare session run in the same isolated, ephemeral container against the same workspace and toolchain.</p>
    </article>
    <article class="detail">
      <span class="index">03</span>
      <h2>${continuityTitle}</h2>
      <p>${continuityBody}</p>
    </article>
  </section>

  <footer class="footer">
    <span>Workspace / live</span>
    <span>Container / ephemeral</span>
    <span>Agent / ${presentation.agentEnabled ? 'native' : 'none'}</span>
  </footer>
</main>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  document.getElementById('primary').addEventListener('click', () => vscode.postMessage({ type: 'primary' }));
</script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  })[character] ?? character);
}
