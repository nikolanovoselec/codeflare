import { Component, For, Show, createMemo, createSignal, onCleanup, createEffect } from 'solid-js';
import { mdiPlus, mdiClose, mdiDragVertical } from '@mdi/js';
import { DragDropProvider, DragDropSensors, SortableProvider, createSortable, closestCenter, DragEvent } from '@thisbeyond/solid-dnd';
import Icon from './Icon';
import { sessionStore } from '../stores/session';
import { TERMINAL_TAB_CONFIG, getTabIcon } from '../lib/terminal-config';
import { MAX_TERMINALS_PER_SESSION } from '../lib/constants';
import { isMobile } from '../lib/mobile';
import { LAYOUT_MIN_TABS } from '../stores/tiling';
import '../styles/terminal-tabs.css';

interface TerminalTabsProps {
  sessionId: string;
}

// Resolve tab label: live processName > session tabConfig > TERMINAL_TAB_CONFIG fallback
function resolveTabLabel(sessionId: string, tabId: string): string {
  // 1. Live processName from store
  const terminals = sessionStore.getTerminalsForSession(sessionId);
  const tab = terminals?.tabs.find(t => t.id === tabId);
  if (tab?.processName) return tab.processName;

  // 2. Session's tabConfig label
  const session = sessionStore.sessions.find(s => s.id === sessionId);
  const tabCfg = session?.tabConfig?.find(tc => tc.id === tabId);
  if (tabCfg?.label) return tabCfg.label;

  // 3. Fallback to static config
  return TERMINAL_TAB_CONFIG[tabId]?.name || `Terminal ${tabId}`;
}

// Resolve tab icon: live processName > static config
function resolveTabIcon(sessionId: string, tabId: string): string {
  const terminals = sessionStore.getTerminalsForSession(sessionId);
  const tab = terminals?.tabs.find(t => t.id === tabId);
  if (tab?.processName) return getTabIcon(tab.processName);
  return TERMINAL_TAB_CONFIG[tabId]?.icon || TERMINAL_TAB_CONFIG['4'].icon;
}

// Get tab type from resolved label (for CSS data-type attribute)
function getTabType(sessionId: string, tabId: string): string {
  return resolveTabLabel(sessionId, tabId);
}

// Sortable tab component for tabs 2-6
const SortableTab: Component<{
  id: string;
  sessionId: string;
  isActive: boolean;
  canClose: boolean;
  onSelect: () => void;
  onClose: (e: MouseEvent) => void;
  onPointerDown?: (e: PointerEvent) => void;
  onPointerUp?: (e: PointerEvent) => void;
  onPointerLeave?: (e: PointerEvent) => void;
  onPointerCancel?: (e: PointerEvent) => void;
  onContextMenu?: (e: Event) => void;
}> = (props) => {
  const sortable = createSortable(props.id);

  return (
    <div
      ref={sortable.ref}
      class={`terminal-tab ${props.isActive ? 'terminal-tab--active' : ''} ${sortable.isActiveDraggable ? 'terminal-tab--dragging' : ''}`}
      data-testid={`terminal-tab-${props.id}`}
      data-type={getTabType(props.sessionId, props.id)}
      data-active={props.isActive ? 'true' : 'false'}
      onClick={() => props.onSelect()}
      onPointerDown={props.onPointerDown}
      onPointerUp={props.onPointerUp}
      onPointerLeave={props.onPointerLeave}
      onPointerCancel={props.onPointerCancel}
      onContextMenu={props.onContextMenu}
      classList={{ 'sortable-ghost': sortable.isActiveDraggable }}
    >
      <div
        class="terminal-tab-drag-handle"
        data-testid={`terminal-tab-${props.id}-drag-handle`}
        {...sortable.dragActivators}
      >
        <Icon path={mdiDragVertical} size={14} />
      </div>
      <Icon
        path={resolveTabIcon(props.sessionId, props.id)}
        size={14}
        class="terminal-tab-icon"
        data-testid={`terminal-tab-${props.id}-icon`}
      />
      <span class="terminal-tab-label">{resolveTabLabel(props.sessionId, props.id)}</span>
      <Show when={props.canClose}>
        <button
          type="button"
          class="terminal-tab-close"
          data-testid={`terminal-tab-${props.id}-close`}
          onClick={(e) => props.onClose(e)}
          title="Close terminal"
        >
          <Icon path={mdiClose} size={14} />
        </button>
      </Show>
    </div>
  );
};

