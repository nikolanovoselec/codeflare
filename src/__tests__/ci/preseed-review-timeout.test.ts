import { describe, expect, it } from 'vitest';
import { AGENTS_SEEDED_CONFIGS } from '../../lib/agent-seed.generated';

const piReviewHelpers = AGENTS_SEEDED_CONFIGS.find(
  ({ key }) => key === '.pi/agent/extensions/review-helpers.ts',
)?.content;
const piCiMonitor = AGENTS_SEEDED_CONFIGS.find(
  ({ key }) => key === '.pi/agent/agents/ci-monitor.md',
)?.content;

describe('preseed review timeout follow-up', () => {
  it('ships native CI-monitor timeout recognition in the Worker seed', () => {
    expect(piReviewHelpers).toContain('Command timed out after');
    expect(piReviewHelpers).toContain('?? "timeout"');
    expect(piCiMonitor).toContain('timeout: 1800');
  });
});
