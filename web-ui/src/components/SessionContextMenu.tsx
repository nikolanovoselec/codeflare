import { Component, Show, createSignal } from 'solid-js';
import { mdiPencilOutline, mdiStop, mdiTrashCanOutline } from '@mdi/js';
import Icon from './Icon';
import '../styles/session-context-menu.css';

interface SessionContextMenuProps {
  isOpen: boolean;
  position: { x: number; y: number };
  canStop: boolean;
  sessionName: string;
  onStop: () => void;
  onDelete: () => void;
  /** REQ-SESSION-006 AC7: rename the session this menu was opened for. */
  onRename: (name: string) => void;
  onClose: () => void;
}

const SessionContextMenu: Component<SessionContextMenuProps> = (props) => {
  const [confirmingDelete, setConfirmingDelete] = createSignal(false);
  const [renaming, setRenaming] = createSignal(false);
  const [draftName, setDraftName] = createSignal('');

  const clampedPosition = () => {
    const menuWidth = 160;
    const menuHeight = 120;
    const pad = 8;
    return {
      x: Math.max(pad, Math.min(props.position.x, window.innerWidth - menuWidth - pad)),
      y: Math.max(pad, Math.min(props.position.y, window.innerHeight - menuHeight - pad)),
    };
  };

  const handleStop = () => {
    props.onStop();
    props.onClose();
  };

  const handleDeleteClick = () => {
    if (confirmingDelete()) {
      return;
    }
    setConfirmingDelete(true);
  };

  // REQ-SESSION-006 AC7: renaming is display-only - it never stops, starts or
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
    setRenaming(false);
    props.onClose();
  };

  const handleDeleteConfirm = () => {
    props.onDelete();
    props.onClose();
  };

  return (
    <Show when={props.isOpen}>
      <div class="session-context-menu__backdrop" onClick={() => { setConfirmingDelete(false); setRenaming(false); props.onClose(); }} />
      <div
        class="session-context-menu"
        data-testid="session-context-menu"
        style={{ top: `${clampedPosition().y}px`, left: `${clampedPosition().x}px` }}
      >
        <Show when={props.canStop}>
          <button
            type="button"
            class="session-context-menu__item"
            data-testid="context-menu-stop"
            onClick={handleStop}
          >
            <Icon path={mdiStop} size={16} />
            Stop
          </button>
        </Show>
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
              type="text"
              class="session-context-menu__rename-input"
              data-testid="context-menu-rename-input"
              aria-label="Session name"
              value={draftName()}
              maxLength={100}
              onInput={(e) => setDraftName(e.currentTarget.value)}
            />
          </form>
        </Show>
        <Show when={!confirmingDelete()}>
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
        <Show when={confirmingDelete()}>
          <button
            type="button"
            class="session-context-menu__item session-context-menu__item--danger"
            data-testid="context-menu-delete-confirm"
            onClick={handleDeleteConfirm}
          >
            <Icon path={mdiTrashCanOutline} size={16} />
            Are you sure?
          </button>
        </Show>
      </div>
    </Show>
  );
};

export default SessionContextMenu;
