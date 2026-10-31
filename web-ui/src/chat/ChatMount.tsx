/** @jsxImportSource react */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LayerHostProvider } from '@blackbelt-technology/pi-dashboard-client-utils/LayerPortal';
import { DISPLAY_PRESETS } from '@blackbelt-technology/pi-dashboard-shared/display-prefs.js';
import type { DashboardSession, FollowUpEntryView } from '@blackbelt-technology/pi-dashboard-shared/types.js';
import {
  ChatView, CommandInput, QueuePanel, useSessionState, EmbedProviders,
  DisplayPrefsProvider, UiPrimitiveProvider, createHostPrimitiveRegistry, SessionAssetsProvider,
} from './upstream/client/src/chat-embed';
import { useWebSocket } from './upstream/client/src/hooks/useWebSocket';
import { useSessionActions, type SessionActionDeps } from './upstream/client/src/hooks/useSessionActions';
import { usePendingPromptTimeout } from './upstream/client/src/hooks/usePendingPromptTimeout';
import { applyPromptTimeout, deriveBannerState, type SessionState } from './upstream/client/src/lib/chat/event-reducer';
import { composerLiveness } from './upstream/client/src/lib/chat/composer-liveness';
import { SessionBanner } from './upstream/client/src/components/session/SessionBanner';
import { QuestionStack } from './upstream/client/src/components/questions/QuestionStack';
import { QuestionStackStore } from './upstream/client/src/lib/questions/question-store';
import { setQuestionTransport } from './upstream/client/src/lib/questions/questions-api';
import { setGlobalApiBase } from './upstream/client/src/lib/api/api-context';
import type { SessionAssets } from './upstream/client/src/lib/session/SessionAssetsContext';
import type { ThemeState } from './upstream/client/src/hooks/useTheme';
import { attachChatSession, ChatAttachError, createChatControlApi, probeChatControls } from './api';
import { ProviderControls } from './ProviderControls';
import { ConversationControls } from './ConversationControls';
import { ChatViewMenu } from './upstream/client/src/components/chat/ChatViewMenu';
import type { CommandInfo, ModelInfo } from '@blackbelt-technology/pi-dashboard-shared/types.js';
import type { DisplayPrefs } from '@blackbelt-technology/pi-dashboard-shared/display-prefs.js';
import { sessionStore } from '../stores/session';
import { parseControlMessage } from '../stores/terminal-protocol';
import { agentEventDisposition, createAgentEventConsumer } from '../lib/agent-notifications';
import './presentation.css';

export interface ChatMountProps {
  /** Codeflare identity; never used as the upstream protocol target. */
  sessionId: string;
  generation: number;
  boundSessionId: string;
  /** Enabled only by the protected Host probe; absent means legacy/base Chat. */
  controlsAvailable?: boolean;
  draft?: string;
  onDraftChange?: (draft: string) => void;
  onManualInput?: () => void;
  onAuthError?: (message: string) => void;
}

const HOST_THEME: ThemeState = {
  preference: 'dark', resolved: 'dark', themeName: 'base', setPreference() {}, setThemeName() {},
};
const noop = () => {};
// Unmounted Dashboard management actions need no backing shell. None of these
// callbacks are passed to ChatView/CommandInput, and the server must deny them.
const unusedActions = {
  navigate: noop, setMobileOpen: noop, setSpawningCwds: noop, setTerminals: noop,
  clearSpawningCwd: noop, spawnTimeoutsRef: { current: new Map() },
  pendingTerminalCwdRef: { current: null }, terminals: new Map(), pendingSpawnsRef: { current: new Map() },
};

// The running pre-controls Host accepts only this base protocol. Native tool
// context sends must obey the same fence as visible owner controls.
const BASE_CHAT_MESSAGES = new Set(['subscribe', 'unsubscribe', 'history_backfill', 'prompt_resync_request',
  'send_prompt', 'abort', 'prompt_response', 'extension_ui_response']);

