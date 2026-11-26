import { Component, For, Show, createSignal, createEffect, createMemo, onMount, onCleanup } from 'solid-js';
import { mdiSourceBranch, mdiAlertCircleOutline } from '@mdi/js';
import Icon from '../Icon';
import type { AgentType } from '../../types';
import type { GithubRepo } from '../../api/github';
import { sessionStore } from '../../stores/session';
import ClonePickerSessionRow from './ClonePickerSessionRow';
import ClonePickerNewSession from './ClonePickerNewSession';

interface ClonePickerProps {
  repo: GithubRepo;
  onClose: () => void;
  anchorRef?: HTMLElement;
}

// New-session creation keeps local progress/errors; live clone outcomes use
// the shared notification after the picker closes.
type CloneState = { phase: 'idle' | 'busy' | 'failed' };

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

  const choices = () => Array.from(dialogRef?.querySelectorAll<HTMLButtonElement>('button:enabled') ?? []);
  const handleKeyDown = (e: KeyboardEvent) => {
    if (!dialogRef || e.defaultPrevented) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      props.onClose();
    } else if (e.key === 'Tab') {
      const options = choices();
      const first = options[0];
      const last = options.at(-1);
      const active = document.activeElement;
      if (!active || !options.includes(active as HTMLButtonElement) || active === (e.shiftKey ? first : last)) {
        e.preventDefault();
        (e.shiftKey ? last ?? dialogRef : first ?? dialogRef).focus();
      }
    }
  };

  onMount(() => {
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown, true);
    (choices()[0] ?? dialogRef)?.focus();
  });

  onCleanup(() => {
    document.removeEventListener('mousedown', handleClickOutside);
    document.removeEventListener('keydown', handleKeyDown, true);
    if (props.anchorRef?.isConnected) props.anchorRef.focus();
  });

  // Clone into an existing running session. ref is omitted (backend defaults to
  // the repo's default branch).
  const handleCloneIntoSession = (sessionId: string) => {
    if (busy()) return;
    setState({ phase: 'busy' });
    void sessionStore.cloneRepositoryIntoSession({ repo: props.repo.full_name, sessionId });
    props.onClose();
  };

  // Create a new session that clones the repo at start. Workspace routing stays
  // server-owned: Terminal follows its existing activation path, while VS Code
  // starts on the dashboard. On success the picker closes.
  const handleCloneIntoNewSession = async (agentType: AgentType) => {
    if (busy()) return;
    setState({ phase: 'busy' });
    // The store owns startup error reporting; also release the picker on rejection.
    const session = await sessionStore.createSessionWithClone(props.repo.full_name, agentType).catch(() => undefined);
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
        aria-modal="true"
        aria-label="Clone repository"
        tabIndex={-1}
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

        <Show when={state().phase === 'failed'}>
          <div class="clone-picker-result clone-picker-result--failed" data-testid="clone-picker-result-failed" role="alert">
            <Icon path={mdiAlertCircleOutline} size={16} />
            <span class="clone-picker-result-text">Clone failed. Please try again.</span>
          </div>
        </Show>

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
                    onSelect={handleCloneIntoSession}
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
      </div>
    </>
  );
};

export default ClonePicker;
