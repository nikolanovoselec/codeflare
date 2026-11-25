import { describe, expect, it } from 'vitest';
import { fitHeaderActions } from '../../lib/header-fit';

// The fixed width includes the two navigation slots, the mode and utility
// slots, and all spacing except the group gap and the removable actions.
const fixed = 6 * 44 + 4 * 8 + 32;
const actions = { vscode: 52, operators: 52, vault: 52 };

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
