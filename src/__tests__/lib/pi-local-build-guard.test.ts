import { describe, expect, it } from 'vitest';
import { localBuildBlockReason } from '../../../preseed/agents/pi/extensions/guard-helpers';

const noBypass = { existsSync: () => false, unlinkSync: () => {} };

describe('REQ-AGENT-052 AC4: Pi local-build guard classifies execution, not staged filenames', () => {
  it('allows staging a test configuration file without running it', () => {
    expect(localBuildBlockReason('git add vitest.node.config.ts sdd/spec/changes.md', noBypass)).toBeUndefined();
    expect(localBuildBlockReason('git -C /home/user/workspace/codeflare add vitest.node.config.ts sdd/spec/changes.md', noBypass))
      .toBeUndefined();
  });

  it('still blocks direct and nested test execution in staging commands', () => {
    for (const command of [
      'npx vitest --run', 'npm test',
      'git add vitest.node.config.ts && npx vitest --run',
      'git add "$(npx vitest --run)"',
    ]) expect(localBuildBlockReason(command, noBypass)).toMatch(/Direct local builds\/tests/);
  });
});
