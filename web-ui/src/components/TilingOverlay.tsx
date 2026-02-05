import { Component, For, Show } from 'solid-js';
import type { TileLayout } from '../types';
import '../styles/tiling-overlay.css';

interface TilingOverlayProps {
  tabCount: number;
  currentLayout: TileLayout;
  onSelectLayout: (layout: TileLayout) => void;
  onClose: () => void;
}

interface LayoutOption {
  layout: TileLayout;
  label: string;
  ariaLabel: string;
  minTabs: number;
}

const layoutOptions: LayoutOption[] = [
  { layout: 'tabbed', label: 'Tabbed', ariaLabel: 'Tabbed layout', minTabs: 1 },
  { layout: '2-split', label: '2 Split', ariaLabel: '2 Split layout', minTabs: 2 },
  { layout: '3-split', label: '3 Split', ariaLabel: '3 Split layout', minTabs: 3 },
  { layout: '4-grid', label: '4 Grid', ariaLabel: '4 Grid layout', minTabs: 4 },
];

/**
 * SVG Preview Icons for each layout type
 */
const TabbedIcon: Component = () => (
  <svg viewBox="0 0 40 30" class="tiling-preview-icon">
    <rect x="2" y="2" width="36" height="26" rx="2" class="tiling-preview-rect" />
  </svg>
);

const TwoSplitIcon: Component = () => (
  <svg viewBox="0 0 40 30" class="tiling-preview-icon">
    <rect x="2" y="2" width="17" height="26" rx="2" class="tiling-preview-rect" />
    <rect x="21" y="2" width="17" height="26" rx="2" class="tiling-preview-rect" />
  </svg>
);

const ThreeSplitIcon: Component = () => (
  <svg viewBox="0 0 40 30" class="tiling-preview-icon">
    <rect x="2" y="2" width="17" height="26" rx="2" class="tiling-preview-rect" />
    <rect x="21" y="2" width="17" height="12" rx="2" class="tiling-preview-rect" />
    <rect x="21" y="16" width="17" height="12" rx="2" class="tiling-preview-rect" />
  </svg>
);

const FourGridIcon: Component = () => (
  <svg viewBox="0 0 40 30" class="tiling-preview-icon">
    <rect x="2" y="2" width="17" height="12" rx="2" class="tiling-preview-rect" />
    <rect x="21" y="2" width="17" height="12" rx="2" class="tiling-preview-rect" />
    <rect x="2" y="16" width="17" height="12" rx="2" class="tiling-preview-rect" />
    <rect x="21" y="16" width="17" height="12" rx="2" class="tiling-preview-rect" />
  </svg>
);

const getLayoutIcon = (layout: TileLayout): Component => {
  switch (layout) {
    case 'tabbed':
      return TabbedIcon;
    case '2-split':
      return TwoSplitIcon;
    case '3-split':
      return ThreeSplitIcon;
    case '4-grid':
      return FourGridIcon;
  }
};

/**
 * TilingOverlay - Dropdown for selecting terminal tiling layout
 *
 * Layout:
 * +---------------------------+
 * |  [====]  Tabbed           |
 * |  [= =]   2 Split          |
 * |  [= =]   3 Split          |
 * |  [====]  4 Grid           |
 * +---------------------------+
 */
const TilingOverlay: Component<TilingOverlayProps> = (props) => {
  const availableOptions = () =>
    layoutOptions.filter((option) => option.minTabs <= props.tabCount);

  const handleOptionClick = (layout: TileLayout) => {
    props.onSelectLayout(layout);
  };

  const handleBackdropClick = () => {
    props.onClose();
  };

  const handleOverlayClick = (e: MouseEvent) => {
    e.stopPropagation();
  };

  return (
    <>
      {/* Invisible backdrop for outside click detection */}
      <div
        class="tiling-overlay-backdrop"
        onClick={handleBackdropClick}
        data-testid="tiling-overlay-backdrop"
      />

      {/* Overlay popover */}
      <div
        class="tiling-overlay"
        role="menu"
        onClick={handleOverlayClick}
        data-testid="tiling-overlay"
      >
        <For each={availableOptions()}>
          {(option) => {
            const IconComponent = getLayoutIcon(option.layout);
            const isActive = () => props.currentLayout === option.layout;

            return (
              <button
                type="button"
                class={`tiling-option ${isActive() ? 'tiling-option--active' : ''}`}
                role="menuitem"
                aria-label={option.ariaLabel}
                onClick={() => handleOptionClick(option.layout)}
                data-testid={`tiling-option-${option.layout}`}
                data-active={isActive() ? 'true' : 'false'}
              >
                <IconComponent />
                <span class="tiling-option-label">{option.label}</span>
              </button>
            );
          }}
        </For>

      </div>
    </>
  );
};

export default TilingOverlay;
