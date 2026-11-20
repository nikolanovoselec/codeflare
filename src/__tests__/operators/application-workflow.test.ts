import { describe, expect, it } from 'vitest';
import { parseApplicationDecision } from '../../operators/application-workflow';

// REQ-OPERATOR-048: opaque decisions use admitted runtime capacity, not a
// smaller application-specific checkpoint/context allowance.
describe('application workflow decision capacity', () => {
  const document = 'original application data '.repeat(4000);
  const decision = { kind: 'dispatch', checkpoint: { document },
    message: { kind: 'user', body: 'Continue the original work' }, context: { document } };

  it('retains complete opaque checkpoint and context above the former fixed allowance', () => {
    expect(parseApplicationDecision(decision, 256 * 1024)).toEqual(decision);
  });

  it('rejects a decision that exceeds its actual admitted capacity', () => {
    expect(() => parseApplicationDecision(decision, 32 * 1024)).toThrow('Application decision exceeds admitted capacity');
  });

  it('does not convert invalid JSON or unknown decision fields into accepted work', () => {
    expect(() => parseApplicationDecision({ ...decision, checkpoint: { invalid: NaN } }, 256 * 1024)).toThrow();
    expect(() => parseApplicationDecision({ ...decision, grant: 'caller-selected' }, 256 * 1024)).toThrow();
  });
});
