import { createEffect, createSignal, on, onCleanup, Show } from 'solid-js';
import type { ChatMountProps, mountChat } from '../chat/ChatMount';
import { attachChatSession, ChatAttachError, probeChatControls } from '../chat/api';

/** Root owns session-local draft lifetime; unmounting only disposes browser UI/WS. */
export interface ChatAreaProps {
  /** Codeflare session id, NOT an upstream Dashboard id. */
  sessionId: string;
  generation: number;
  /** Reuse the shell's confirmed explicit-entry binding without attaching twice. */
  boundSessionId?: string;
  draft?: string;
  onDraftChange?: (draft: string) => void;
  onManualInput?: () => void;
  onAuthError?: (message: string) => void;
}

// @impl REQ-AGENT-224 — explicit, generation-bound entry to the existing primary.
export default function ChatArea(props: ChatAreaProps) {
  let container!: HTMLDivElement;
  let mounted: ReturnType<typeof mountChat> | undefined;
  let binding: { sessionId: string; generation: number; boundSessionId: string; controlsAvailable: boolean } | undefined;
  const [error, setError] = createSignal<string>();
  const [loading, setLoading] = createSignal(true);
  const mountProps = (): ChatMountProps => ({
    ...binding!, draft: props.draft,
    onDraftChange: draft => props.onDraftChange?.(draft),
    onManualInput: () => props.onManualInput?.(),
    onAuthError: message => props.onAuthError?.(message),
  });

  createEffect(on([() => props.sessionId, () => props.generation, () => props.boundSessionId], ([sessionId, generation, boundSessionId]) => {
    const controller = new AbortController();
    let disposed = false;
    mounted?.dispose(); mounted = undefined; binding = undefined;
    setError(undefined); setLoading(true);
    onCleanup(() => {
      disposed = true; controller.abort(); mounted?.dispose(); mounted = undefined; binding = undefined;
    });
    void (async () => {
      try {
        const attached = boundSessionId === undefined
          ? await attachChatSession(sessionId, generation, controller.signal)
          : { sessionId: boundSessionId, generation };
        if (disposed) return;
        const controlsAvailable = await probeChatControls(sessionId, generation, controller.signal);
        if (disposed) return;
        binding = { sessionId, generation, boundSessionId: attached.sessionId, controlsAvailable };
        // The normal Vite chunk is fetched only after explicit authorized entry.
        const { mountChat } = await import('../chat/ChatMount');
        if (disposed) return;
        mounted = mountChat(container, mountProps());
        setLoading(false);
      } catch (cause) {
        if (!disposed) {
          if (cause instanceof ChatAttachError && (cause.status === 401 || cause.status === 403 || cause.status === 409)) props.onAuthError?.(cause.message);
          setError(cause instanceof Error ? cause.message : 'Unable to open Chat.'); setLoading(false);
        }
      }
    })();
  }));

  createEffect(() => {
    // Only presentation props update here; draft edits never reattach or change
    // the bound process. No persistent state or hidden terminal connection.
    const draft = props.draft;
    if (mounted && binding) mounted.update({ ...mountProps(), draft });
  });

  return <section aria-label="Pi Chat" class="codeflare-chat" style={{ height: '100%', width: '100%', 'min-height': '0', display: 'flex', 'flex-direction': 'column' }}>
    <Show when={loading()}><div role="status">Connecting to Pi…</div></Show>
    <Show when={error()}><div role="alert">{error()}</div></Show>
    <div ref={container} style={{ flex: '1', 'min-height': '0', display: 'flex', 'flex-direction': 'column' }} />
  </section>;
}
