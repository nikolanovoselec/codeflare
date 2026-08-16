import {
  EventEmitter,
  MarkdownString,
  Range,
  TextEdit,
  Uri,
  chat,
  commands,
  lm,
  window,
  workspace,
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
import { validateInlineTextEdits } from './pi/inline-edit-validation.ts';
import {
  canonicalWorkspaceFilePath,
  collectNativePiPromptInput,
} from './pi/vscode-native-chat.ts';

const PARTICIPANT_ID = 'codeflare.pi';
const REVIEW_FILE_COMMAND = 'codeflare.pi.reviewFile';
const OPEN_CHAT_COMMAND = 'workbench.action.chat.open';
// The pinned extension host still resolves an absent request model only from
// its reserved Copilot vendor. Keep that fallback hidden, and expose a distinct
// Codeflare vendor so the visible picker bypasses Copilot entitlement/setup.
// Both adapters are inert; the participant performs inference through Pi RPC.
const HOST_FALLBACK_VENDOR = 'copilot';
const HOST_VISIBLE_VENDOR = 'codeflare';
const HOST_MODEL_FAMILY = 'codeflare-pi-rpc';
const CHAT_LOCATION_PANEL = 1 as const;
const CHAT_LOCATION_EDITOR = 4 as const;

type InlineEditResponseStream = {
  textEdit(target: Uri, edits: TextEdit | TextEdit[] | true): void;
  confirmation(title: string, message: string | MarkdownString, data: unknown, buttons?: string[]): void;
};

type PendingInlineReview = {
  readonly requestId: string;
  readonly uri: Uri;
  readonly uriKey: string;
};

type PendingInlineReviews = {
  readonly byRequestId: Map<string, PendingInlineReview>;
  readonly currentByUri: Map<string, string>;
};

const MAX_PENDING_INLINE_REVIEWS = 32;

type ThinkingResponseStream = {
  thinkingProgress(delta: { readonly id: string; readonly text: string }): void;
};
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
  const pendingInlineReviews: PendingInlineReviews = {
    byRequestId: new Map(),
    currentByUri: new Map(),
  };
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
        const reviewDecision = parseInlineReviewDecision(request);
        if (reviewDecision !== undefined) {
          if (reviewDecision) {
            await resolveInlineReview(pendingInlineReviews, reviewDecision.requestId, reviewDecision.action);
          }
          return;
        }
        const document = window.activeTextEditor?.document;
        if (!document || document.isClosed || document.uri.scheme !== 'file') {
          await window.showWarningMessage('Native Inline Chat requires an active workspace file.');
          return;
        }
        const baseVersion = document.version;
        const inlineResponse = response as typeof response & InlineEditResponseStream;
        const thinkingResponse = response as typeof response & ThinkingResponseStream;
        let proposedEditCount = 0;
        let proposalSummary: string | undefined;
        let proposalRequestId: string | undefined;
        response.progress('Codeflare is preparing editor changes…');
        const input = Promise.all([
          collectNativePiPromptInput(request, chatContext),
          canonicalWorkspaceFilePath(document.uri),
        ]).then(([collected, canonicalPath]) => {
          if (!canonicalPath) throw new Error('Native Inline Chat target is outside the workspace');
          return collected;
        });
        await runtime.handle({
          mode: 'inline-edit',
          input,
          response: {
            markdown: () => undefined,
            progress: (value) => response.progress(value),
            thinking: (value) => thinkingResponse.thinkingProgress({
              id: 'codeflare-pi-inline-reasoning',
              text: value,
            }),
            textEdit: (edits, proposal) => {
              if (document.isClosed) throw new Error('Native Inline Chat target closed before proposal completion');
              const validated = validateInlineTextEdits({
                version: document.version,
                lineCount: document.lineCount,
                lineLength: (line) => document.lineAt(line).text.length,
              }, baseVersion, edits);
              proposedEditCount = validated.length;
              proposalSummary = proposal.summary;
              proposalRequestId = proposal.requestId;
              inlineResponse.textEdit(document.uri, validated.map((edit) => TextEdit.replace(
                new Range(edit.startLine, edit.startCharacter, edit.endLine, edit.endCharacter),
                edit.newText,
              )));
              inlineResponse.textEdit(document.uri, true);
            },
          },
          cancellation,
        });
        if (cancellation.isCancellationRequested) return;
        if (!proposalSummary || !proposalRequestId) {
          throw new Error('Native Inline Chat completed without a validated proposal');
        }
        const plural = proposedEditCount === 1 ? '' : 's';
        const details = `${proposalSummary} ${proposedEditCount} proposed edit${plural}.`;
        const review = registerInlineReview(pendingInlineReviews, proposalRequestId, document.uri);
        inlineResponse.confirmation(
          'Review Codeflare changes',
          new MarkdownString().appendText(proposalSummary),
          { kind: 'codeflare-inline-edit-review', requestId: review.requestId },
          ['Keep', 'Undo'],
        );
        void Promise.resolve(window.showInformationMessage(details, 'Keep', 'Undo')).then(async (action) => {
          if (action === 'Keep' || action === 'Undo') {
            await resolveInlineReview(pendingInlineReviews, review.requestId, action);
          }
        }).catch(() => undefined);
        return { details, metadata: {} };
      }
      const thinkingResponse = response as typeof response & ThinkingResponseStream;
      await runtime.handle({
        mode: 'chat',
        input: collectNativePiPromptInput(request, chatContext),
        response: {
          markdown: (value) => response.markdown(value),
          progress: (value) => response.progress(value),
          thinking: (value) => thinkingResponse.thinkingProgress({
            id: 'codeflare-pi-reasoning',
            text: value,
          }),
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

function parseInlineReviewDecision(request: unknown): {
  readonly requestId: string;
  readonly action: 'Keep' | 'Undo';
} | null | undefined {
  if (!isRecord(request)) return undefined;
  const accepted = request.acceptedConfirmationData;
  const rejected = request.rejectedConfirmationData;
  if (accepted === undefined && rejected === undefined) return undefined;
  if ((accepted !== undefined && !Array.isArray(accepted))
    || (rejected !== undefined && !Array.isArray(rejected))) return null;
  const acceptedItems = Array.isArray(accepted) ? accepted : [];
  const rejectedItems = Array.isArray(rejected) ? rejected : [];
  if (acceptedItems.length + rejectedItems.length !== 1) return null;
  const action = acceptedItems.length === 1 ? 'Keep' : 'Undo';
  const data = acceptedItems[0] ?? rejectedItems[0];
  if (!isRecord(data) || data.kind !== 'codeflare-inline-edit-review'
    || typeof data.requestId !== 'string' || data.requestId.length === 0) return null;
  return { requestId: data.requestId, action };
}

function registerInlineReview(
  pending: PendingInlineReviews,
  requestId: string,
  uri: Uri,
): PendingInlineReview {
  const uriKey = `${uri.scheme}:${uri.fsPath}`;
  const replacedRequestId = pending.currentByUri.get(uriKey);
  if (replacedRequestId) pending.byRequestId.delete(replacedRequestId);
  const duplicateRequest = pending.byRequestId.get(requestId);
  if (duplicateRequest) pending.currentByUri.delete(duplicateRequest.uriKey);

  const review = Object.freeze({ requestId, uri, uriKey });
  pending.byRequestId.set(requestId, review);
  pending.currentByUri.set(uriKey, requestId);
  while (pending.byRequestId.size > MAX_PENDING_INLINE_REVIEWS) {
    const oldestRequestId = pending.byRequestId.keys().next().value as string | undefined;
    if (!oldestRequestId) break;
    const oldest = pending.byRequestId.get(oldestRequestId);
    pending.byRequestId.delete(oldestRequestId);
    if (oldest && pending.currentByUri.get(oldest.uriKey) === oldestRequestId) {
      pending.currentByUri.delete(oldest.uriKey);
    }
  }
  return review;
}

async function resolveInlineReview(
  pending: PendingInlineReviews,
  requestId: string,
  action: 'Keep' | 'Undo',
): Promise<void> {
  const review = pending.byRequestId.get(requestId);
  if (!review || pending.currentByUri.get(review.uriKey) !== requestId) return;
  pending.byRequestId.delete(requestId);
  pending.currentByUri.delete(review.uriKey);
  const command = action === 'Keep' ? 'chatEditing.acceptFile' : 'chatEditing.discardFile';
  await commands.executeCommand(command, review.uri);
  const document = await workspace.openTextDocument(review.uri);
  await window.showTextDocument(document, { preview: false });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function createBackend(): PiRpcBackend {
  return new PiRpcBackend(
    new NodePiProcessSpawner(),
    new ApprovalBridge(new VsCodeApprovalHost()),
  );
}
