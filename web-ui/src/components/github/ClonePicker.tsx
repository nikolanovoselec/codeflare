import { Component, For, Show, createSignal, createEffect, createMemo, onMount, onCleanup } from 'solid-js';
import { mdiSourceBranch, mdiAlertCircleOutline, mdiClose } from '@mdi/js';
import Icon from '../Icon';
import type { AgentType } from '../../types';
import type { GithubRepo } from '../../api/github';
import { sessionStore } from '../../stores/session';
import { cloneAttempt, setCloneAttempt } from '../../stores/clone-attempts';
import ClonePickerSessionRow from './ClonePickerSessionRow';
import ClonePickerNewSession from './ClonePickerNewSession';

interface ClonePickerProps {
  repo: GithubRepo;
  onClose: () => void;
  anchorRef?: HTMLElement;
}

const DIALOG_ESTIMATED_HEIGHT = 380;
const GAP = 8;

// Anchored popover (mobile: full-width bottom sheet) that picks a clone target
// for one repo: a running session (clone into the live container) or a new
// session (created with the repo, opened via the dashboard new-session path).
const ClonePicker: Component<ClonePickerProps> = (props) => {
  let dialogRef: HTMLDivElement | undefined;
  let closeButton: HTMLButtonElement | undefined;
  let disposed = false;
  const [position, setPosition] = createSignal<{ top: number; left: number; width: number }>({ top: 0, left: 0, width: 320 });
  const [createFailed, setCreateFailed] = createSignal(false);
  const attempt = () => cloneAttempt(props.repo.full_name);
  const retrySessionId = () => {
    const current = attempt();
    return current?.phase === 'creating' ? undefined : current?.sessionId;
  };

  const runningSessions = createMemo(() =>
    sessionStore.sessions.filter((s) => s.status === 'running'),
  );

  const busy = () => attempt()?.phase === 'creating' || attempt()?.phase === 'retrying';

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
      const last = options[options.length - 1];
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
    (choices().find(button => button !== closeButton) ?? closeButton)?.focus();
  });

  onCleanup(() => {
    disposed = true;
    document.removeEventListener('mousedown', handleClickOutside);
    document.removeEventListener('keydown', handleKeyDown, true);
    if (props.anchorRef?.isConnected) props.anchorRef.focus();
  });

  // Clone into an existing running session. ref is omitted (backend defaults to
  // the repo's default branch).
  const handleCloneIntoSession = (sessionId: string) => {
    if (busy()) return;
    void sessionStore.cloneRepositoryIntoSession({ repo: props.repo.full_name, sessionId });
    props.onClose();
  };

  // Create a new session that clones the repo at start. Workspace routing stays
  // server-owned: Terminal follows its existing activation path, while VS Code
  // starts on the dashboard. On success the picker closes.
  const handleCloneIntoNewSession = async (agentType: AgentType) => {
    if (busy()) return;
    const repo = props.repo.full_name;
    closeButton?.focus();
    setCreateFailed(false);
    const ticket = Symbol();
    setCloneAttempt(repo, { phase: 'creating', ticket });
    const result = await sessionStore.createSessionWithClone(repo, agentType);
    const current = cloneAttempt(repo);
    if (current?.phase !== 'creating' || current.ticket !== ticket) return;
    if (result && !result.started) setCloneAttempt(repo, { phase: 'failed', sessionId: result.sessionId });
    else setCloneAttempt(repo);
    if (disposed) return;
    if (result?.started) props.onClose();
    else if (!result) setCreateFailed(true);
  };

  const retryStart = async (id: string) => {
    if (busy() || !sessionStore.canRetryCloneStart(id)) return;
    const repo = props.repo.full_name;
    closeButton?.focus();
    const retry = { phase: 'retrying', sessionId: id } as const;
    setCloneAttempt(repo, retry);
    const started = await sessionStore.retryCloneStart(id);
    if (cloneAttempt(repo) !== retry) return;
    setCloneAttempt(repo, started ? undefined : { phase: 'failed', sessionId: id });
    if (started && !disposed) props.onClose();
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
          <button ref={closeButton} type="button" class="header-icon-button clone-picker-close"
            aria-label="Close clone picker" onClick={props.onClose}>
            <Icon path={mdiClose} size={16} />
          </button>
        </div>

        <Show when={busy()}>
          <p class="clone-picker-group-header" role="status">Starting session…</p>
        </Show>
        <Show when={createFailed() || attempt()?.phase === 'failed'}>
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

        <Show when={retrySessionId()} fallback={
          <ClonePickerNewSession
            disabled={busy()}
            onSelect={(agentType) => void handleCloneIntoNewSession(agentType)}
          />
        }>{id => (
          <button type="button" class="clone-picker-option-btn" disabled={busy() || !sessionStore.canRetryCloneStart(id())}
            onClick={() => void retryStart(id())}>Retry Start</button>
        )}</Show>
      </div>
    </>
  );
};

export default ClonePicker;
