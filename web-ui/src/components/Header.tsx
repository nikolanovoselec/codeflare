import { Component, Show, For, createMemo, createSignal, createEffect, onMount, onCleanup } from 'solid-js';
import {
  mdiXml,
  mdiCogOutline,
  mdiAccountCircle,
  mdiViewDashboardOutline,
  mdiBookOutline,
  mdiDelete,
  mdiPlus,
  mdiPencilOutline,
  mdiCheck,
  mdiClose,
  mdiFileCabinet,
  mdiOpenInNew,
} from '@mdi/js';
import Icon from './Icon';
import SessionSwitcher from './SessionSwitcher';
import { sessionStore } from '../stores/session';
import { terminalStore } from '../stores/terminal';
import { md5 } from '../lib/md5';
import type { SessionWithStatus, AgentType, TabConfig } from '../types';
import '../styles/header.css';

function getGravatarUrl(email: string, size = 32): string {
  const hash = md5(email.trim().toLowerCase());
  return `https://www.gravatar.com/avatar/${hash}?s=${size}&d=mp`;
}

interface HeaderProps {
  userName?: string;
  onSettingsClick?: () => void;
  onStoragePanelToggle?: () => void;
  onLogoClick?: () => void;
  sessions: SessionWithStatus[];
  activeSessionId: string | null;
  onSelectSession: (id: string) => void;
  onStopSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
  onCreateSession: (name: string, agentType?: AgentType, tabConfig?: TabConfig[]) => void;
}

/**
 * Header component - top bar with logo, session switcher and user menu
 *
 * Layout:
 * +-----------------------------------------------------------------------------------+
 * | [</>] [Session Switcher]          [Avatar] [Bookmarks] [Storage] [Settings] [Dashboard] |
 * +-----------------------------------------------------------------------------------+
 */
