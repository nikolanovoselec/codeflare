import { Component, For, Show, createSignal, createEffect, createMemo, onMount, onCleanup } from 'solid-js';
import { mdiSourceBranch, mdiCheckCircleOutline, mdiAlertCircleOutline } from '@mdi/js';
import Icon from '../Icon';
import type { AgentType } from '../../types';
import type { GithubRepo } from '../../api/github';
import { cloneIntoSession } from '../../api/github';
import { sessionStore } from '../../stores/session';
import ClonePickerSessionRow from './ClonePickerSessionRow';
import ClonePickerNewSession from './ClonePickerNewSession';

interface ClonePickerProps {
  repo: GithubRepo;
  onClose: () => void;
  anchorRef?: HTMLElement;
}

// idle  → no request yet
// busy  → a clone/create request is in flight (confirm controls disabled)
// cloned → 200 success (cloned into a running session)
// exists → 409 CLONE_TARGET_EXISTS (distinct collision affordance)
// failed → any other non-2xx (generic failure)
type CloneState =
  | { phase: 'idle' }
  | { phase: 'busy' }
  | { phase: 'cloned'; path?: string }
  | { phase: 'exists' }
  | { phase: 'failed' };

const DIALOG_ESTIMATED_HEIGHT = 380;
const GAP = 8;

// Anchored popover (mobile: full-width bottom sheet) that picks a clone target
// for one repo: a running session (clone into the live container) or a new
// session (created with the repo, opened via the dashboard new-session path).
const ClonePicker: Component<ClonePickerProps> = (props) => {
  let dialogRef: HTMLDivElement | undefined;
  const [position, setPosition] = createSignal<{ top: number; left: number; width: number }>({ top: 0, left: 0, width: 320 });
  const [state, setState] = createSignal<CloneState>({ phase: 'idle' });

  const runningSessions = createMemo(() =>
    sessionStore.sessions.filter((s) => s.status === 'running'),
  );

  const busy = () => state().phase === 'busy';

  const updatePosition = () => {
    if (!props.anchorRef) return;
    const rect = props.anchorRef.getBoundingClientRect();
    const viewportHeight = window.innerHeight;
    const spaceBelow = viewportHeight - rect.bottom - GAP;
    const spaceAbove = rect.top - GAP;

    let top: number;
    if (spaceBelow >= DIALOG_ESTIMATED_HEIGHT) {
      top = rect.bottom + GAP;
    } else if (spaceAbove >= DIALOG_ESTIMATED_HEIGHT) {
      top = rect.top - GAP - DIALOG_ESTIMATED_HEIGHT;
    } else if (spaceBelow >= spaceAbove) {
      top = rect.bottom + GAP;
    } else {
      top = Math.max(GAP, rect.top - GAP - DIALOG_ESTIMATED_HEIGHT);
    }

    // Right-align the popover to the anchor; clamp to the viewport's left edge.
    const width = 320;
    const left = Math.max(GAP, rect.right - width);
    setPosition({ top, left, width });
  };

  createEffect(() => {
    updatePosition();
  });

  const handleClickOutside = (e: MouseEvent) => {
    if (dialogRef && !dialogRef.contains(e.target as Node)) {
      if (props.anchorRef && props.anchorRef.contains(e.target as Node)) return;
      props.onClose();
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') props.onClose();
  };

  onMount(() => {
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
  });

  onCleanup(() => {
    document.removeEventListener('mousedown', handleClickOutside);
    document.removeEventListener('keydown', handleKeyDown);
  });

  // Clone into an existing running session. ref is omitted (backend defaults to
  // the repo's default branch).
  const handleCloneIntoSession = async (sessionId: string) => {
    if (busy()) return;
    setState({ phase: 'busy' });
    const result = await cloneIntoSession({ repo: props.repo.full_name, sessionId });
    if (result.outcome === 'cloned') {
      setState({ phase: 'cloned', path: result.path });
    } else if (result.outcome === 'exists') {
      setState({ phase: 'exists' });
    } else {
      setState({ phase: 'failed' });
    }
  };

  // Create a new session that clones the repo at start, then open it via the
  // existing dashboard new-session path (store.createSessionWithClone mirrors
  // Layout.handleCreateSession). On success the picker closes — navigation has
  // already switched to the new session.
  const handleCloneIntoNewSession = async (agentType: AgentType) => {
    if (busy()) return;
    setState({ phase: 'busy' });
    const session = await sessionStore.createSessionWithClone(props.repo.full_name, agentType);
    if (session) {
      props.onClose();
    } else {
      setState({ phase: 'failed' });
    }
  };

  return (
    <>
      <div class="clone-picker-backdrop" data-testid="clone-picker-backdrop" onClick={() => props.onClose()} />
      <div
        ref={dialogRef}
        class="clone-picker"
        data-testid="clone-picker"
        data-repo={props.repo.full_name}
        role="dialog"
        aria-label="Clone repository"
        style={{
          top: `${position().top}px`,
          left: `${position().left}px`,
          width: `${position().width}px`,
        }}
      >
        <div class="clone-picker-branch" data-testid="clone-picker-branch">
          <Icon path={mdiSourceBranch} size={14} class="clone-picker-branch-icon" />
          <span class="clone-picker-branch-name">{props.repo.default_branch}</span>
        </div>

        <Show when={state().phase === 'cloned'}>
          <div class="clone-picker-result clone-picker-result--cloned" data-testid="clone-picker-result-cloned" role="status">
            <Icon path={mdiCheckCircleOutline} size={16} />
            <button type="button" class="clone-picker-done-btn" data-testid="clone-picker-done-btn" onClick={() => props.onClose()}>
              Done
            </button>
          </div>
        </Show>

        <Show when={state().phase === 'exists'}>
          <div class="clone-picker-result clone-picker-result--exists" data-testid="clone-picker-result-exists" role="alert">
            <Icon path={mdiAlertCircleOutline} size={16} />
            <span class="clone-picker-result-text">This folder already exists in that session.</span>
          </div>
        </Show>

        <Show when={state().phase === 'failed'}>
          <div class="clone-picker-result clone-picker-result--failed" data-testid="clone-picker-result-failed" role="alert">
            <Icon path={mdiAlertCircleOutline} size={16} />
            <span class="clone-picker-result-text">Clone failed. Please try again.</span>
          </div>
        </Show>

        <Show when={state().phase !== 'cloned'}>
          <Show when={runningSessions().length > 0}>
            <div class="clone-picker-running-group" data-testid="clone-picker-running-group">
              <div class="clone-picker-group-header">
                <span>Clone into a running session</span>
              </div>
              <div class="clone-picker-sessions">
                <For each={runningSessions()}>
                  {(session) => (
                    <ClonePickerSessionRow
                      session={session}
                      disabled={busy()}
                      onSelect={(id) => void handleCloneIntoSession(id)}
                    />
                  )}
                </For>
              </div>
            </div>

            <div class="clone-picker-separator" data-testid="clone-picker-separator" role="separator" />
          </Show>

          <ClonePickerNewSession
            disabled={busy()}
            onSelect={(agentType) => void handleCloneIntoNewSession(agentType)}
          />
        </Show>
      </div>
    </>
  );
};

export default ClonePicker;
