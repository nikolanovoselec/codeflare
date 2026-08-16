import { randomBytes } from 'node:crypto';
import {
  Uri,
  ViewColumn,
  commands,
  window,
  type ExtensionContext,
  type WebviewPanel,
} from 'vscode';

import {
  buildWelcomePresentation,
  normalizeIdeAgentKind,
  renderWelcomeHtml,
} from './welcome.ts';
import { activateExtensionPersistence } from './extension-persistence.ts';

export { activateExtensionPersistence } from './extension-persistence.ts';

const OPEN_WELCOME_COMMAND = 'codeflare.welcome.open';
const OPEN_DELAY_MS = 250;

export function activate(context: ExtensionContext): void {
  void activateExtensionPersistence(context).catch(() => undefined);
  const presentation = buildWelcomePresentation(
    normalizeIdeAgentKind(process.env.CODEFLARE_SIDEBAR_AGENT),
  );
  let panel: WebviewPanel | undefined;

  const openWelcome = () => {
    if (panel) {
      panel.reveal(ViewColumn.One);
      return;
    }
    panel = window.createWebviewPanel(
      'codeflare.welcome',
      'Welcome to Codeflare',
      ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [],
      },
    );
    panel.iconPath = Uri.joinPath(context.extensionUri, 'media', 'agent.svg');
    panel.webview.html = renderWelcomeHtml(
      presentation,
      randomBytes(18).toString('base64url'),
    );
    const messages = panel.webview.onDidReceiveMessage(async (message: unknown) => {
      if (!isPrimaryAction(message)) return;
      await commands.executeCommand(
        presentation.action.command,
        ...presentation.action.arguments,
      );
    });
    panel.onDidDispose(() => {
      messages.dispose();
      panel = undefined;
    });
  };

  const startupTimer = setTimeout(openWelcome, OPEN_DELAY_MS);
  context.subscriptions.push(
    commands.registerCommand(OPEN_WELCOME_COMMAND, openWelcome),
    { dispose: () => clearTimeout(startupTimer) },
    { dispose: () => panel?.dispose() },
  );
}

function isPrimaryAction(value: unknown): value is { readonly type: 'primary' } {
  return typeof value === 'object'
    && value !== null
    && 'type' in value
    && value.type === 'primary';
}
