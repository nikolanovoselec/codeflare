import {
  EventEmitter,
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
  type Selection,
  type TextDocument,
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
};

type InlineEditorLocation = {
  readonly document: TextDocument;
  readonly selection: Selection;
  readonly wholeRange: Range;
};

type ThinkingResponseStream = {
  thinkingProgress(delta: { readonly id: string; readonly text: string }): void;
};

type InlineDiagnostics = {
  begin(document: TextDocument, selection: Selection): string;
  streamed(requestId: string, target: Uri): void;
  dispose(): void;
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
let activeInlineDiagnostics: InlineDiagnostics | undefined;

export async function activate(context: ExtensionContext): Promise<void> {
  // Code OSS contributes Copilot setup/status chrome while Chat setup remains
  // visible. Hiding that upstream setup state keeps the account-free Codeflare
  // participant available while removing the unrelated Sign In affordance;
  // completion still suppresses the remaining setup actions.
  await commands.executeCommand('setContext', 'chatSetupHidden', true);
  await commands.executeCommand('setContext', 'chatSetupCompleted', true);
  const inlineDiagnostics = createInlineDiagnostics();
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
        const editorLocation = parseInlineEditorLocation(request);
        const document = editorLocation?.document;
        if (!editorLocation || !document || document.isClosed || document.uri.scheme !== 'file') {
          await window.showWarningMessage('Native Inline Chat requires an active workspace file.');
          return;
        }
        const diagnosticRequestId = inlineDiagnostics.begin(document, editorLocation.selection);
        const baseVersion = document.version;
        const inlineResponse = response as typeof response & InlineEditResponseStream;
        const thinkingResponse = response as typeof response & ThinkingResponseStream;
        let proposedEditCount = 0;
        let proposalSummary: string | undefined;
        response.progress('Codeflare is preparing editor changes…');
        const input = Promise.all([
          collectNativePiPromptInput(request, chatContext, undefined, {
            document,
            selection: editorLocation.selection,
            wholeRange: editorLocation.wholeRange,
          }),
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
              inlineResponse.textEdit(document.uri, []);
              inlineResponse.textEdit(document.uri, validated.map((edit) => TextEdit.replace(
                new Range(edit.startLine, edit.startCharacter, edit.endLine, edit.endCharacter),
                edit.newText,
              )));
              inlineResponse.textEdit(document.uri, true);
              inlineDiagnostics.streamed(diagnosticRequestId, document.uri);
            },
          },
          cancellation,
        });
        if (cancellation.isCancellationRequested) return;
        if (!proposalSummary) throw new Error('Native Inline Chat completed without a validated proposal');
        const plural = proposedEditCount === 1 ? '' : 's';
        return {
          details: `${proposalSummary} ${proposedEditCount} proposed edit${plural}.`,
          metadata: {},
        };
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
  activeInlineDiagnostics = inlineDiagnostics;
  context.subscriptions.push(
    inlineDiagnostics,
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
  const diagnostics = activeInlineDiagnostics;
  activeRuntime = undefined;
  activeInlineDiagnostics = undefined;
  diagnostics?.dispose();
  await runtime?.dispose();
}

const INLINE_DIAGNOSTIC_REVISION = 'uri-authority-probe-v2';
const MAX_INLINE_DIAGNOSTIC_TAB_EVENTS = 16;
const MAX_INLINE_DIAGNOSTIC_LINE_LENGTH = 12_000;

