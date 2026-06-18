import { Component, For, Show, createSignal, createEffect, onMount, onCleanup } from 'solid-js';
import { type ScopeTier, type TierConfig } from '../../lib/token-scopes';
import '../../styles/create-session-dialog.css';

const TIER_ORDER: ScopeTier[] = ['minimal', 'recommended', 'advanced'];

// ~3 tier rows + section header; used to decide flip-above/below vs the anchor.
const DIALOG_ESTIMATED_HEIGHT = 220;
const GAP = 8;
// Comfortable desktop/tablet popover width (matches the "+ New Session" picker).
const DIALOG_WIDTH = 300;

interface TierChooserDialogProps {
  open: boolean;
  onClose: () => void;
  /** Anchor for desktop popover positioning; on mobile it becomes a bottom sheet (CSS). */
  anchorRef?: HTMLElement;
  /** Scopes the data-testids so multiple instances stay unambiguous. */
  provider: string;
  tiers: Record<ScopeTier, TierConfig>;
  selected: ScopeTier;
  /** Picking a tier = connect (mirrors the "+ New Session" agent picker). */
  onPick: (tier: ScopeTier) => void;
}

/**
 * Scope-tier picker rendered as the same responsive chooser as the "+ New Session"
 * agent dialog: a popover anchored to the trigger on desktop, a full-width bottom
 * sheet on mobile (reuses create-session-dialog.css). Each row shows the tier label
 * + a description subtitle. Used by the dashboard GitHub panel connect card.
 */
const TierChooserDialog: Component<TierChooserDialogProps> = (props) => {
  let dialogRef: HTMLDivElement | undefined;
  const [position, setPosition] = createSignal<{ top: number; left: number; width: number }>({ top: 0, left: 0, width: 300 });

  const updatePosition = () => {
    if (!props.anchorRef) return;
    const rect = props.anchorRef.getBoundingClientRect();
    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;
    const spaceBelow = viewportHeight - rect.bottom - GAP;
    const spaceAbove = rect.top - GAP;
    let top: number;
    if (spaceBelow >= DIALOG_ESTIMATED_HEIGHT) top = rect.bottom + GAP;
    else if (spaceAbove >= DIALOG_ESTIMATED_HEIGHT) top = rect.top - GAP - DIALOG_ESTIMATED_HEIGHT;
    else top = spaceBelow >= spaceAbove ? rect.bottom + GAP : Math.max(GAP, rect.top - GAP - DIALOG_ESTIMATED_HEIGHT);
    // The connect button is a narrow, centered inline-flex, so inheriting its
    // width yields a cramped popover. Use a comfortable fixed width (like the
    // "+ New Session" picker) clamped to the viewport, and keep the left edge
    // on-screen. Mobile (≤640px) ignores this — create-session-dialog.css
    // promotes the dialog to a full-width bottom sheet.
    const width = Math.min(DIALOG_WIDTH, viewportWidth - GAP * 2);
    const left = Math.max(GAP, Math.min(rect.left, viewportWidth - width - GAP));
    setPosition({ top, left, width });
  };

  // Focus management for the modal picker: on open, remember the trigger and move
  // focus into the dialog; on close, restore focus to the trigger (the connect
  // button) so keyboard users land back where they were.
  let previouslyFocused: HTMLElement | null = null;
  createEffect(() => {
    if (props.open) {
      previouslyFocused = (document.activeElement as HTMLElement) ?? null;
      updatePosition();
      dialogRef?.focus();
    } else if (previouslyFocused) {
      // Only restore focus if we actually opened (never steal focus on mount).
      (props.anchorRef ?? previouslyFocused)?.focus();
      previouslyFocused = null;
    }
  });

  const handleClickOutside = (e: MouseEvent) => {
    if (!props.open) return;
    if (dialogRef && !dialogRef.contains(e.target as Node)) {
      if (props.anchorRef && props.anchorRef.contains(e.target as Node)) return;
      props.onClose();
    }
  };
  const handleKeyDown = (e: KeyboardEvent) => {
    if (!props.open) return;
    if (e.key === 'Escape') { props.onClose(); return; }
    // Trap Tab within the dialog (aria-modal contract).
    if (e.key === 'Tab' && dialogRef) {
      const focusable = dialogRef.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === dialogRef)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  onMount(() => {
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
  });
  onCleanup(() => {
    document.removeEventListener('mousedown', handleClickOutside);
    document.removeEventListener('keydown', handleKeyDown);
  });

  return (
    <Show when={props.open}>
      <div class="csd-backdrop" onClick={() => props.onClose()} />
      <div
        ref={dialogRef}
        class="create-session-dialog"
        data-testid={`${props.provider}-tier-dialog`}
        role="dialog"
        aria-modal="true"
        aria-label="Choose access level"
        tabindex="-1"
        style={{ top: `${position().top}px`, left: `${position().left}px`, width: `${position().width}px` }}
      >
        <div class="csd-section">
          <div class="csd-section-header"><span>Access level</span></div>
          <div class="csd-agents">
            <For each={TIER_ORDER}>
              {(tier) => (
                <button
                  type="button"
                  class={`csd-agent-btn ${props.selected === tier ? 'csd-agent-btn--last-used' : ''}`}
                  data-testid={`${props.provider}-tier-${tier}`}
                  data-value={tier}
                  onClick={() => props.onPick(tier)}
                >
                  <div class="csd-agent-info">
                    <span class="csd-agent-label">{props.tiers[tier].label}</span>
                    <span class="csd-agent-desc">{props.tiers[tier].description}</span>
                  </div>
                </button>
              )}
            </For>
          </div>
        </div>
      </div>
    </Show>
  );
};

export default TierChooserDialog;
