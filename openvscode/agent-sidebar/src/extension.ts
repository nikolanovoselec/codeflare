import {
  Uri,
  chat,
  commands,
  lm,
  window,
  type CancellationToken,
  type ChatContext,
  type ChatRequest,
  type ChatResponseStream,
  type ExtensionContext,
  type LanguageModelChatInformation,
  type LanguageModelChatProvider,
} from 'vscode';

import { ApprovalBridge } from './pi/approval-bridge.ts';
import {
  type NativePiBackend,
  runNativePiChat,
} from './pi/native-chat.ts';
import { NodePiProcessSpawner, PiRpcBackend } from './pi/node-rpc-backend.ts';
import { VsCodeApprovalHost } from './pi/vscode-approval-host.ts';
import {
  canonicalWorkspaceFilePath,
  collectNativePiPromptInput,
} from './pi/vscode-native-chat.ts';

const PARTICIPANT_ID = 'codeflare.pi';
const REVIEW_FILE_COMMAND = 'codeflare.pi.reviewFile';
const OPEN_CHAT_COMMAND = 'workbench.action.chat.open';
// Code OSS 1.130 resolves a participant's implicit default only from its
// reserved fallback vendor. This is an internal selection key, not a GitHub
// Copilot integration: the model remains hidden, account-free, and inert.
const HOST_MODEL_VENDOR = 'copilot';
const HOST_MODEL_FAMILY = 'codeflare-pi-rpc';
const CHAT_LOCATION_PANEL = 1 as const;
const HOST_COMPATIBILITY_MODEL: LanguageModelChatInformation & {
  readonly isDefault: Readonly<Record<typeof CHAT_LOCATION_PANEL, true>>;
  readonly isUserSelectable: false;
} = Object.freeze({
  id: 'host-compatibility',
  name: 'Codeflare Pi',
  family: HOST_MODEL_FAMILY,
  version: '1',
  maxInputTokens: 1,
  maxOutputTokens: 1,
  capabilities: Object.freeze({}),
  isDefault: Object.freeze({ [CHAT_LOCATION_PANEL]: true as const }),
  isUserSelectable: false,
});
const HOST_COMPATIBILITY_PROVIDER: LanguageModelChatProvider = Object.freeze({
  provideLanguageModelChatInformation: () => [HOST_COMPATIBILITY_MODEL],
  provideLanguageModelChatResponse: async () => {
    throw new Error('Codeflare Pi host compatibility model cannot generate responses');
  },
  provideTokenCount: async () => 0,
});
let activeRuntime: NativePiRuntime | undefined;

export function activate(context: ExtensionContext): void {
  const runtime = new NativePiRuntime();
  const hostModelProvider = lm.registerLanguageModelChatProvider(
    HOST_MODEL_VENDOR,
    HOST_COMPATIBILITY_PROVIDER,
  );
  const participant = chat.createChatParticipant(
    PARTICIPANT_ID,
    (request, chatContext, response, cancellation) => runtime.handle(
      request,
      chatContext,
      response,
      cancellation,
    ),
  );
  const reviewFile = commands.registerCommand(
    REVIEW_FILE_COMMAND,
    (resource?: unknown) => openFileReview(resource),
  );
  participant.iconPath = Uri.joinPath(context.extensionUri, 'media', 'agent.svg');
  activeRuntime = runtime;
  context.subscriptions.push(
    hostModelProvider,
    participant,
    reviewFile,
    { dispose: () => { void runtime.dispose(); } },
  );
}

export async function deactivate(): Promise<void> {
  const runtime = activeRuntime;
  activeRuntime = undefined;
  await runtime?.dispose();
}

async function openFileReview(resource: unknown): Promise<void> {
  const selectedResource = isUriResource(resource)
    ? resource
    : window.activeTextEditor?.document.uri;
  if (
    selectedResource?.scheme !== 'file'
    || typeof selectedResource.fsPath !== 'string'
    || selectedResource.fsPath.length === 0
  ) {
    await window.showWarningMessage('Review with Codeflare is available only for workspace files.');
    return;
  }
  const canonicalPath = await canonicalWorkspaceFilePath(selectedResource);
  if (!canonicalPath) {
    await window.showWarningMessage('Review with Codeflare is available only for workspace files.');
    return;
  }
  const file = Uri.file(canonicalPath);
  await commands.executeCommand(OPEN_CHAT_COMMAND, {
    query: '@codeflare Review the attached file. Report concrete correctness, security, and maintainability findings with line references.',
    attachFiles: [file],
    mode: 'ask',
  });
}

function isUriResource(value: unknown): value is Uri {
  return typeof value === 'object'
    && value !== null
    && 'scheme' in value
    && typeof value.scheme === 'string'
    && 'fsPath' in value
    && typeof value.fsPath === 'string';
}

class NativePiRuntime {
  readonly #active = new Set<NativePiBackend>();
  #disposed = false;

  async handle(
    request: ChatRequest,
    context: ChatContext,
    response: ChatResponseStream,
    cancellation: CancellationToken,
  ): Promise<void> {
    if (this.#disposed || cancellation.isCancellationRequested) return;
    const input = await collectNativePiPromptInput(request, context);
    let backend: NativePiBackend | undefined;
    try {
      await runNativePiChat({
        input,
        response: {
          markdown: (value) => response.markdown(value),
          progress: (value) => response.progress(value),
        },
        cancellation,
        createBackend: () => {
          if (this.#disposed) throw new Error('Codeflare Pi Chat is disposed');
          backend = createBackend();
          this.#active.add(backend);
          return backend;
        },
      });
    } finally {
      if (backend) this.#active.delete(backend);
    }
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    const active = [...this.#active];
    this.#active.clear();
    await Promise.all(active.map((backend) => backend.stop()));
  }
}

function createBackend(): PiRpcBackend {
  return new PiRpcBackend(
    new NodePiProcessSpawner(),
    new ApprovalBridge(new VsCodeApprovalHost()),
  );
}
