const overflowOrder = ['vscode', 'operators', 'vault'] as const;
export type OverflowHeaderAction = typeof overflowOrder[number];
export const HEADER_ICON_SLOT = 44;

export function measureProfileMenu(anchor: HTMLElement, hasEmail = false) {
  const rect = anchor.getBoundingClientRect();
  const top = rect.bottom + 8;
  const narrow = window.matchMedia?.('(max-width: 640px)').matches ?? window.innerWidth <= 640;
  return {
    top,
    right: window.innerWidth - rect.right,
    sheet: narrow || window.innerHeight - top - 8 < HEADER_ICON_SLOT + (hasEmail ? 32 : 0),
  };
}

/** Widths are CSS pixels. Action widths include the spacing their removal saves. */
export function fitHeaderActions(
  width: number,
  fixedWidth: number,
  actionWidths: Partial<Record<OverflowHeaderAction, number>>,
) {
  let required = fixedWidth + HEADER_ICON_SLOT;
  for (const action of overflowOrder) required += actionWidths[action] ?? 0;
  const overflow: OverflowHeaderAction[] = [];
  for (const action of overflowOrder) {
    if (required <= width) break;
    const occupied = actionWidths[action];
    if (!occupied) continue;
    overflow.push(action);
    required -= occupied;
  }
  return { overflow, fits: required <= width };
}

/** Read occupied widths from the shared header structure before allocating overflow. */
export function measureHeaderActions(header: HTMLElement, actions: HTMLElement, eligible: readonly OverflowHeaderAction[]) {
  const style = getComputedStyle(header);
  const pixels = (value: string) => Number.parseFloat(value) || 0;
  const room = header.clientWidth - pixels(style.paddingLeft) - pixels(style.paddingRight);
  const actionGap = pixels(getComputedStyle(actions).columnGap);
  const fixedActions = [...actions.children].filter(el => !el.hasAttribute('data-overflow-action'))
    .map(el => el.getBoundingClientRect().width).filter(Boolean);
  const navigationAndMode = [...header.children].filter(el => el !== actions && !el.classList.contains('header-spacer'))
    .flatMap(el => el.classList.contains('header-navigation--contents') ? [...el.children] : [el])
    .map(el => el.getBoundingClientRect().width).filter(Boolean);
  // The 44px reservation includes the flex spacing on both sides of the spacer.
  const fixed = [...fixedActions, ...navigationAndMode].reduce((total, width) => total + width, 0)
    + Math.max(0, fixedActions.length - 1) * actionGap
    + Math.max(0, navigationAndMode.length - 1) * pixels(style.columnGap);
  return fitHeaderActions(room, fixed, Object.fromEntries(eligible.map(action => [action, HEADER_ICON_SLOT + actionGap])));
}