const Header: Component<HeaderProps> = (props) => {
  const [showBookmarksMenu, setShowBookmarksMenu] = createSignal(false);
  const [showCreateBookmark, setShowCreateBookmark] = createSignal(false);
  const [bookmarkName, setBookmarkName] = createSignal('');
  const [bookmarkError, setBookmarkError] = createSignal<string | null>(null);
  const [editingPresetId, setEditingPresetId] = createSignal<string | null>(null);
  const [editingPresetName, setEditingPresetName] = createSignal('');
  let bookmarksMenuRef: HTMLDivElement | undefined;
  let bookmarkInputRef: HTMLInputElement | undefined;
  let renameInputRef: HTMLInputElement | undefined;

  const hasBookmarks = createMemo(() => sessionStore.presets.length > 0);
  const canAddBookmark = createMemo(() => sessionStore.presets.length < 3);
  const canSaveBookmark = createMemo(() =>
    canAddBookmark()
    && Boolean(sessionStore.activeSessionId)
    && bookmarkName().trim().length > 0
  );

  const closeBookmarksMenu = () => {
    setShowBookmarksMenu(false);
    setShowCreateBookmark(false);
    setBookmarkName('');
    setBookmarkError(null);
    setEditingPresetId(null);
    setEditingPresetName('');
  };

  const handleClickOutside = (e: MouseEvent) => {
    if (!showBookmarksMenu()) return;
    if (bookmarksMenuRef && !bookmarksMenuRef.contains(e.target as Node)) {
      closeBookmarksMenu();
    }
  };

  onMount(() => {
    document.addEventListener('mousedown', handleClickOutside);
  });

  onCleanup(() => {
    document.removeEventListener('mousedown', handleClickOutside);
  });

  createEffect(() => {
    if (!showBookmarksMenu() || !showCreateBookmark()) return;
    queueMicrotask(() => {
      bookmarkInputRef?.focus();
      bookmarkInputRef?.select();
    });
  });

  createEffect(() => {
    if (editingPresetId() === null) return;
    queueMicrotask(() => {
      renameInputRef?.focus();
      renameInputRef?.select();
    });
  });

  const handleBookmarksButtonClick = () => {
    void sessionStore.loadPresets?.();
    setBookmarkError(null);

    if (showBookmarksMenu()) {
      closeBookmarksMenu();
      return;
    }

    setShowBookmarksMenu(true);
    setShowCreateBookmark(!hasBookmarks());
  };

  const handleSaveBookmark = async () => {
    const name = bookmarkName().trim();
    const sessionId = sessionStore.activeSessionId;
    if (!name || !sessionId || !canAddBookmark()) return;

    setBookmarkError(null);
    const saved = await sessionStore.saveBookmarkForSession(sessionId, name);
    if (saved) {
      closeBookmarksMenu();
    } else {
      setBookmarkError(sessionStore.error || 'Failed to save bookmark');
    }
  };

  const handleActivateBookmark = async (presetId: string) => {
    const sessionId = sessionStore.activeSessionId;
    if (!sessionId) return;
    setBookmarkError(null);
    const result = await sessionStore.applyPresetToSession(sessionId, presetId);
    if (result) {
      closeBookmarksMenu();
    } else {
      setBookmarkError(sessionStore.error || 'Failed to apply bookmark');
    }
  };

  const handleDeleteBookmark = async (e: MouseEvent, presetId: string) => {
    e.stopPropagation();
    setBookmarkError(null);
    await sessionStore.deletePreset(presetId);
    if (sessionStore.error) {
      setBookmarkError(sessionStore.error);
    }
  };

  const handleStartRename = (e: MouseEvent, presetId: string, currentName: string) => {
    e.stopPropagation();
    setEditingPresetId(presetId);
    setEditingPresetName(currentName);
    setBookmarkError(null);
  };

  const handleCancelRename = () => {
    setEditingPresetId(null);
    setEditingPresetName('');
  };

  const handleConfirmRename = async () => {
    const presetId = editingPresetId();
    const newName = editingPresetName().trim();
    if (!presetId || !newName) return;

    setBookmarkError(null);
    const result = await sessionStore.renamePreset(presetId, newName);
    if (result) {
      setEditingPresetId(null);
      setEditingPresetName('');
    } else {
      setBookmarkError(sessionStore.error || 'Failed to rename bookmark');
    }
  };

  return (
    <header class="header animate-fadeInUp">
      {/* Logo */}
      <div
        class={`header-logo ${props.onLogoClick ? 'header-logo--clickable' : ''}`}
        data-testid="header-logo"
        onClick={() => props.onLogoClick?.()}
        role={props.onLogoClick ? 'button' : undefined}
      >
        <Icon path={mdiXml} size={22} class="header-logo-icon" />
      </div>

      {/* Session Switcher */}
      <SessionSwitcher
        sessions={props.sessions}
        activeSessionId={props.activeSessionId}
        onSelectSession={props.onSelectSession}
        onStopSession={props.onStopSession}
        onDeleteSession={props.onDeleteSession}
        onCreateSession={props.onCreateSession}
      />

      {/* Spacer for flex layout */}
      <div class="header-spacer" />

      {/* Right side - User menu, settings, and dashboard */}
      <div class="header-actions">
        {/* Auth URL button (shown when auth URL detected in terminal) */}
        <Show when={terminalStore.authUrl}>
          <button
            type="button"
            class="header-auth-url-btn header-auth-url-bounce-in"
            onClick={() => {
              const url = terminalStore.authUrl;
              if (url) window.open(url, '_blank', 'noopener');
            }}
            title="Open auth URL"
          >
            <Icon path={mdiOpenInNew} size={16} />
            <span>Open URL</span>
          </button>
        </Show>

        {/* User menu */}
        <button type="button" class="header-user-menu" data-testid="header-user-menu" title="User menu">
          <Show when={props.userName} fallback={<Icon path={mdiAccountCircle} size={24} class="header-user-avatar" />}>
            <img src={getGravatarUrl(props.userName!, 48)} alt="Avatar" class="header-user-avatar-img" width={24} height={24} />
          </Show>
          <Show when={props.userName}>
            <span class="header-user-name">{props.userName}</span>
          </Show>
        </button>

        {/* Bookmarks button */}
        <div class="header-bookmarks-wrapper" ref={bookmarksMenuRef}>
          <button
            class="header-bookmarks-button"
            data-testid="header-bookmarks-button"
            title="Bookmarks"
            type="button"
            onClick={handleBookmarksButtonClick}
          >
            <Icon path={mdiBookOutline} size={20} />
          </button>

          <Show when={showBookmarksMenu()}>
            <div class="header-bookmarks-menu" data-testid="header-bookmarks-menu">
              <Show when={bookmarkError()}>
                <div class="header-bookmark-error" data-testid="header-bookmark-error">
                  {bookmarkError()}
                </div>
              </Show>
              <Show
                when={!showCreateBookmark()}
                fallback={
                  <div class="header-bookmarks-create">
                    <div class="header-bookmark-create-row">
                      <input
                        ref={bookmarkInputRef}
                        type="text"
                        class="header-bookmark-name-input"
                        data-testid="header-bookmark-name-input"
                        placeholder="Bookmark name"
                        value={bookmarkName()}
                        maxlength={50}
                        autocomplete="off"
                        autocorrect="off"
                        autocapitalize="off"
                        spellcheck={false}
                        onInput={(e) => setBookmarkName(e.currentTarget.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            void handleSaveBookmark();
                          }
                          if (e.key === 'Escape') {
                            if (hasBookmarks()) {
                              setShowCreateBookmark(false);
                              setBookmarkName('');
                            } else {
                              closeBookmarksMenu();
                            }
                          }
                        }}
                      />
                      <button
                        class="header-bookmark-save"
                        data-testid="header-bookmark-save"
                        type="button"
                        disabled={!canSaveBookmark()}
                        onClick={() => { void handleSaveBookmark(); }}
                      >
                        Save
                      </button>
                    </div>
                  </div>
                }
              >
                <div class="header-bookmarks-list">
                  <For each={sessionStore.presets}>
                    {(preset) => (
                      <div class="header-bookmark-row">
                        <Show
                          when={editingPresetId() !== preset.id}
                          fallback={
                            <div class="header-bookmark-rename-row" data-testid={`header-bookmark-rename-row-${preset.id}`}>
                              <input
                                ref={renameInputRef}
                                type="text"
                                class="header-bookmark-name-input"
                                data-testid={`header-bookmark-rename-input-${preset.id}`}
                                value={editingPresetName()}
                                maxlength={50}
                                autocomplete="off"
                                autocorrect="off"
                                autocapitalize="off"
                                spellcheck={false}
                                onInput={(e) => setEditingPresetName(e.currentTarget.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') {
                                    void handleConfirmRename();
                                  }
                                  if (e.key === 'Escape') {
                                    handleCancelRename();
                                  }
                                }}
                              />
                              <button
                                class="header-bookmark-rename-confirm"
                                data-testid={`header-bookmark-rename-confirm-${preset.id}`}
                                title="Confirm rename"
                                type="button"
                                disabled={!editingPresetName().trim()}
                                onClick={() => { void handleConfirmRename(); }}
                              >
                                <Icon path={mdiCheck} size={14} />
                              </button>
                              <button
                                class="header-bookmark-rename-cancel"
                                data-testid={`header-bookmark-rename-cancel-${preset.id}`}
                                title="Cancel rename"
                                type="button"
                                onClick={handleCancelRename}
                              >
                                <Icon path={mdiClose} size={14} />
                              </button>
                            </div>
                          }
                        >
                          <button
                            class="header-bookmark-item"
                            data-testid={`header-bookmark-item-${preset.id}`}
                            title={preset.name}
                            type="button"
                            onClick={() => { void handleActivateBookmark(preset.id); }}
                          >
                            <span class="header-bookmark-item-name">{preset.name}</span>
                            <span class="header-bookmark-item-badge">{preset.tabs.length} tabs</span>
                          </button>
                          <button
                            class="header-bookmark-rename"
                            data-testid={`header-bookmark-rename-${preset.id}`}
                            title="Rename bookmark"
                            type="button"
                            onClick={(e) => { handleStartRename(e, preset.id, preset.name); }}
                          >
                            <Icon path={mdiPencilOutline} size={14} />
                          </button>
                          <button
                            class="header-bookmark-delete"
                            data-testid={`header-bookmark-delete-${preset.id}`}
                            title="Delete bookmark"
                            type="button"
                            onClick={(e) => { void handleDeleteBookmark(e, preset.id); }}
                          >
                            <Icon path={mdiDelete} size={14} />
                          </button>
                        </Show>
                      </div>
                    )}
                  </For>
                </div>

                <Show when={canAddBookmark()}>
                  <button
                    class="header-bookmark-add"
                    data-testid="header-bookmark-add-new"
                    type="button"
                    onClick={() => {
                      setShowCreateBookmark(true);
                      setBookmarkName('');
                    }}
                  >
                    <Icon path={mdiPlus} size={14} />
                    <span>Add New</span>
                  </button>
                </Show>
              </Show>
            </div>
          </Show>
        </div>

        {/* Storage button */}
        <button
          class="header-storage-button"
          data-testid="header-storage-button"
          title="Storage"
          type="button"
          onClick={() => props.onStoragePanelToggle?.()}
        >
          <Icon path={mdiFileCabinet} size={20} />
        </button>

        {/* Settings button */}
        <button
          class="header-settings-button"
          data-testid="header-settings-button"
          title="Settings"
          type="button"
          onClick={() => props.onSettingsClick?.()}
        >
          <Icon path={mdiCogOutline} size={20} class="settings-rotate" />
        </button>

        {/* Dashboard button */}
        <button
          class="header-dashboard-button"
          data-testid="header-dashboard-button"
          title="Return to dashboard"
          type="button"
          onClick={() => props.onLogoClick?.()}
        >
          <Icon path={mdiViewDashboardOutline} size={20} />
        </button>
      </div>
    </header>
  );
};

export default Header;