function createInlineDiagnostics(): InlineDiagnostics {
  const output = window.createOutputChannel('Codeflare Inline Chat');
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let sequence = 0;
  let disposed = false;
  let active: { readonly requestId: string; tabEvents: number } | undefined;

  const log = (message: string): void => {
    if (disposed) return;
    const bounded = message.length <= MAX_INLINE_DIAGNOSTIC_LINE_LENGTH
      ? message
      : `${message.slice(0, MAX_INLINE_DIAGNOSTIC_LINE_LENGTH)}…`;
    output.appendLine(`${new Date().toISOString()} ${bounded}`);
  };
  const snapshot = (): string => describeTabSnapshot();
  const schedule = (callback: () => void, delay: number): void => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      callback();
    }, delay);
    if (typeof timer === 'object' && 'unref' in timer && typeof timer.unref === 'function') {
      timer.unref();
    }
    timers.add(timer);
  };

  log([
    `activation revision=${INLINE_DIAGNOSTIC_REVISION}`,
    `openChatEditedFiles=${String(workspace.getConfiguration().get('accessibility.openChatEditedFiles'))}`,
    `disableAIFeatures=${String(workspace.getConfiguration().get('chat.disableAIFeatures'))}`,
    snapshot(),
  ].join(' '));

  const tabListener = window.tabGroups.onDidChangeTabs((event) => {
    if (!active || active.tabEvents >= MAX_INLINE_DIAGNOSTIC_TAB_EVENTS) return;
    active.tabEvents += 1;
    log([
      `tabsChanged request=${active.requestId}`,
      `opened=${describeChangedTabs(event.opened)}`,
      `closed=${describeChangedTabs(event.closed)}`,
      `changed=${describeChangedTabs(event.changed)}`,
      snapshot(),
    ].join(' '));
  });

  return {
    begin(document, selection) {
      sequence += 1;
      const requestId = `inline-${sequence}`;
      active = { requestId, tabEvents: 0 };
      log([
        `request=${requestId}`,
        'location=4',
        'hasLocation2=true',
        `docUri=${describeUri(document.uri)}`,
        `version=${document.version}`,
        `selection=${selection.start.line}:${selection.start.character}-${selection.end.line}:${selection.end.character}`,
        snapshot(),
      ].join(' '));
      schedule(() => {
        if (active?.requestId === requestId) active = undefined;
      }, 15_000);
      return requestId;
    },
    streamed(requestId, target) {
      if (active?.requestId !== requestId) return;
      log(`stream=${requestId} targetUri=${describeUri(target)} snapshot=immediate ${snapshot()}`);
      schedule(() => {
        if (active?.requestId === requestId) {
          log(`stream=${requestId} targetUri=${describeUri(target)} snapshot=3s ${snapshot()}`);
        }
      }, 3_000);
      schedule(() => {
        if (active?.requestId === requestId) {
          log(`stream=${requestId} targetUri=${describeUri(target)} snapshot=8s ${snapshot()}`);
          active = undefined;
        }
      }, 8_000);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      active = undefined;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      tabListener.dispose();
      output.dispose();
    },
  };
}

function describeTabSnapshot(): string {
  const groups = window.tabGroups.all;
  const tabs = groups.flatMap((group, groupIndex) => group.tabs.slice(0, 32).map((tab) => ({
    group: groupIndex,
    groupActive: group.isActive,
    tab: describeTab(tab),
  })));
  return `groups=${groups.length} tabs=${tabs.length} tabData=${JSON.stringify(tabs)}`;
}

function describeChangedTabs(tabs: readonly unknown[]): string {
  return JSON.stringify(tabs.slice(0, 32).map(describeTab));
}

function describeTab(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return { inputType: typeof value };
  const input = value.input;
  const inputConstructor = isRecord(input) ? input.constructor : undefined;
  const inputType = typeof inputConstructor === 'function'
    ? inputConstructor.name
    : typeof input;
  return {
    active: typeof value.isActive === 'boolean' ? value.isActive : undefined,
    inputType,
    uri: isRecord(input) ? describeUri(input.uri) : undefined,
    original: isRecord(input) ? describeUri(input.original) : undefined,
    modified: isRecord(input) ? describeUri(input.modified) : undefined,
  };
}

function describeUri(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.scheme !== 'string') return undefined;
  const rawAuthority = typeof value.authority === 'string' ? value.authority : '';
  const userInfoEnd = rawAuthority.lastIndexOf('@');
  const authority = userInfoEnd >= 0 ? rawAuthority.slice(userInfoEnd + 1) : rawAuthority;
  const path = typeof value.path === 'string'
    ? value.path
    : typeof value.fsPath === 'string' ? value.fsPath : '';
  const normalizedPath = path.replaceAll('\\', '/').replace(/\/+$/, '');
  const resourceName = normalizedPath.slice(normalizedPath.lastIndexOf('/') + 1) || '<resource>';
  return `${value.scheme}://${authority}/${resourceName}`;
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

function parseInlineEditorLocation(request: unknown): InlineEditorLocation | undefined {
  if (!isRecord(request) || !isRecord(request.location2)) return undefined;
  const { document, selection, wholeRange } = request.location2;
  if (!isTextDocument(document) || !isSelection(selection) || !isRange(wholeRange)) return undefined;
  return { document, selection, wholeRange };
}

function isTextDocument(value: unknown): value is TextDocument {
  return isRecord(value)
    && isUriResource(value.uri)
    && typeof value.version === 'number'
    && Number.isSafeInteger(value.version)
    && typeof value.lineCount === 'number'
    && Number.isSafeInteger(value.lineCount)
    && typeof value.languageId === 'string'
    && typeof value.isDirty === 'boolean'
    && typeof value.isClosed === 'boolean'
    && typeof value.getText === 'function'
    && typeof value.lineAt === 'function';
}

function isSelection(value: unknown): value is Selection {
  return isRange(value) && typeof value.isEmpty === 'boolean';
}

function isRange(value: unknown): value is Range {
  return isRecord(value) && isPosition(value.start) && isPosition(value.end);
}

function isPosition(value: unknown): value is { readonly line: number; readonly character: number } {
  return isRecord(value)
    && typeof value.line === 'number'
    && Number.isSafeInteger(value.line)
    && value.line >= 0
    && typeof value.character === 'number'
    && Number.isSafeInteger(value.character)
    && value.character >= 0;
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
