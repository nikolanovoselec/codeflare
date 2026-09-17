import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

/** REQ-OPERATOR-009: Phase 1 must not tune the canonical local review packet builder. */
describe('REQ-OPERATOR-009: unchanged canonical local-review resource', () => {
  it('retains the inspected canonical packet builder bytes', async () => {
    const bytes = await readFile(new URL('../../../preseed/agents/claude/skills/review-scope/scripts/build-review-packet.mjs', import.meta.url));
    expect(createHash('sha256').update(bytes).digest('hex'))
      .toBe('110adda054e4e7569b3043cdffee030bef20a8dbc1136ff777dd35300ffcc80d');
  });
});
