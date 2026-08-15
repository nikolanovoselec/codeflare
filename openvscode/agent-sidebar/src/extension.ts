import {
  EventEmitter,
  Uri,
  chat,
  commands,
  lm,
  window,
  type ExtensionContext,
  type LanguageModelChatInformation,
  type LanguageModelChatProvider,
} from 'vscode';

import { ApprovalBridge } from './pi/approval-bridge.ts';
import {
  NativePiRuntime,
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
const CONTINUE_INLINE_CHAT_COMMAND = 'inlineChat2.continueInChat';
// The pinned extension host still resolves an absent request model only from
// its reserved Copilot vendor. Keep that fallback hidden, and expose a distinct
// Codeflare vendor so the visible picker bypasses Copilot entitlement/setup.
// Both adapters are inert; the participant performs inference through Pi RPC.
const HOST_FALLBACK_VENDOR = 'copilot';
const HOST_VISIBLE_VENDOR = 'codeflare';
const HOST_MODEL_FAMILY = 'codeflare-pi-rpc';
const CHAT_LOCATION_PANEL = 1 as const;
const CHAT_LOCATION_EDITOR = 4 as const;
const HOST_FALLBACK_MODEL: LanguageModelChatInformation & {
  readonly isDefault: Readonly<Record<typeof CHAT_LOCATION_PANEL, true>>;
  readonly isUserSelectable: false;
} = Object.freeze({
  id: 'host-compatibility',
  name: 'Codeflare',
  family: HOST_MODEL_FAMILY,
  version: '1',
  maxInputTokens: 1,
  maxOutputTokens: 1,
  capabilities: Object.freeze({}),
  isDefault: Object.freeze({ [CHAT_LOCATION_PANEL]: true as const }),
  isUserSelectable: false,
});
const HOST_VISIBLE_MODEL: LanguageModelChatInformation & {
  readonly isDefault: Readonly<Record<
    typeof CHAT_LOCATION_PANEL | typeof CHAT_LOCATION_EDITOR,
    true
  >>;
  readonly isUserSelectable: true;
} = Object.freeze({
  id: 'host-visible',
  name: 'Codeflare',
  family: HOST_MODEL_FAMILY,
  version: '1',
  maxInputTokens: 1,
  maxOutputTokens: 1,
  capabilities: Object.freeze({ toolCalling: true }),
  isDefault: Object.freeze({
    [CHAT_LOCATION_PANEL]: true as const,
    [CHAT_LOCATION_EDITOR]: true as const,
  }),
  isUserSelectable: true,
});
const failClosedCompatibilityResponse = async (): Promise<never> => {
  throw new Error('Codeflare host compatibility model cannot generate responses');
};
const hostCompatibilityProvider = (
  model: LanguageModelChatInformation,
  onDidChangeLanguageModelChatInformation: LanguageModelChatProvider['onDidChangeLanguageModelChatInformation'],
): LanguageModelChatProvider => Object.freeze({
  onDidChangeLanguageModelChatInformation,
  provideLanguageModelChatInformation: () => [model],
  provideLanguageModelChatResponse: failClosedCompatibilityResponse,
  provideTokenCount: async () => 0,
});
let activeRuntime: NativePiRuntime | undefined;

export async function activate(context: ExtensionContext): Promise<void> {
  // Code OSS contributes Copilot setup/status chrome while Chat setup remains
  // visible. Hiding that upstream setup state keeps the account-free Codeflare
  // participant available while removing the unrelated Sign In affordance;
  // completion still suppresses the remaining setup actions.
  await commands.executeCommand('setContext', 'chatSetupHidden', true);
  await commands.executeCommand('setContext', 'chatSetupCompleted', true);
  const runtime = new NativePiRuntime(createBackend, runNativePiChat);
  const modelChanges = new EventEmitter<void>();
  const hostFallbackProvider = lm.registerLanguageModelChatProvider(
    HOST_FALLBACK_VENDOR,
    hostCompatibilityProvider(HOST_FALLBACK_MODEL, modelChanges.event),
  );
  const hostVisibleProvider = lm.registerLanguageModelChatProvider(
    HOST_VISIBLE_VENDOR,
    hostCompatibilityProvider(HOST_VISIBLE_MODEL, modelChanges.event),
  );
  // Registration alone does not populate Code OSS's language-model cache. A
  // provider change resolves both descriptors and refreshes model pickers before
  // the first request, rather than only after later chat activity.
  modelChanges.fire();
  const participant = chat.createChatParticipant(
    PARTICIPANT_ID,
    async (request, chatContext, response, cancellation) => {
      if ('location' in request && request.location === CHAT_LOCATION_EDITOR) {
        if (cancellation.isCancellationRequested) return;
        // Code OSS 1.132 Inline Chat displays host-owned edit transactions and
        // filters ordinary participant text. Pi edits directly with unrestricted
        // tools, so use the host's native continuation path before inference
        // instead of running a turn against a response stream the user cannot see.
        await commands.executeCommand(CONTINUE_INLINE_CHAT_COMMAND);
        return;
      }
      await runtime.handle({
        input: collectNativePiPromptInput(request, chatContext),
        response: {
          markdown: (value) => response.markdown(value),
          progress: (value) => response.progress(value),
        },
        cancellation,
      });
    },
  );
  const reviewFile = commands.registerCommand(
    REVIEW_FILE_COMMAND,
    (resource?: unknown) => openFileReview(resource),
  );
  participant.iconPath = Uri.joinPath(context.extensionUri, 'media', 'agent.svg');
  activeRuntime = runtime;
  context.subscriptions.push(
    modelChanges,
    hostFallbackProvider,
    hostVisibleProvider,
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

function createBackend(): PiRpcBackend {
  return new PiRpcBackend(
    new NodePiProcessSpawner(),
    new ApprovalBridge(new VsCodeApprovalHost()),
  );
}
