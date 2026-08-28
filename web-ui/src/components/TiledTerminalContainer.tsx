import { Component, JSX, createMemo } from 'solid-js';
import TerminalGrid, { type TerminalGridPane } from './TerminalGrid';
import type { TerminalTab, TileLayout } from '../types';

interface TiledTerminalContainerProps {
  sessionId: string;
  terminals: TerminalTab[];
  tabOrder: string[];
  layout: TileLayout;
  activeTabId: string | null;
  onTileClick: (tabId: string) => void;
  renderTerminal?: (tabId: string, slotIndex: number) => JSX.Element;
}

const TiledTerminalContainer: Component<TiledTerminalContainerProps> = (props) => {
  const terminalById = createMemo(() =>
    new Map(props.terminals.map((terminal) => [terminal.id, terminal] as const)),
  );
  const orderedPanes = createMemo<TerminalGridPane<TerminalTab>[]>((previous) => {
    const ids = props.tabOrder.filter((tabId) => terminalById().has(tabId));
    if (previous?.length === ids.length && previous.every((pane, index) => pane.id === ids[index])) {
      return previous;
    }

    return ids.map((id) => ({
      id,
      get data() { return terminalById().get(id)!; },
      get active() { return props.activeTabId === id; },
    }));
  });

  return (
    <TerminalGrid
      layout={props.layout}
      panes={orderedPanes()}
      onPaneClick={props.onTileClick}
      testId="tiled-terminal-container"
      slotTestId={(tabId) => `tiled-slot-${tabId}`}
      emptySlotTestId={(slotIndex) => `tiled-slot-empty-${slotIndex}`}
      renderPane={(pane, slotIndex) => props.renderTerminal?.(pane.data.id, slotIndex)}
    />
  );
};

export default TiledTerminalContainer;