function BoundChat(props: ChatMountProps & { layerHost: HTMLElement; onAdopt: (id: string) => void; onReattach: () => void }) {
  const id = props.boundSessionId;
  const controlsAvailable = props.controlsAvailable === true;
  const apiBase = `/api/chat/${encodeURIComponent(props.sessionId)}`;
  const url = new URL(`${apiBase}/ws`, window.location.origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('generation', String(props.generation));
  const { state, apply, update } = useSessionState(id);
  const { send, onMessage, status, ws, onOutboxExpiry, lastCloseCode } = useWebSocket(url.href, undefined, { hostAuthenticated: true });
  const [sessions, setSessions] = useState<Map<string, DashboardSession>>(() => new Map());
  const [metadata, setMetadata] = useState<Partial<DashboardSession>>({});
  const [assets, setAssets] = useState<SessionAssets>({});
  const [queue, setQueue] = useState<{ steering: string[]; followUp: FollowUpEntryView[] }>({ steering: [], followUp: [] });
  const [loading, setLoading] = useState(true);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [commands, setCommands] = useState<CommandInfo[]>([]);
  const [flowCommands, setFlowCommands] = useState<CommandInfo[]>([]);
  const [fileResults, setFileResults] = useState<React.ComponentProps<typeof CommandInput>['fileResults']>(null);
  const [controlError, setControlError] = useState('');
  const [providersOpen, setProvidersOpen] = useState(false);
  const [changingConversation, setChangingConversation] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [globalPrefs, setGlobalPrefs] = useState<DisplayPrefs>(DISPLAY_PRESETS.simple);
  const lifetime = useRef(new AbortController());
  const transition = useRef(false);
  const prefsRevision = useRef(0);
  const callbacks = useRef(props);
  callbacks.current = props;
  const api = useMemo(() => createChatControlApi(props.sessionId, props.generation,
    message => { if (!lifetime.current.signal.aborted) callbacks.current.onAuthError?.(message); }), [props.sessionId, props.generation]);
  useEffect(() => () => lifetime.current.abort(), []);
  useEffect(() => {
    if (!controlsAvailable) return;
    let current = true;
    const revision = prefsRevision.current;
    void api.envelope<DisplayPrefs | null>('/api/preferences/display', undefined, lifetime.current.signal)
      .then(prefs => { if (current && !lifetime.current.signal.aborted && revision === prefsRevision.current) setGlobalPrefs(prefs ?? DISPLAY_PRESETS.simple); })
      .catch(() => { /* Keep the embed default; the menu reports persistence failures. */ });
    return () => { current = false; };
  }, [api, controlsAvailable]);

  const questions = useMemo(() => new QuestionStackStore(), []);
  const registry = useMemo(() => createHostPrimitiveRegistry(), []);
  const stateRef = useRef(new Map<string, SessionState>());
  stateRef.current = new Map([[id, state]]);
  // Transport correlation only; the upstream reducer/native Pi still own state.
  const responseProtocols = useRef(new Map<string, 'prompt_response' | 'extension_ui_response'>());
  const ended = lastCloseCode === 4002 || metadata.status === 'ended';
  const available = status === 'connected' && !ended && !changingConversation && !uncertain;
  const advancedAvailable = controlsAvailable && available;
  const supportedCommands = controlsAvailable ? [...new Map([...commands, ...flowCommands].filter(command =>
    !/^(?:new|spawn|resume|fork|exit|quit|shutdown|restart|reload|view|codeflare-conversation|dashboard(?:-.*)?|__dashboard.*|flows:(?:new|edit|delete))$/.test(command.name)
  ).map(command => [command.name, command])).values()] : [];

  const sendAction = useCallback<SessionActionDeps['send']>(message => {
    if (!available || ws?.readyState !== WebSocket.OPEN || (!controlsAvailable && !BASE_CHAT_MESSAGES.has(message.type))) return { status: 'rejected', reason: 'no_socket' };
    if (message.type === 'send_prompt' && (typeof message.text !== 'string' || message.text.trimStart().startsWith('!')
      || (message.text.trimStart().startsWith('/') && (/[\r\n]/.test(message.text)
        || !supportedCommands.some(command => command.name === message.text.trimStart().slice(1).split(/\s/)[0]))))) return { status: 'rejected', reason: 'send_failed' };
    if (message.type === 'prompt_response' || message.type === 'extension_ui_response') {
      const requestId = message.type === 'prompt_response' ? message.promptId : message.requestId;
      if (responseProtocols.current.get(requestId) !== message.type) return;
      responseProtocols.current.delete(requestId);
    }
    return send(message);
  }, [send, available, ws, controlsAvailable, supportedCommands]);
  // Host-only controls never enter Dashboard's send/outbox/replay road.
  const sendControl = useCallback((message: Record<string, unknown>) => {
    if (ws?.readyState !== WebSocket.OPEN) return;
    try { ws.send(JSON.stringify({ ...message, sessionId: id })); }
    catch { /* a close race must not retain activity or notification controls */ }
  }, [ws, id]);

  // @impl REQ-AGENT-224 / REQ-TERM-023/028/031 — an authorized visible Chat
  // is attendance, not a terminal pane or resize owner. Trust shell identity,
  // never Dashboard metadata, notify frames or transcript text.
  useEffect(() => {
    if (!ws) return;
    const consumer = createAgentEventConsumer({
      disposition: () => agentEventDisposition({
        documentVisible: document.visibilityState === 'visible',
        windowFocused: document.hasFocus(),
        terminalView: false, terminalOnePaneFocused: false, chatView: true,
        activeSessionMatches: sessionStore.activeSessionId === props.sessionId
          && sessionStore.sessions.some(session => session.id === props.sessionId && session.agentType === 'pi'),
      }),
      context: () => {
        const session = sessionStore.sessions.find(candidate => candidate.id === props.sessionId);
        return ws.readyState === WebSocket.OPEN && session?.agentType === 'pi' ? {
          agent: 'Pi', sessionName: session.name, sessionPath: `/app/session/${props.sessionId}`,
        } : undefined;
      },
      submitDisposition: (eventId, disposition) => sendControl({ type: 'agent-event-disposition', eventId, disposition }),
      confirmDisplay: eventId => sendControl({ type: 'agent-event-displayed', eventId }),
    });
    const receive = (event: MessageEvent) => {
      if (typeof event.data !== 'string' || ws.readyState !== WebSocket.OPEN) return;
      const control = parseControlMessage(event.data);
      if (control.kind === 'agent-event' && control.message) void consumer.onMessage(control.message);
    };
    ws.addEventListener('message', receive);
    return () => { consumer.dispose(); ws.removeEventListener('message', receive); };
  }, [ws, props.sessionId, sendControl]);

  // Let the unchanged upstream action hook write into the SAME accumulator as
  // replay/live events. No second reducer, prompt queue, receipt, or resend path.
  const setSessionStates: SessionActionDeps['setSessionStates'] = useCallback(next => {
    update(current => {
      const previous = new Map([[id, current]]);
      return (typeof next === 'function' ? next(previous) : next).get(id) ?? current;
    });
  }, [id, update]);
  const actions = useSessionActions({
    ...unusedActions, selectedId: id, send: sendAction, sessions, setSessions, setSessionStates, sessionStatesRef: stateRef,
  });

  useEffect(() => onMessage(message => {
    // Target selection is exclusively the attach response. Metadata never
    // selects a target by cwd, name, ordering, or registration recency.
    if (String(message.type).startsWith('agent-event')) return;
    if ('sessionId' in message && message.sessionId !== id) return;
    if (message.type === 'prompt_request') responseProtocols.current.set(message.promptId, 'prompt_response');
    else if (message.type === 'extension_ui_request') responseProtocols.current.set(message.requestId, 'extension_ui_response');
    else if (message.type === 'prompt_dismiss' || message.type === 'prompt_cancel') responseProtocols.current.delete(message.promptId);
    else if (message.type === 'ui_dismiss') responseProtocols.current.delete(message.requestId);
    else if (message.type === 'session_removed') responseProtocols.current.clear();
    if (message.type === 'models_list') setModels(message.models);
    else if (message.type === 'commands_list') setCommands(message.commands);
    else if (message.type === 'flows_list') setFlowCommands(message.flows.map(flow => ({ name: flow.name, description: flow.description ?? '' })));
    else if (message.type === 'files_list') setFileResults({ query: message.query, files: message.files });
    else if (message.type === 'display_prefs_updated') {
      prefsRevision.current++; setGlobalPrefs(message.prefs ?? DISPLAY_PRESETS.simple);
    }
    else if (message.type === 'error') setControlError(message.message);
    apply(message);
    if (message.type === 'sessions_snapshot') {
      const bound = message.sessions.find(session => session.id === id);
      setSessions(new Map(bound ? [[id, bound]] : []));
      if (bound) { setMetadata(bound); setAssets(bound.assets ?? {}); setQueue(bound.pendingQueues ?? { steering: [], followUp: [] }); }
    } else if (message.type === 'session_added' && message.session.id === id) {
      setSessions(new Map([[id, message.session]])); setMetadata(message.session); setAssets(message.session.assets ?? {});
      setQueue(message.session.pendingQueues ?? { steering: [], followUp: [] });
    } else if (message.type === 'session_updated') {
      setMetadata(previous => ({ ...previous, ...message.updates }));
      setSessions(previous => {
        const current = previous.get(id);
        return current ? new Map([[id, { ...current, ...message.updates }]]) : previous;
      });
    } else if (message.type === 'queue_update') {
      setQueue({ steering: message.steering, followUp: message.followUp });
    } else if (message.type === 'asset_register') {
      setAssets(previous => ({ ...previous, [message.hash]: { data: message.data, mimeType: message.mimeType } }));
    } else if (message.type === 'questions_update') {
      questions.set(message.questions.filter(question => question.sessionId === id));
    } else if (message.type === 'event_replay') {
      setLoading(false);
    } else if (message.type === 'session_removed') {
      setMetadata(previous => ({ ...previous, status: 'ended' }));

    }
  }), [onMessage, apply, id, questions]);

  useEffect(() => {
    if (status === 'connected') {
      // Full upstream replay is safe: useSessionState owns its reset/fold logic.
      // Only subscriptions are repeated. Handed prompts are never retransmitted.
      send({ type: 'subscribe', sessionId: id, lastSeq: 0 });
      if (controlsAvailable) {
        send({ type: 'request_models', sessionId: id });
        send({ type: 'request_commands', sessionId: id });
      }
    }
    if (status === 'auth_required') callbacks.current.onAuthError?.('Chat session expired or its binding is no longer available. Re-enter Chat to sign in again.');
  }, [status, send, id, controlsAvailable]);
  useEffect(() => onOutboxExpiry((message, entryId) => {
    if (message.type === 'send_prompt') actions.markPromptUndelivered(id, entryId);
  }), [onOutboxExpiry, actions.markPromptUndelivered, id]);
  usePendingPromptTimeout(state.pendingPrompt?.status === 'sending', useCallback(() => {
    update(current => applyPromptTimeout(current, 'No response from Pi — the prompt may not have been received.'));
  }, [update]));

  useEffect(() => {
    setGlobalApiBase(apiBase);
    setQuestionTransport(async (input, init) => {
      const request = new URL(String(input), window.location.origin);
      request.searchParams.set('generation', String(props.generation));
      // The question dialog's optional summary service is not exposed by this
      // bounded embed. Do not proxy global/management APIs to make it work.
      if (!request.pathname.startsWith(`${apiBase}/api/questions/`) || request.pathname.endsWith('/summarize')) {
        return Response.json({ error: 'This question action is unavailable in Codeflare Chat.' }, { status: 403 });
      }
      const answering = init?.method === 'POST' && request.pathname.endsWith('/answer');
      if (answering) callbacks.current.onManualInput?.();
      const response = await fetch(request, { ...init, credentials: 'same-origin' });
      if (response.status === 401 || response.status === 403) callbacks.current.onAuthError?.('Chat session expired. Sign in again.');
      return response;
    });
    return () => { setQuestionTransport(undefined); setGlobalApiBase(''); };
  }, [apiBase, props.generation]);

  const manual = (action: () => void) => { callbacks.current.onManualInput?.(); action(); };
  const composerStatus = composerLiveness(state.status, metadata.status);
  const toolContext = { sessionId: id, session: state, cwd: metadata.cwd, send: sendAction };
  const sendPrompt: React.ComponentProps<typeof CommandInput>['onSend'] = (text, images, delivery) => {
    if (!available) return;
    const trimmed = text.trimStart();
    if (trimmed.startsWith('!') || (trimmed.startsWith('/') && (/[\r\n]/.test(trimmed) || !supportedCommands.some(command => command.name === trimmed.slice(1).split(/\s/)[0])))) {
      setControlError('This command is unavailable in Chat. Choose a supported command.'); return;
    }
    setControlError('');
    manual(() => actions.handleSend(text, images, delivery));
    callbacks.current.onDraftChange?.('');
  };
  const respond: React.ComponentProps<typeof ChatView>['onRespondToUi'] = (requestId, result, cancelled) => {
    if (!responseProtocols.current.has(requestId)
      || !stateRef.current.get(id)?.interactiveRequests.some(request => request.requestId === requestId && request.status === 'pending')) return;
    manual(() => actions.handleRespondToUi(requestId, result, cancelled));
  };
  const abort = () => { if (available) manual(actions.handleAbort); };
  const terminate = (kind: 'force' | 'after') => {
    if (!advancedAvailable || !window.confirm(kind === 'force'
      ? 'Force stop the shared Pi primary? This terminates Pi for both Chat and Terminal.'
      : 'Stop the shared Pi primary after this turn? This will shut down Pi for both Chat and Terminal.')) return;
    manual(kind === 'force' ? actions.handleForceKill : actions.handleStopAfterTurn);
  };
  const replaceConversation = async (operation: 'new' | 'resume' | 'fork', target?: string) => {
    if (!advancedAvailable || transition.current) return;
    if ((composerStatus === 'streaming' || state.pendingPrompt) && !window.confirm('Replace the current conversation on the shared Pi primary? Active work may be interrupted.')) return;
    transition.current = true; setChangingConversation(true); setControlError('');
    const controller = new AbortController();
    const abort = () => controller.abort();
    lifetime.current.signal.addEventListener('abort', abort, { once: true });
    // A timed-out handoff may already have changed native state: never resend.
    const timeout = setTimeout(() => controller.abort(), 65000);
    try {
      const result = await api.request<unknown>(`/api/conversations/${operation}`, {
        method: 'POST', body: JSON.stringify({ sessionId: id,
          ...(operation === 'resume' ? { conversationId: target } : operation === 'fork' ? { entryId: target } : {}) }),
      }, controller.signal);
      if (lifetime.current.signal.aborted) return;
      if (!result || typeof result !== 'object' || !('sessionId' in result) || typeof result.sessionId !== 'string' || !result.sessionId.trim()
        || !('generation' in result) || result.generation !== props.generation) throw new Error('Invalid conversation binding or stale generation. Re-enter Chat.');
      props.onAdopt(result.sessionId);
    } catch (cause) {
      if (lifetime.current.signal.aborted) return;
      const ambiguous = controller.signal.aborted || cause instanceof TypeError
        || !(cause instanceof ChatAttachError) || (cause.status !== undefined && (cause.status >= 500 || cause.status === 408));
      setUncertain(ambiguous);
      setControlError(ambiguous ? 'Conversation handoff is uncertain. Re-enter Chat to explicitly reattach. Do not resend.' : cause instanceof Error ? cause.message : 'Conversation replacement failed.');
    } finally {
      clearTimeout(timeout); lifetime.current.signal.removeEventListener('abort', abort);
      if (!lifetime.current.signal.aborted) { transition.current = false; setChangingConversation(false); }
    }
  };
  const displayPrefs = { global: globalPrefs, getSessionOverride: (sessionId: string | undefined) => sessionId === id ? metadata.displayPrefsOverride ?? undefined : undefined };


  return <UiPrimitiveProvider value={registry}>
    <EmbedProviders apiBase={apiBase} theme={HOST_THEME}>
      <DisplayPrefsProvider value={displayPrefs}>
        <SessionAssetsProvider assets={assets}>
          <LayerHostProvider host={props.layerHost}>
            <div className="cf-chat-content">
              {controlsAvailable && <div className="cf-chat-controls">
                <ConversationControls api={api} disabled={!available} onNew={() => void replaceConversation('new')} onResume={target => void replaceConversation('resume', target)} />
                <ChatViewMenu sessionId={id} currentOverride={metadata.displayPrefsOverride ?? undefined} send={message => { sendAction(message); }}
                  onSaveGlobal={async prefs => {
                    if (!advancedAvailable) throw new Error('Reconnect before saving display preferences.');
                    const saved = await api.envelope<DisplayPrefs | null>('/api/preferences/display', { method: 'PATCH', body: JSON.stringify(prefs) }, lifetime.current.signal);
                    if (lifetime.current.signal.aborted) throw new Error('Chat closed.');
                    prefsRevision.current++; setGlobalPrefs(saved ?? DISPLAY_PRESETS.simple);
                  }} />
              </div>}
              {!controlsAvailable && <div role="status" className="cf-chat-status">Advanced controls are unavailable on this runtime. Keep using Chat; after an updated runtime is available, re-enter Chat to check again.</div>}
              {controlsAvailable && providersOpen && <ProviderControls api={api} onClose={() => setProvidersOpen(false)} />}
              {controlError && <div role="alert" className="cf-chat-status">{controlError}</div>}
              {changingConversation && <div role="status">Switching conversation…</div>}
              {ended && <div role="status" className="cf-chat-status">The shared Pi primary has ended. Re-enter Chat to restart Pi.</div>}
              {(ended || uncertain || !controlsAvailable) && <button type="button" onClick={props.onReattach}>Re-enter Chat</button>}
              {status !== 'connected' && !ended && <div role={status === 'auth_required' ? 'alert' : 'status'} className="cf-chat-status">
                {status === 'auth_required' ? 'Chat session expired. Sign in again or re-enter Chat.' : status === 'offline' ? 'Chat is offline. Reconnecting…' : 'Reconnecting to Pi…'}
              </div>}
              <SessionBanner state={deriveBannerState(state)} onRetry={advancedAvailable ? () => actions.handleRetrySession(id) : undefined} retryRevision={state.lastError?.timestamp} />
              <QuestionStack sessions={[]} store={questions} onOpenSession={noop} />
              <div className="cf-chat-transcript"><ChatView sessionId={id} state={state} toolContext={toolContext}
                loadingHistory={loading} pendingSteering={queue.steering} onAbort={abort} onRespondToUi={respond}
                onForkFromMessage={advancedAvailable ? entryId => void replaceConversation('fork', entryId) : undefined}
                onRetryPendingPrompt={controlsAvailable ? () => {
                  const pending = stateRef.current.get(id)?.pendingPrompt;
                  if (available && pending?.status === 'failed' && pending.failureCause === 'connection') actions.handleSend(pending.text, pending.images, pending.delivery);
                } : undefined}
                onPromptResync={sessionId => { sendAction({ type: 'prompt_resync_request', sessionId }); }} />
              </div>
              <QueuePanel followUp={queue.followUp}
                onEdit={advancedAvailable ? actions.editFollowUpEntry : undefined} onRemove={advancedAvailable ? actions.removeFollowUpEntry : undefined}
                onPromote={advancedAvailable ? actions.promoteFollowUpEntry : undefined} onClearAll={advancedAvailable ? () => actions.clearFollowUpEntries('all') : undefined} />
              <CommandInput sessionId={id} includeBuiltinCommands={false} commands={supportedCommands} model={metadata.model ?? undefined} models={models} thinkingLevel={metadata.thinkingLevel ?? undefined}
                onRefreshModels={controlsAvailable ? () => { sendAction({ type: 'request_models', sessionId: id }); } : undefined}
                onSelectModel={controlsAvailable ? label => {
                  const separator = label.indexOf('/');
                  if (separator > 0) sendAction({ type: 'set_model', sessionId: id, provider: label.slice(0, separator), modelId: label.slice(separator + 1) });
                } : undefined}
                onSelectThinkingLevel={controlsAvailable ? level => { sendAction({ type: 'set_thinking_level', sessionId: id, level }); } : undefined}
                onListFiles={controlsAvailable ? query => { sendAction({ type: 'list_files', sessionId: id, query }); } : undefined} fileResults={fileResults}
                contextUsage={state.contextUsage} onOpenProviderSettings={controlsAvailable ? () => setProvidersOpen(true) : undefined}
                onCancelPending={() => { if (available) actions.handleCancelPending(); }}
                onForceKill={controlsAvailable ? () => terminate('force') : undefined} onStopAfterTurn={controlsAvailable ? () => terminate('after') : undefined} draft={props.draft} onDraftChange={draft => {
                sendControl({ type: 'chat-input' });
                callbacks.current.onManualInput?.(); callbacks.current.onDraftChange?.(draft);
              }}
                disabled={!available || composerStatus === 'ended'} sessionStatus={composerStatus}
                retrying={!!state.retryState} pendingPrompt={state.pendingPrompt?.status} onSend={sendPrompt} onAbort={abort}
                currentTool={metadata.currentTool ?? undefined} streamingText={state.streamingText} sessionMessages={state.messages} />
            </div>
          </LayerHostProvider>
        </SessionAssetsProvider>
      </DisplayPrefsProvider>
    </EmbedProviders>
  </UiPrimitiveProvider>;
}

/** Keep adopted native identity local; parent presentation updates cannot undo it. */
function ChatBinding(props: ChatMountProps & { layerHost: HTMLElement }) {
  const [bound, setBound] = useState(props.boundSessionId);
  const [controls, setControls] = useState(props.controlsAvailable === true);
  useEffect(() => { setControls(props.controlsAvailable === true); }, [props.controlsAvailable]);
  const [revision, setRevision] = useState(0);
  const [draft, setDraft] = useState(props.draft ?? '');
  const [error, setError] = useState('');
  const [reattaching, setReattaching] = useState(false);
  const reentry = useRef(false);
  const lifetime = useRef(new AbortController());
  useEffect(() => () => lifetime.current.abort(), []);
  useEffect(() => { setDraft(props.draft ?? ''); }, [props.draft]);
  const reattach = async () => {
    if (reentry.current) return;
    reentry.current = true; setReattaching(true); setError('');
    try {
      const result = await attachChatSession(props.sessionId, props.generation, lifetime.current.signal);
      if (lifetime.current.signal.aborted) return;
      const supported = await probeChatControls(props.sessionId, props.generation, lifetime.current.signal);
      if (lifetime.current.signal.aborted) return;
      setControls(supported);
      if (result.sessionId !== bound) { setDraft(''); props.onDraftChange?.(''); }
      setBound(result.sessionId); setRevision(value => value + 1);
    } catch (cause) {
      if (!lifetime.current.signal.aborted) {
        const message = cause instanceof Error ? cause.message : 'Could not re-enter Chat.';
        setError(message);
        if (cause instanceof ChatAttachError && (cause.status === 401 || cause.status === 403 || cause.status === 409)) props.onAuthError?.(message);
      }
    } finally { if (!lifetime.current.signal.aborted) { reentry.current = false; setReattaching(false); } }
  };
  return <>
    {error && <div role="alert">{error}</div>}
    {reattaching && <div role="status">Reattaching to the confirmed primary…</div>}
    <BoundChat key={`${bound}:${revision}`} {...props} controlsAvailable={controls} boundSessionId={bound} draft={draft}
      onDraftChange={value => { setDraft(value); props.onDraftChange?.(value); }} onReattach={() => void reattach()}
      onAdopt={id => { setDraft(''); props.onDraftChange?.(''); setBound(id); setRevision(value => value + 1); }} />
  </>;
}

/** One React root, owned/disposed by the visible Solid surface. */
export function mountChat(container: HTMLElement, props: ChatMountProps) {
  const root = createRoot(container);
  const layerHost = document.createElement('div');
  layerHost.className = 'codeflare-chat cf-chat-overlays';
  document.body.append(layerHost);
  const render = (next: ChatMountProps) => root.render(<ChatBinding key={`${next.sessionId}:${next.generation}:${next.boundSessionId}`} {...next} layerHost={layerHost} />);
  render(props);
  return { update: render, dispose() { root.unmount(); layerHost.remove(); } };
}
