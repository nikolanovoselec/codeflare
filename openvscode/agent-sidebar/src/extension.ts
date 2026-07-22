import { randomBytes } from 'node:crypto';

import {
  Uri,
  window,
  type Disposable,
  type ExtensionContext,
  type Webview,
  type WebviewView,
  type WebviewViewProvider,
} from 'vscode';

import type { Backend, BackendFactories, BackendKind } from './backend.ts';
import { ClaudePtyBackend, NodePtySpawner, type ClaudePtySink } from './claude/node-pty-backend.ts';
import { SidebarLifecycle, selectBackendKind } from './lifecycle.ts';
import { WebviewMessageAuthority, type AuthorizedWebviewMessage } from './message-schema.ts';
import { ApprovalBridge } from './pi/approval-bridge.ts';
import { NodePiProcessSpawner, PiRpcBackend, type PiRpcSink } from './pi/node-rpc-backend.ts';
import { VsCodeApprovalHost } from './pi/vscode-approval-host.ts';
import { createWebviewDocument } from './webview-security.ts';

const VIEW_ID = 'codeflare.agentSidebar';
const MESSAGE_LIMITS = { maxPromptBytes: 256 * 1024, maxTerminalInputBytes: 64 * 1024 };
let activeController: AgentSidebarController | undefined;

export function activate(context: ExtensionContext): void {
  const selected = selectBackendKind(process.env.CODEFLARE_SIDEBAR_AGENT);
  const controller = new AgentSidebarController(context, selected);
  activeController = controller;
  context.subscriptions.push(
    window.registerWebviewViewProvider(VIEW_ID, controller, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    { dispose: () => { void controller.dispose(); } },
  );
}

export async function deactivate(): Promise<void> {
  const controller = activeController;
  activeController = undefined;
  await controller?.dispose();
}

class AgentSidebarController implements WebviewViewProvider {
  readonly #context: ExtensionContext;
  readonly #selected: BackendKind;
  readonly #authority = new WebviewMessageAuthority(MESSAGE_LIMITS);
  readonly #lifecycle: SidebarLifecycle;
  #webview: Webview | undefined;
  #viewDisposables: Disposable[] = [];
  #disposed = false;

  constructor(context: ExtensionContext, selected: BackendKind) {
    this.#context = context;
    this.#selected = selected;
    const approvalBridge = new ApprovalBridge(new VsCodeApprovalHost());
    const factories: BackendFactories = {
      pi: () => new PiRpcBackend(new NodePiProcessSpawner(), approvalBridge, this.#piSink()),
      claude: () => new ClaudePtyBackend(new NodePtySpawner(), this.#claudeSink()),
    };
    this.#lifecycle = new SidebarLifecycle(selected, factories);
    this.#lifecycle.activate();
  }

  async resolveWebviewView(view: WebviewView): Promise<void> {
    if (this.#disposed) return;
    for (const disposable of this.#viewDisposables.splice(0)) disposable.dispose();
    this.#webview = view.webview;
    this.#configureWebview(view.webview);
    this.#viewDisposables.push(
      view.webview.onDidReceiveMessage((value: unknown) => {
        void this.#handleWebviewMessage(value);
      }),
      view.onDidChangeVisibility(() => {
        if (view.visible) void this.#ensureStarted();
      }),
      view.onDidDispose(() => {
        this.#webview = undefined;
        for (const disposable of this.#viewDisposables.splice(0)) disposable.dispose();
      }),
    );
    if (view.visible) await this.#ensureStarted();
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#webview = undefined;
    for (const disposable of this.#viewDisposables.splice(0)) disposable.dispose();
    await this.#lifecycle.deactivate();
  }

  #configureWebview(webview: Webview): void {
    const webviewRoot = Uri.joinPath(this.#context.extensionUri, 'dist', 'webview');
    webview.options = {
      enableScripts: true,
      enableCommandUris: false,
      localResourceRoots: [webviewRoot],
    };
    const scriptName = this.#selected === 'pi' ? 'chat.js' : 'terminal.js';
    const styleName = this.#selected === 'pi' ? 'styles.css' : 'terminal.css';
    const document = createWebviewDocument({
      backend: this.#selected,
      cspSource: webview.cspSource,
      nonce: randomBytes(24).toString('base64url'),
      scriptUri: webview.asWebviewUri(Uri.joinPath(webviewRoot, scriptName)).toString(),
      styleUri: webview.asWebviewUri(Uri.joinPath(webviewRoot, styleName)).toString(),
    });
    webview.html = document.html;
  }

  async #ensureStarted(): Promise<Backend> {
    if (this.#disposed) throw new Error('Sidebar is disposed');
    return this.#lifecycle.resolveVisible();
  }

  async #handleWebviewMessage(value: unknown): Promise<void> {
    if (this.#disposed) return;
    let message: AuthorizedWebviewMessage;
    try {
      message = this.#authority.parse(this.#selected, value);
      const backend = await this.#ensureStarted();
      await dispatchMessage(backend, message);
    } catch {
      this.#post({ type: 'sidebar.error', message: 'The sidebar request was rejected.' });
    }
  }

  #piSink(): PiRpcSink {
    return {
      output: (text) => this.#post({ type: 'pi.output', text }),
      reset: () => this.#post({ type: 'conversation.reset' }),
      failed: (reason) => this.#post({ type: 'sidebar.error', message: reason }),
    };
  }

  #claudeSink(): ClaudePtySink {
    return {
      output: (data) => this.#post({ type: 'terminal.output', data }),
      reset: () => this.#post({ type: 'conversation.reset' }),
      failed: (reason) => this.#post({ type: 'sidebar.error', message: reason }),
    };
  }

  #post(message: Readonly<Record<string, unknown>>): void {
    if (!this.#webview || this.#disposed) return;
    void this.#webview.postMessage(message);
  }
}

async function dispatchMessage(backend: Backend, message: AuthorizedWebviewMessage): Promise<void> {
  if (backend instanceof PiRpcBackend) {
    if (message.type === 'prompt') await backend.prompt(message.message);
    else if (message.type === 'abort') await backend.abort();
    else if (message.type === 'pi.cycleModel') await backend.cycleModel();
    else if (message.type === 'pi.cycleThinking') await backend.cycleThinkingLevel();
    else if (message.type === 'newConversation') await backend.newConversation();
    return;
  }
  if (backend instanceof ClaudePtyBackend) {
    if (message.type === 'terminal.input') backend.write(message.data);
    else if (message.type === 'terminal.resize') backend.resize({ columns: message.columns, rows: message.rows });
    else if (message.type === 'abort') backend.abort();
    else if (message.type === 'newConversation') await backend.newConversation();
  }
}
