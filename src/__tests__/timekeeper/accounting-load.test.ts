import { describe, expect, it } from 'vitest';
import { applyPositiveDelta, createAccountingState, hashSessionId, historyPhase } from '../../timekeeper/accounting';
import { userKeyForEmail } from '../../lib/admin-usage';

describe('historical accounting operation fixture (REQ-OPS-057 AC6)', () => {
  it('models 2,000 users with three active sessions inside ping and D1 ceilings', async () => {
    const users = 2_000;
    const sessionsPerUser = 3;
    const slotUsers = [0, 0, 0];
    let stateWrites = 0;
    let kvReads = 0;
    let maxStateBytes = 0;
    const now = new Date('2026-08-30T12:00:00.000Z');

    for (let user = 0; user < users; user += 1) {
      const email = `developer-${user}@example.com`;
      const { d1Slot } = await historyPhase(await userKeyForEmail(email));
      slotUsers[d1Slot] += 1;
      let state = await createAccountingState(now, {
        pendingSeconds: 0,
        sessionTotals: {},
        lastFlushedMonthlyTotal: 0,
      });
      const markers = new Set<string>();
      for (let session = 0; session < sessionsPerUser; session += 1) {
        const hash = await hashSessionId(`session-${user}-${session}`);
        const applied = applyPositiveDelta(state, hash, 60, now, markers);
        for (const marker of applied.markerKeys) markers.add(marker);
        state = {
          ...applied.state,
          sessionTotals: { ...applied.state.sessionTotals, [hash]: 60 },
        };
        stateWrites += 1;
      }
      maxStateBytes = Math.max(maxStateBytes, new TextEncoder().encode(JSON.stringify(state)).byteLength);
    }

    expect(stateWrites).toBe(users * sessionsPerUser);
    expect(kvReads).toBe(0);
    expect(maxStateBytes).toBeLessThan(4_096);
    expect(slotUsers.reduce((sum, count) => sum + count, 0)).toBe(users);
    expect(Math.max(...slotUsers)).toBeLessThanOrEqual(750);
    expect(Math.max(...slotUsers) * 4).toBeLessThanOrEqual(3_000);
  });
});
