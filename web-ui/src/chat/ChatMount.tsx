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
import { sessionStore } from '../stores/session';
import { parseControlMessage } from '../stores/terminal-protocol';
import { agentEventDisposition, createAgentEventConsumer } from '../lib/agent-notifications';
import './presentation.css';

export interface ChatMountProps {
  /** Codeflare identity; never used as the upstream protocol target. */
  sessionId: string;
  generation: number;
  boundSessionId: string;
  draft?: string;
  onDraftChange?: (draft: string) => void;
  onManualInput?: () => void;
  onAuthError?: (message: string) => void;
}

const SIMPLE = { global: DISPLAY_PRESETS.simple, getSessionOverride: () => undefined };
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

function BoundChat(props: ChatMountProps & { layerHost: HTMLElement }) {
  const id = props.boundSessionId;
  const apiBase = `/api/chat/${encodeURIComponent(props.sessionId)}`;
  const url = new URL(`${apiBase}/ws`, window.location.origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('generation', String(props.generation));
  const { state, apply, update } = useSessionState(id);
  const { send, onMessage, status, ws, onOutboxExpiry } = useWebSocket(url.href, undefined, { hostAuthenticated: true });
  const [sessions, setSessions] = useState<Map<string, DashboardSession>>(() => new Map());
  const [metadata, setMetadata] = useState<Partial<DashboardSession>>({});
  const [assets, setAssets] = useState<SessionAssets>({});
  const [queue, setQueue] = useState<{ steering: string[]; followUp: FollowUpEntryView[] }>({ steering: [], followUp: [] });
  const [loading, setLoading] = useState(true);
  const questions = useMemo(() => new QuestionStackStore(), []);
  const registry = useMemo(() => createHostPrimitiveRegistry(), []);
  const stateRef = useRef(new Map<string, SessionState>());
  stateRef.current = new Map([[id, state]]);
  const callbacks = useRef(props);
  callbacks.current = props;

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
    ...unusedActions, selectedId: id, send, sessions, setSessions, setSessionStates, sessionStatesRef: stateRef,
  });

  useEffect(() => onMessage(message => {
    // Target selection is exclusively the attach response. Metadata never
    // selects a target by cwd, name, ordering, or registration recency.
    if (String(message.type).startsWith('agent-event')) return;
    if ('sessionId' in message && message.sessionId !== id) return;
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
    }
    if (status === 'auth_required') callbacks.current.onAuthError?.('Chat session expired or its binding is no longer available. Re-enter Chat to sign in again.');
  }, [status, send, id]);
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
  const toolContext = { sessionId: id, session: state, cwd: metadata.cwd, send };
  const sendPrompt: React.ComponentProps<typeof CommandInput>['onSend'] = (text, images, delivery) => {
    manual(() => actions.handleSend(text, images, delivery));
    callbacks.current.onDraftChange?.('');
  };
  const respond: React.ComponentProps<typeof ChatView>['onRespondToUi'] = (requestId, result, cancelled) => {
    manual(() => actions.handleRespondToUi(requestId, result, cancelled));
  };
  const abort = () => manual(actions.handleAbort);

  return <UiPrimitiveProvider value={registry}>
    <EmbedProviders apiBase={apiBase} theme={HOST_THEME}>
      <DisplayPrefsProvider value={SIMPLE}>
        <SessionAssetsProvider assets={assets}>
          <LayerHostProvider host={props.layerHost}>
            <div className="cf-chat-content">
              {status !== 'connected' && <div role={status === 'auth_required' ? 'alert' : 'status'} className="cf-chat-status">
                {status === 'auth_required' ? 'Chat session expired. Sign in again or re-enter Chat.' : status === 'offline' ? 'Chat is offline. Reconnecting…' : 'Connecting to Pi…'}
              </div>}
              <SessionBanner state={deriveBannerState(state)} />
              <QuestionStack sessions={[]} store={questions} onOpenSession={noop} />
              <div className="cf-chat-transcript"><ChatView sessionId={id} state={state} toolContext={toolContext}
                loadingHistory={loading} pendingSteering={queue.steering} onAbort={abort} onRespondToUi={respond}
                onPromptResync={sessionId => send({ type: 'prompt_resync_request', sessionId })} />
              </div>
              <QueuePanel followUp={queue.followUp} />
              <CommandInput sessionId={id} commands={[]} draft={props.draft} onDraftChange={draft => {
                sendControl({ type: 'chat-input' });
                callbacks.current.onManualInput?.(); callbacks.current.onDraftChange?.(draft);
              }}
                disabled={status !== 'connected' || composerStatus === 'ended'} sessionStatus={composerStatus}
                retrying={!!state.retryState} pendingPrompt={state.pendingPrompt?.status} onSend={sendPrompt} onAbort={abort}
                currentTool={metadata.currentTool} streamingText={state.streamingText} sessionMessages={state.messages} />
            </div>
          </LayerHostProvider>
        </SessionAssetsProvider>
      </DisplayPrefsProvider>
    </EmbedProviders>
  </UiPrimitiveProvider>;
}

/** One React root, owned/disposed by the visible Solid surface. */
export function mountChat(container: HTMLElement, props: ChatMountProps) {
  const root = createRoot(container);
  const layerHost = document.createElement('div');
  layerHost.className = 'codeflare-chat cf-chat-overlays';
  document.body.append(layerHost);
  const render = (next: ChatMountProps) => root.render(<BoundChat key={`${next.sessionId}:${next.generation}:${next.boundSessionId}`} {...next} layerHost={layerHost} />);
  render(props);
  return { update: render, dispose() { root.unmount(); layerHost.remove(); } };
}
