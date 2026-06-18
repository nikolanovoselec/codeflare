import { For, JSX, Show } from 'solid-js';
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

const LAYOUT_SLOTS: Record<TileLayout, number> = {
  tabbed: 1,
  '2-split': 2,
  '3-split': 3,
  '4-grid': 4,
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
  const slots = () => {
    const slotCount = LAYOUT_SLOTS[props.layout];
    return Array.from({ length: slotCount }, (_, index) => ({
      index,
      pane: props.panes[index] ?? null,
    }));
  };

  return (
    <div
      data-testid={props.testId || 'terminal-grid'}
      data-layout={props.layout}
      class={`tiled-terminal-container ${getLayoutClass(props.layout)}`}
    >
      <For each={slots()}>
        {(slot) => (
          <Show
            when={slot.pane}
            fallback={
              <div
                data-testid={props.emptySlotTestId ? props.emptySlotTestId(slot.index) : `terminal-grid-empty-${slot.index}`}
                data-active="false"
                class="tiled-terminal-slot tiled-terminal-slot--empty"
              />
            }
          >
            {(pane) => (
              <div
                data-testid={props.slotTestId ? props.slotTestId(pane().id) : `terminal-grid-slot-${pane().id}`}
                data-active={pane().active ? 'true' : 'false'}
                class={`tiled-terminal-slot ${pane().active ? 'tiled-terminal-slot--active' : ''}`}
                onClick={() => props.onPaneClick(pane().id)}
              >
                {props.renderPane(pane(), slot.index)}
              </div>
            )}
          </Show>
        )}
      </For>
    </div>
  );
};

export default TerminalGrid;
