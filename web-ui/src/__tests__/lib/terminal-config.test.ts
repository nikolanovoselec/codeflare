import { describe, it, expect } from 'vitest';
import { mdiCodeBraces, mdiConsole, mdiGithub, mdiPi, mdiRobotIndustrial, mdiRobotOutline, mdiRocketLaunchOutline, mdiViewCompactOutline } from '@mdi/js';
import { AGENT_ICON_MAP, MULTIVIEW_ICON } from '../../lib/terminal-config';

describe('terminal-config session identity', () => {
  it('keeps configured session agent icons without outer process-label helpers', () => {
    expect(AGENT_ICON_MAP).toEqual({
      'claude-code': mdiRobotOutline,
      codex: mdiCodeBraces,
      antigravity: mdiRocketLaunchOutline,
      opencode: mdiRobotIndustrial,
      copilot: mdiGithub,
      pi: mdiPi,
      bash: mdiConsole,
    });
  });

  it('keeps the MultiView icon', () => {
    expect(MULTIVIEW_ICON).toBe(mdiViewCompactOutline);
  });
});
