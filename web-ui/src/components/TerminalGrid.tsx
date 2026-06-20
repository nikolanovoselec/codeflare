import { createMemo, For, JSX, Show } from 'solid-js';
import type { TileLayout } from '../types';
import '../styles/tiled-terminal-container.css';

export interface TerminalGridPane<T> {
  id: string;
  data: T;
  active: boolean;
}

interface TerminalGridProps<T> {
  layout: TileLayout;
  panes: TerminalGridPane<T>[];
  onPaneClick: (paneId: string) => void;
  renderPane: (pane: TerminalGridPane<T>, slotIndex: number) => JSX.Element;
  testId?: string;
  slotTestId?: (paneId: string) => string;
  emptySlotTestId?: (slotIndex: number) => string;
}

const SLOT_INDEXES: Record<TileLayout, number[]> = {
  tabbed: [0],
  '2-split': [0, 1],
  '3-split': [0, 1, 2],
  '4-grid': [0, 1, 2, 3],
};

function getLayoutClass(layout: TileLayout): string {
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
}

const TerminalGrid = <T,>(props: TerminalGridProps<T>) => {
  const slotIndexes = () => SLOT_INDEXES[props.layout];
  const visiblePaneIds = createMemo(() => props.panes.slice(0, slotIndexes().length).map((pane) => pane.id));
  const paneById = createMemo(() => new Map(props.panes.map((pane) => [pane.id, pane] as const)));
  const emptySlotIndexes = createMemo(() => slotIndexes().slice(visiblePaneIds().length));

  return (
    <div
      data-testid={props.testId || 'terminal-grid'}
      data-layout={props.layout}
      class={`tiled-terminal-container ${getLayoutClass(props.layout)}`}
    >
      <For each={visiblePaneIds()}>
        {(paneId, slotIndex) => {
          const currentPane = createMemo(() => paneById().get(paneId));
          const pane = {
            get id() { return paneId; },
            get data() { return currentPane()?.data as T; },
            get active() { return currentPane()?.active ?? false; },
          } as TerminalGridPane<T>;

          return (
            <Show when={currentPane()}>
              <div
                data-testid={props.slotTestId ? props.slotTestId(pane.id) : `terminal-grid-slot-${pane.id}`}
                data-active={pane.active ? 'true' : 'false'}
                class={`tiled-terminal-slot ${pane.active ? 'tiled-terminal-slot--active' : ''}`}
                onClick={() => props.onPaneClick(pane.id)}
              >
                {props.renderPane(pane, slotIndex())}
              </div>
            </Show>
          );
        }}
      </For>
      <For each={emptySlotIndexes()}>
        {(slotIndex) => (
          <div
            data-testid={props.emptySlotTestId ? props.emptySlotTestId(slotIndex) : `terminal-grid-empty-${slotIndex}`}
            data-active="false"
            class="tiled-terminal-slot tiled-terminal-slot--empty"
          />
        )}
      </For>
    </div>
  );
};

export default TerminalGrid;
