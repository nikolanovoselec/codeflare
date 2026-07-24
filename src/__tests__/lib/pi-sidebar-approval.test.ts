import { describe, expect, it } from 'vitest';

import sidebarApproval from '../../../preseed/agents/pi/extensions/sidebar-approval';

describe('REQ-IDE-007: unrestricted Pi sidebar tools', () => {
  it('REQ-IDE-007 AC1: sidebar Pi leaves built-in tools unrestricted', () => {
    let registrations = 0;
    const pi = {
      registerTool: () => { registrations += 1; },
      on: () => { registrations += 1; },
    };

    sidebarApproval(pi as unknown as Parameters<typeof sidebarApproval>[0]);

    expect(registrations).toBe(0);
  });
});
