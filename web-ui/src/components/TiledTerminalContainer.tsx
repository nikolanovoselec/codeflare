import { Component, For, Show, JSX } from 'solid-js';
import type { TerminalTab, TileLayout } from '../types';
import '../styles/tiled-terminal-container.css';

interface TiledTerminalContainerProps {
  sessionId: string;
  terminals: TerminalTab[];
  tabOrder: string[];
  layout: TileLayout;
  activeTabId: string | null;
  onTileClick: (tabId: string) => void;
  renderTerminal?: (tabId: string, slotIndex: number) => JSX.Element;
}

// Number of slots for each layout type
const LAYOUT_SLOTS: Record<TileLayout, number> = {
  tabbed: 1,
  '2-split': 2,
  '3-split': 3,
  '4-grid': 4,
};

// Get the CSS class modifier for a layout
const getLayoutClass = (layout: TileLayout): string => {
  switch (layout) {
    case '2-split':
      return 'tiled--2-split';
    case '3-split':
      return 'tiled--3-split';
    case '4-grid':
      return 'tiled--4-grid';
    default:
      return '';
  }
};

const TiledTerminalContainer: Component<TiledTerminalContainerProps> = (props) => {
  // Create terminal map for quick lookup
  const getTerminalById = (id: string): TerminalTab | undefined => {
    return props.terminals.find((t) => t.id === id);
  };

  // Generate slot data based on layout and tabOrder
  const getSlots = () => {
    const slotCount = LAYOUT_SLOTS[props.layout];
    const slots: Array<{ tabId: string | null; isEmpty: boolean; index: number }> = [];

    for (let i = 0; i < slotCount; i++) {
      const tabId = props.tabOrder[i];
      const terminal = tabId ? getTerminalById(tabId) : undefined;

      slots.push({
        tabId: terminal ? tabId : null,
        isEmpty: !terminal,
        index: i,
      });
    }

    return slots;
  };

  const handleSlotClick = (tabId: string | null) => {
    if (tabId) {
      props.onTileClick(tabId);
    }
  };

  return (
    <div
      data-testid="tiled-terminal-container"
      data-layout={props.layout}
      class={`tiled-terminal-container ${getLayoutClass(props.layout)}`}
    >
      <For each={getSlots()}>
        {(slot) => (
          <Show
            when={!slot.isEmpty}
            fallback={
              <div
                data-testid={`tiled-slot-empty-${slot.index}`}
                data-active="false"
                class="tiled-terminal-slot tiled-terminal-slot--empty"
                onClick={() => handleSlotClick(null)}
              />
            }
          >
            <div
              data-testid={`tiled-slot-${slot.tabId}`}
              data-active={props.activeTabId === slot.tabId ? 'true' : 'false'}
              class={`tiled-terminal-slot ${
                props.activeTabId === slot.tabId ? 'tiled-terminal-slot--active' : ''
              }`}
              onClick={() => handleSlotClick(slot.tabId)}
            >
              {/* Terminal content rendered via renderTerminal prop */}
              {props.renderTerminal && slot.tabId && props.renderTerminal(slot.tabId, slot.index)}
            </div>
          </Show>
        )}
      </For>
    </div>
  );
};

export default TiledTerminalContainer;