// Static tab component for tab 1 (not draggable)
const StaticTab: Component<{
  id: string;
  sessionId: string;
  isActive: boolean;
  canClose: boolean;
  onSelect: () => void;
  onClose: (e: MouseEvent) => void;
  onPointerDown?: (e: PointerEvent) => void;
  onPointerUp?: (e: PointerEvent) => void;
  onPointerLeave?: (e: PointerEvent) => void;
  onPointerCancel?: (e: PointerEvent) => void;
  onContextMenu?: (e: Event) => void;
}> = (props) => {
  return (
    <div
      class={`terminal-tab ${props.isActive ? 'terminal-tab--active' : ''}`}
      data-testid={`terminal-tab-${props.id}`}
      data-type={getTabType(props.sessionId, props.id)}
      data-active={props.isActive ? 'true' : 'false'}
      onClick={() => props.onSelect()}
      onPointerDown={props.onPointerDown}
      onPointerUp={props.onPointerUp}
      onPointerLeave={props.onPointerLeave}
      onPointerCancel={props.onPointerCancel}
      onContextMenu={props.onContextMenu}
    >
      <Icon
        path={resolveTabIcon(props.sessionId, props.id)}
        size={14}
        class="terminal-tab-icon"
        data-testid={`terminal-tab-${props.id}-icon`}
      />
      <span class="terminal-tab-label">{resolveTabLabel(props.sessionId, props.id)}</span>
      <Show when={props.canClose}>
        <button
          type="button"
          class="terminal-tab-close"
          data-testid={`terminal-tab-${props.id}-close`}
          onClick={(e) => props.onClose(e)}
          title="Close terminal"
        >
          <Icon path={mdiClose} size={14} />
        </button>
      </Show>
    </div>
  );
};

