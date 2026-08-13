// REQ-AGENT-134: advanced sessions receive one design entry point plus its
// licensed specialists through the canonical multi-agent preseed pipeline.
import { describe, expect, it } from 'vitest';
import { AGENTS_SEEDED_CONFIGS } from '../../lib/agent-seed.generated';

const SKILLS = ['design', 'ui-ux-pro-max', 'canvas-design', 'frontend-design'];
const TARGET_PREFIXES = [
  '.claude/skills',
  '.codex/skills',
  '.gemini/skills',
  '.config/opencode/skills',
  '.pi/agent/skills',
];

const docsFor = (suffix: string) => AGENTS_SEEDED_CONFIGS.filter((doc) => doc.key.endsWith(suffix));

describe('REQ-AGENT-134: advanced design skill suite', () => {
  it('REQ-AGENT-134: delivers the master router and three specialists to every skill-capable agent', () => {
    for (const prefix of TARGET_PREFIXES) {
      for (const skill of SKILLS) {
        const key = `${prefix}/${skill}/SKILL.md`;
        const document = AGENTS_SEEDED_CONFIGS.find((candidate) => candidate.key === key);
        expect(document, `${key} must be generated`).toBeDefined();
        expect(document!.modes).toEqual(['advanced']);
      }
    }
  });

  it('REQ-AGENT-134: ships upstream licenses and marks the adapted Canvas file', () => {
    const uiLicense = docsFor('/skills/ui-ux-pro-max/LICENSE');
    expect(uiLicense).toHaveLength(TARGET_PREFIXES.length);
    expect(uiLicense.every((document) => document.content.includes('MIT License'))).toBe(true);
    expect(uiLicense.every((document) => document.modes.length === 1 && document.modes[0] === 'advanced')).toBe(true);

    const canvasLicense = docsFor('/skills/canvas-design/LICENSE.txt');
    expect(canvasLicense).toHaveLength(TARGET_PREFIXES.length);
    expect(canvasLicense.every((document) => document.content.includes('Apache License'))).toBe(true);
    expect(canvasLicense.every((document) => document.modes.length === 1 && document.modes[0] === 'advanced')).toBe(true);

    const canvas = AGENTS_SEEDED_CONFIGS.find((document) => document.key === '.claude/skills/canvas-design/SKILL.md');
    expect(canvas?.content).toContain('Modified by Codeflare');
  });

  it('REQ-AGENT-134: preserves pinned provenance values and omits a Copilot skill lane', () => {
    const uiOrigin = docsFor('/skills/ui-ux-pro-max/ORIGIN.md');
    expect(uiOrigin).toHaveLength(TARGET_PREFIXES.length);
    expect(uiOrigin.every((document) => document.content.includes('97eb2a20032f0833e3d317162208a60385b0f96e'))).toBe(true);

    const canvasOrigin = docsFor('/skills/canvas-design/ORIGIN.md');
    expect(canvasOrigin).toHaveLength(TARGET_PREFIXES.length);
    expect(canvasOrigin.every((document) => document.content.includes('f17010c9bb483898c1d9c9f42dde2b3a98889434'))).toBe(true);

    expect(AGENTS_SEEDED_CONFIGS.some((document) => document.key.startsWith('.copilot/skills/'))).toBe(false);
  });

  it('REQ-AGENT-134: rewrites UI UX Pro Max search paths for each generated runtime', () => {
    const expectedPaths = new Map([
      ['.claude/skills/ui-ux-pro-max/SKILL.md', '~/.claude/skills/ui-ux-pro-max/scripts/search.py'],
      ['.codex/skills/ui-ux-pro-max/SKILL.md', '~/.codex/skills/ui-ux-pro-max/scripts/search.py'],
      ['.gemini/skills/ui-ux-pro-max/SKILL.md', '~/.gemini/skills/ui-ux-pro-max/scripts/search.py'],
      ['.config/opencode/skills/ui-ux-pro-max/SKILL.md', '~/.config/opencode/skills/ui-ux-pro-max/scripts/search.py'],
      ['.pi/agent/skills/ui-ux-pro-max/SKILL.md', '~/.pi/agent/skills/ui-ux-pro-max/scripts/search.py'],
    ]);
    for (const [key, path] of expectedPaths) {
      const document = AGENTS_SEEDED_CONFIGS.find((candidate) => candidate.key === key);
      expect(document?.content, `${key} must use its runtime-local search script`).toContain(path);
    }
  });

});
