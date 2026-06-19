import { createMemo, Index, JSX, Show } from 'solid-js';
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
  const slots = () => SLOT_INDEXES[props.layout];

  return (
    <div
      data-testid={props.testId || 'terminal-grid'}
      data-layout={props.layout}
      class={`tiled-terminal-container ${getLayoutClass(props.layout)}`}
    >
      <Index each={slots()}>
        {(slot) => {
          const slotIndex = () => slot();
          const slotPane = createMemo(() => props.panes[slotIndex()] ?? null);
          const paneId = createMemo(() => slotPane()?.id ?? null);
          return (
            <Show
              keyed
              when={paneId()}
              fallback={
                <div
                  data-testid={props.emptySlotTestId ? props.emptySlotTestId(slotIndex()) : `terminal-grid-empty-${slotIndex()}`}
                  data-active="false"
                  class="tiled-terminal-slot tiled-terminal-slot--empty"
                />
              }
            >
              {(id) => {
                const pane = {
                  get id() { return id; },
                  get data() { return slotPane()!.data; },
                  get active() { return slotPane()!.active; },
                } as TerminalGridPane<T>;
                return (
                  <div
                    data-testid={props.slotTestId ? props.slotTestId(pane.id) : `terminal-grid-slot-${pane.id}`}
                    data-active={pane.active ? 'true' : 'false'}
                    class={`tiled-terminal-slot ${pane.active ? 'tiled-terminal-slot--active' : ''}`}
                    onClick={() => props.onPaneClick(pane.id)}
                  >
                    {props.renderPane(pane, slotIndex())}
                  </div>
                );
              }}
            </Show>
          );
        }}
      </Index>
    </div>
  );
};

export default TerminalGrid;