const TerminalTabs: Component<TerminalTabsProps> = (props) => {
  const terminals = createMemo(() => sessionStore.getTerminalsForSession(props.sessionId));
  const canAddTab = createMemo(() => (terminals()?.tabs.length || 0) < MAX_TERMINALS_PER_SESSION);
  const canCloseTab = createMemo(() => (terminals()?.tabs.length || 0) > 1);

  // Mobile close popup state
  const [closePopupTabId, setClosePopupTabId] = createSignal<string | null>(null);
  let longPressTimer: ReturnType<typeof setTimeout> | null = null;

  // Clean up timer on unmount
  onCleanup(() => {
    if (longPressTimer) clearTimeout(longPressTimer);
  });

  // Dismiss popup when clicking outside
  createEffect(() => {
    const popupTabId = closePopupTabId();
    if (popupTabId) {
      const handleClickOutside = () => setClosePopupTabId(null);
      // Defer listener to avoid catching the triggering click
      requestAnimationFrame(() => {
        document.addEventListener('click', handleClickOutside, { once: true });
      });
      onCleanup(() => document.removeEventListener('click', handleClickOutside));
    }
  });

  const clearLongPress = () => {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  };

  const handlePointerDown = (tabId: string) => (e: PointerEvent) => {
    if (!isMobile() || tabId === '1') return;
    clearLongPress();
    longPressTimer = setTimeout(() => {
      setClosePopupTabId(tabId);
      longPressTimer = null;
    }, 500);
  };

  const handlePointerUp = () => {
    clearLongPress();
  };

  const handleContextMenu = (e: Event) => {
    if (isMobile()) e.preventDefault();
  };

  const handleCloseFromPopup = (e: MouseEvent, tabId: string) => {
    e.stopPropagation();
    setClosePopupTabId(null);
    if (tabId === '1') return;
    if (canCloseTab()) {
      sessionStore.removeTerminalTab(props.sessionId, tabId);
    }
  };

  // Get ordered tabs based on tabOrder
  const orderedTabs = createMemo(() => {
    const terminalData = terminals();
    if (!terminalData) return [];

    const tabOrder = terminalData.tabOrder || terminalData.tabs.map(t => t.id);
    const tabMap = new Map(terminalData.tabs.map(t => [t.id, t]));

    return tabOrder.map(id => tabMap.get(id)).filter((t): t is NonNullable<typeof t> => t !== undefined);
  });

  // Get sortable IDs (excluding tab 1 which is always first and not draggable)
  const sortableIds = createMemo(() => {
    const ordered = orderedTabs();
    return ordered.filter(t => t.id !== '1').map(t => t.id);
  });

  const handleAddTab = () => {
    sessionStore.addTerminalTab(props.sessionId);
  };

  const handleSelectTab = (terminalId: string) => {
    // On mobile, tapping the already-active tab shows the close popup (except tab 1)
    if (isMobile() && terminalId !== '1' && terminalId === terminals()?.activeTabId) {
      setClosePopupTabId(terminalId);
      return;
    }

    // Auto-disable tiling when clicking a tab outside the visible tiled set
    const tiling = sessionStore.getTilingForSession(props.sessionId);
    if (tiling?.enabled && tiling.layout !== 'tabbed') {
      const slotCount = LAYOUT_MIN_TABS[tiling.layout];
      const tabOrder = terminals()?.tabOrder || orderedTabs().map(t => t.id);
      const visibleTabs = new Set(tabOrder.slice(0, slotCount));
      if (!visibleTabs.has(terminalId)) {
        sessionStore.setTilingLayout(props.sessionId, 'tabbed');
      }
    }

    sessionStore.setActiveTerminalTab(props.sessionId, terminalId);
  };

  const handleCloseTab = (e: MouseEvent, terminalId: string) => {
    e.stopPropagation();
    if (terminalId === '1') return;
    if (canCloseTab()) {
      sessionStore.removeTerminalTab(props.sessionId, terminalId);
    }
  };

  const onDragEnd = (event: DragEvent) => {
    const { draggable, droppable } = event;
    if (draggable && droppable && draggable.id !== droppable.id) {
      const currentOrder = terminals()?.tabOrder || orderedTabs().map(t => t.id);
      const fromIndex = currentOrder.indexOf(String(draggable.id));
      const toIndex = currentOrder.indexOf(String(droppable.id));

      if (fromIndex !== -1 && toIndex !== -1 && fromIndex !== toIndex) {
        const newOrder = [...currentOrder];
        newOrder.splice(fromIndex, 1);
        newOrder.splice(toIndex, 0, String(draggable.id));

        // Ensure tab 1 stays first
        if (newOrder[0] === '1') {
          sessionStore.reorderTerminalTabs(props.sessionId, newOrder);
        }
      }
    }
  };

  return (
    <div class="terminal-tabs" data-testid="terminal-tabs">
      <DragDropProvider onDragEnd={onDragEnd} collisionDetector={closestCenter}>
        <DragDropSensors />
        {/* Tab 1 is always first and not draggable */}
        <Show when={orderedTabs().find(t => t.id === '1')}>
          {(tab) => (
            <StaticTab
              id={tab().id}
              sessionId={props.sessionId}
              isActive={tab().id === terminals()?.activeTabId}
              canClose={false}
              onSelect={() => handleSelectTab(tab().id)}
              onClose={(e) => handleCloseTab(e, tab().id)}
            />
          )}
        </Show>

        {/* Sortable tabs (2-6) */}
        <SortableProvider ids={sortableIds()}>
          <For each={orderedTabs().filter(t => t.id !== '1')}>
            {(tab) => (
              <div style={{ position: 'relative' }}>
                <SortableTab
                  id={tab.id}
                  sessionId={props.sessionId}
                  isActive={tab.id === terminals()?.activeTabId}
                  canClose={canCloseTab()}
                  onSelect={() => handleSelectTab(tab.id)}
                  onClose={(e) => handleCloseTab(e, tab.id)}
                  onPointerDown={handlePointerDown(tab.id)}
                  onPointerUp={handlePointerUp}
                  onPointerLeave={handlePointerUp}
                  onPointerCancel={handlePointerUp}
                  onContextMenu={handleContextMenu}
                />
                <Show when={closePopupTabId() === tab.id}>
                  <div class="terminal-tab-close-popup" data-testid={`close-popup-${tab.id}`} onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      class="terminal-tab-close-popup-btn"
                      data-testid={`close-popup-btn-${tab.id}`}
                      onClick={(e) => handleCloseFromPopup(e, tab.id)}
                    >
                      <Icon path={mdiClose} size={14} />
                      Close
                    </button>
                  </div>
                </Show>
              </div>
            )}
          </For>
        </SortableProvider>
      </DragDropProvider>

      <Show when={canAddTab()}>
        <button
          type="button"
          class="terminal-tab-add"
          data-testid="terminal-tab-add"
          onClick={handleAddTab}
          title="New terminal (max 6)"
        >
          <Icon path={mdiPlus} size={16} />
        </button>
      </Show>
    </div>
  );
};

export default TerminalTabs;
