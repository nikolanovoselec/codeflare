import { Component, JSX } from 'solid-js';
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
  const orderedPanes = (): TerminalGridPane<TerminalTab>[] => {
    const terminalMap = new Map(props.terminals.map((terminal) => [terminal.id, terminal]));
    return props.tabOrder
      .map((tabId) => terminalMap.get(tabId))
      .filter((terminal): terminal is TerminalTab => Boolean(terminal))
      .map((terminal) => ({
        id: terminal.id,
        data: terminal,
        active: props.activeTabId === terminal.id,
      }));
  };

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
