import {
  Uri,
  chat,
  lm,
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
import { collectNativePiPromptInput } from './pi/vscode-native-chat.ts';

const PARTICIPANT_ID = 'codeflare.pi';
const HOST_MODEL_VENDOR = 'codeflare-pi-rpc';
const HOST_COMPATIBILITY_MODEL: LanguageModelChatInformation & {
  readonly isDefault: true;
  readonly isUserSelectable: false;
} = Object.freeze({
  id: 'host-compatibility',
  name: 'Codeflare Pi',
  family: HOST_MODEL_VENDOR,
  version: '1',
  maxInputTokens: 1,
  maxOutputTokens: 1,
  capabilities: Object.freeze({}),
  isDefault: true,
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
  participant.iconPath = Uri.joinPath(context.extensionUri, 'media', 'agent.svg');
  activeRuntime = runtime;
  context.subscriptions.push(
    hostModelProvider,
    participant,
    { dispose: () => { void runtime.dispose(); } },
  );
}

export async function deactivate(): Promise<void> {
  const runtime = activeRuntime;
  activeRuntime = undefined;
  await runtime?.dispose();
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
