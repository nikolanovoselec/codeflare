import { Component, Show, createSignal, createEffect } from 'solid-js';
import { mdiPencilOutline, mdiStop, mdiTrashCanOutline, mdiFileExcelBox } from '@mdi/js';
import Icon from './Icon';
import type { SessionWithStatus } from '../types';
import '../styles/session-context-menu.css';

interface SessionContextMenuProps {
  isOpen: boolean;
  position: { x: number; y: number };
  canStop: boolean;
  canKill?: boolean;
  onKill?: () => void;
  stopLabel?: string;
  sessionName: string;
  onStop: () => void;
  session?: SessionWithStatus;
  onDelete: (discardMemory?: string) => void;
  /** REQ-SESSION-027 AC1: rename the session this menu was opened for. */
  onRename: (name: string) => void;
  onClose: () => void;
}

const SessionContextMenu: Component<SessionContextMenuProps> = (props) => {
  const [confirmingDelete, setConfirmingDelete] = createSignal(false);
  const [discardMemory, setDiscardMemory] = createSignal<string>();
  const recoveryTarget = () => {
    const session = props.session;
    if (session?.canDiscardMemory && session.shutdownPhase === 'memory-not-merged' && session.status === 'stopped'
      && session.generation !== undefined && session.revision !== undefined) {
      return `${session.generation}:${session.revision}`;
    }
  };
  const canDelete = () => props.session?.shutdownPhase !== 'memory-not-merged' || !!recoveryTarget();
  const confirmingDiscard = () => confirmingDelete() && !!discardMemory();
  const [renaming, setRenaming] = createSignal(false);
  const [draftName, setDraftName] = createSignal('');

  // Discard the draft and confirmation when the user closes or completes a menu action.
  const resetTransient = () => {
    setConfirmingDelete(false);
    setRenaming(false);
    setDraftName('');
  };

  let renameInput: HTMLInputElement | undefined;
  createEffect(() => {
    if (renaming()) {
      renameInput?.focus();
      renameInput?.select();
    }
  });

  const clampedPosition = () => {
    const menuWidth = confirmingDiscard() ? 280 : 160;
    const menuHeight = props.canKill && props.onKill ? 160 : 120;
    const pad = 8;
    return {
      x: Math.max(pad, Math.min(props.position.x, window.innerWidth - menuWidth - pad)),
      y: Math.max(pad, Math.min(props.position.y, window.innerHeight - menuHeight - pad)),
    };
  };

  const handleStop = () => {
    props.onStop();
    resetTransient();
    props.onClose();
  };

  const handleKill = () => {
    props.onKill?.();
    resetTransient();
    props.onClose();
  };

  const handleDeleteClick = () => {
    if (confirmingDelete()) {
      return;
    }
    setDiscardMemory(recoveryTarget());
    setConfirmingDelete(true);
  };

  // REQ-SESSION-027 AC1: renaming is display-only - it never stops, starts or
  // otherwise touches the session, so it is offered whatever the session state.
  const handleRenameClick = () => {
    setDraftName(props.sessionName);
    setRenaming(true);
  };

  const handleRenameSubmit = (e: Event) => {
    e.preventDefault();
    const next = draftName().trim();
    if (!next) return;
    props.onRename(next);
    resetTransient();
    props.onClose();
  };

  const handleRenameKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      setRenaming(false);
      setDraftName('');
    }
  };

  const handleDeleteConfirm = () => {
    const discard = discardMemory();
    if (canDelete() && discard === recoveryTarget()) {
      if (discard) props.onDelete(discard);
      else props.onDelete();
    }
    resetTransient();
    props.onClose();
  };

  return (
    <Show when={props.isOpen}>
      <div class="session-context-menu__backdrop" onClick={() => { resetTransient(); props.onClose(); }} />
      <div
        class="session-context-menu"
        classList={{ 'session-context-menu--discard-confirmation': confirmingDiscard() }}
        data-testid="session-context-menu"
        style={{ top: `${clampedPosition().y}px`, left: `${clampedPosition().x}px` }}
      >
        <Show when={!renaming()}>
          <button
            type="button"
            class="session-context-menu__item"
            data-testid="context-menu-rename"
            onClick={handleRenameClick}
          >
            <Icon path={mdiPencilOutline} size={16} />
            Rename
          </button>
        </Show>
        <Show when={renaming()}>
          <form
            class="session-context-menu__rename"
            data-testid="context-menu-rename-form"
            onSubmit={handleRenameSubmit}
          >
            <input
              ref={renameInput}
              type="text"
              class="session-context-menu__rename-input"
              data-testid="context-menu-rename-input"
              aria-label="Session name"
              value={draftName()}
              maxLength={100}
              onInput={(e) => setDraftName(e.currentTarget.value)}
              onKeyDown={handleRenameKeyDown}
            />
          </form>
        </Show>
        <Show when={props.canStop}>
          <button
            type="button"
            class="session-context-menu__item"
            data-testid="context-menu-stop"
            onClick={handleStop}
          >
            <Icon path={mdiStop} size={16} />
            {props.stopLabel ?? 'Stop'}
          </button>
        </Show>
        <Show when={props.canKill && props.onKill}>
          <button
            type="button"
            class="session-context-menu__item session-context-menu__item--danger"
            onClick={handleKill}
          >
            <Icon path={mdiFileExcelBox} size={16} />
            Kill
          </button>
        </Show>
        <Show when={canDelete() && !confirmingDelete()}>
          <button
            type="button"
            class="session-context-menu__item session-context-menu__item--danger"
            data-testid="context-menu-delete"
            onClick={handleDeleteClick}
          >
            <Icon path={mdiTrashCanOutline} size={16} />
            Delete
          </button>
        </Show>
        <Show when={canDelete() && confirmingDelete()}>
          <button
            type="button"
            class="session-context-menu__item session-context-menu__item--danger"
            data-testid="context-menu-delete-confirm"
            onClick={handleDeleteConfirm}
          >
            <Icon path={mdiTrashCanOutline} size={16} />
            {discardMemory() ? 'Delete and discard unconsolidated memory?' : 'Are you sure?'}
          </button>
        </Show>
      </div>
    </Show>
  );
};

export default SessionContextMenu;
