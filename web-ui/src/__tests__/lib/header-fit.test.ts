import { describe, expect, it, vi } from 'vitest';
import { fitHeaderActions, measureProfileMenu } from '../../lib/header-fit';

// The fixed width includes the two navigation slots, the mode and utility
// slots, and all spacing except the group gap and the removable actions.
const fixed = 6 * 44 + 4 * 8 + 32;
const actions = { vscode: 52, operators: 52, vault: 52 };

it.each([
  [900, 460, false],
  [900, 459, true],
  [900, 412, true],
  [390, 800, true],
  [640.5, 460, false],
  [640.5, 459, true],
] as const)('chooses Profile placement at viewport %s × %s', (width, height, sheet) => {
  const anchor = document.createElement('button');
  anchor.getBoundingClientRect = () => new DOMRect(160, 356, 44, 44);
  const innerWidth = Math.floor(width);
  vi.stubGlobal('innerWidth', innerWidth);
  vi.stubGlobal('innerHeight', height);
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(max-width: 640px)' && width <= 640 }));
  try {
    expect(measureProfileMenu(anchor)).toEqual({ top: 408, right: innerWidth - 204, sheet });
  } finally {
    vi.unstubAllGlobals();
  }
});

describe('workspace header fit', () => {
  it.each([
    [528, [], true],
    [527, ['vscode'], true],
    [475, ['vscode', 'operators'], true],
    [423, ['vscode', 'operators', 'vault'], true],
    [372, ['vscode', 'operators', 'vault'], true],
    [371, ['vscode', 'operators', 'vault'], false],
  ] as const)('keeps the one-slot group gap at width %s when it fits', (width, overflow, fits) => {
    expect(fitHeaderActions(width, fixed, actions)).toEqual({ overflow, fits });
  });

  it('never adds an ineligible action to the overflow list', () => {
    expect(fitHeaderActions(372, fixed, { vault: 52 })).toEqual({ overflow: ['vault'], fits: true });
  });
});
