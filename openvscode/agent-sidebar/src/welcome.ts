export type IdeAgentKind = 'pi' | 'claude' | 'none';

export interface WelcomeAction {
  readonly label: string;
  readonly command: string;
  readonly arguments: readonly unknown[];
}

export interface WelcomePresentation {
  readonly agentEnabled: boolean;
  readonly agentKind: IdeAgentKind;
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
      agentKind: 'pi' as const,
      runtimeLabel: 'PI / NATIVE',
      continuityTitle: 'Pi, native to VS Code',
      continuityBody: 'Use Codeflare Chat in the panel or editor Inline Chat. Both surfaces share one IDE-owned Pi conversation with the same tools, skills, subagents, MCP servers, and root-level container access as the main Codeflare environment.',
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
      agentKind: 'claude' as const,
      runtimeLabel: 'CLAUDE / OFFICIAL',
      continuityTitle: 'Official Claude Code panel',
      continuityBody: 'Use Anthropic’s official native VS Code experience, connected to the same Codeflare-managed Claude environment, workspace, tools, skills, plugins, and available MCP servers.',
      action: Object.freeze({
        label: 'Open Claude Code',
        command: 'claude-vscode.sidebar.open',
        arguments: Object.freeze([]),
      }),
    });
  }
  return Object.freeze({
    agentEnabled: false,
    agentKind: 'none' as const,
    runtimeLabel: 'EDITOR / STANDARD',
    continuityTitle: 'Full editor, no injected agent',
    continuityBody: 'VS Code remains completely functional. Use the editor, terminal, source control, debugger, and extensions without an agent panel being added.',
    action: Object.freeze({
      label: 'Explore Workspace',
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
  const agentKind = escapeHtml(presentation.agentKind);
  const runtimeLabel = escapeHtml(presentation.runtimeLabel);
  const continuityTitle = escapeHtml(presentation.continuityTitle);
  const continuityBody = escapeHtml(presentation.continuityBody);
  const actionLabel = escapeHtml(presentation.action.label);
  const agentState = presentation.agentEnabled ? 'NATIVE AGENT' : 'EDITOR ONLY';

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
    grid-template-columns: minmax(0, 1.15fr) minmax(320px, .85fr);
    gap: clamp(36px, 6vw, 80px);
    padding: clamp(56px, 9vh, 96px) 0 clamp(48px, 8vh, 76px);
    align-items: stretch;
  }
  .hero-copy { align-self: center; }
  h1 {
    max-width: 780px;
    margin: 0;
    color: var(--vscode-editor-foreground);
    font-size: clamp(42px, 6vw, 72px);
    font-weight: 580;
    letter-spacing: -.04em;
    line-height: .98;
    text-wrap: balance;
  }
  h1 span { color: var(--vscode-descriptionForeground); }
  .lede {
    max-width: 68ch;
    margin: 28px 0 0;
    color: var(--vscode-descriptionForeground);
    font-size: clamp(16px, 2vw, 19px);
    line-height: 1.6;
  }
  .active-plane {
    position: relative;
    display: flex;
    min-height: 320px;
    flex-direction: column;
    justify-content: space-between;
    border: 1px solid var(--vscode-panel-border);
    padding: 30px;
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
  }
  .active-plane::before {
    content: '';
    position: absolute;
    inset: -1px -1px auto;
    height: 2px;
    background: var(--vscode-charts-orange, #d66a45);
  }
  .active-meta {
    margin: 0 0 42px;
    color: var(--vscode-descriptionForeground);
    font-family: var(--vscode-editor-font-family);
    font-size: 11px;
    letter-spacing: .1em;
    text-transform: uppercase;
  }
  .active-plane h2 { margin: 0 0 12px; font-size: clamp(22px, 3vw, 30px); font-weight: 590; letter-spacing: -.025em; }
  .active-body { max-width: 52ch; margin: 0; color: var(--vscode-descriptionForeground); font-size: 14px; line-height: 1.65; }
  .primary {
    display: inline-flex;
    min-height: 42px;
    width: fit-content;
    margin-top: 30px;
    align-items: center;
    gap: 10px;
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 2px;
    padding: 10px 15px;
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
    cursor: pointer;
    transition: background-color 160ms ease, transform 160ms ease;
  }
  .primary:hover { background: var(--vscode-button-hoverBackground); transform: translateY(-1px); }
  .primary:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 3px; }
  .primary svg { width: 16px; height: 16px; }
  .foundations {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    border-top: 1px solid var(--vscode-panel-border);
    border-bottom: 1px solid var(--vscode-panel-border);
  }
  .foundation { padding: 34px 30px 38px; }
  .foundation + .foundation { border-left: 1px solid var(--vscode-panel-border); }
  .foundation-label {
    display: block;
    margin-bottom: 28px;
    color: var(--vscode-charts-orange, #d66a45);
    font-family: var(--vscode-editor-font-family);
    font-size: 10px;
    letter-spacing: .1em;
    text-transform: uppercase;
  }
  .foundation h2 { margin: 0 0 10px; font-size: 18px; font-weight: 590; }
  .foundation p { max-width: 58ch; margin: 0; color: var(--vscode-descriptionForeground); font-size: 13px; line-height: 1.6; }
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
    .hero { grid-template-columns: 1fr; padding-top: 46px; }
    .active-plane { min-height: 0; }
    .foundations { grid-template-columns: 1fr; }
    .foundation + .foundation { border-left: 0; border-top: 1px solid var(--vscode-panel-border); }
    .foundation-label { margin-bottom: 18px; }
    .footer { flex-direction: column; }
  }
  @media (prefers-reduced-motion: reduce) {
    .primary { transition: none; }
    .primary:hover { transform: none; }
  }
</style>
</head>
<body>
<main class="shell" data-agent-kind="${agentKind}">
  <header class="masthead">
    <div class="wordmark">
      <svg class="mark" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M3 3h8v3H6v12h5v3H3V3Zm10 0h8v8h-3V6h-5V3Zm0 15h5v-5h3v8h-8v-3Z"/></svg>
      Codeflare
    </div>
    <div class="runtime">${runtimeLabel}</div>
  </header>

  <section class="hero">
    <div class="hero-copy">
      <h1>Full VS Code.<br><span>Native agent workflows.</span></h1>
      <p class="lede">Every Codeflare session includes full VS Code, attached to the same isolated container, workspace, terminal, and toolchain as the main session. It is the direct editing and observability plane for the native agent workflow running beside it.</p>
    </div>
    <aside class="active-plane" data-agent-experience="${agentKind}" aria-label="Selected session experience">
      <div>
        <p class="active-meta">${agentState} · ${runtimeLabel}</p>
        <h2>${continuityTitle}</h2>
        <p class="active-body">${continuityBody}</p>
      </div>
      <button class="primary" id="primary" type="button">
        ${actionLabel}
        <svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M3 7.25h7.2L7.4 4.4 8.8 3l5.2 5-5.2 5-1.4-1.4 2.8-2.85H3v-1.5Z"/></svg>
      </button>
    </aside>
  </section>

  <section class="foundations" aria-label="Shared Codeflare foundations">
    <article class="foundation" data-foundation="editor">
      <span class="foundation-label">Universal editor</span>
      <h2>Complete in every session</h2>
      <p>Edit, navigate, debug, search, use Git, run terminals, and work with extensions through the full browser-based VS Code experience.</p>
    </article>
    <article class="foundation" data-foundation="runtime">
      <span class="foundation-label">Shared runtime</span>
      <h2>One live workspace</h2>
      <p>The editor, terminal, application, and selected agent operate against the same ephemeral filesystem and toolchain. Changes appear everywhere immediately.</p>
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
