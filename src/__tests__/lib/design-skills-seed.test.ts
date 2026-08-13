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

  it('REQ-AGENT-134: keeps the master as routing policy instead of duplicating specialist bodies', () => {
    const master = AGENTS_SEEDED_CONFIGS.find((doc) => doc.key === '.claude/skills/design/SKILL.md');
    expect(master).toBeDefined();
    expect(master!.content).toContain('ui-ux-pro-max');
    expect(master!.content).toContain('canvas-design');
    expect(master!.content).toContain('frontend-design');
    expect(master!.content).toContain('impeccable');
    expect(master!.content).toContain('design-taste-frontend');
    expect(master!.content).toContain('frontend-components');
    expect(master!.content).toContain('frontend-patterns');
    expect(master!.content).toContain('emil-design-eng');
    expect(master!.content).toContain('Use the design skill to redesign this dashboard.');
    expect(master!.content.length).toBeLessThan(6000);
  });

  it('REQ-AGENT-134: ships upstream licenses and marks the adapted Canvas file', () => {
    const uiLicense = docsFor('/skills/ui-ux-pro-max/LICENSE');
    expect(uiLicense).toHaveLength(TARGET_PREFIXES.length);
    expect(uiLicense.every((doc) => doc.content.includes('MIT License'))).toBe(true);
    expect(uiLicense.every((doc) => doc.modes.length === 1 && doc.modes[0] === 'advanced')).toBe(true);

    const canvasLicense = docsFor('/skills/canvas-design/LICENSE.txt');
    expect(canvasLicense).toHaveLength(TARGET_PREFIXES.length);
    expect(canvasLicense.every((doc) => doc.content.includes('Apache License'))).toBe(true);
    expect(canvasLicense.every((doc) => doc.modes.length === 1 && doc.modes[0] === 'advanced')).toBe(true);

    const canvas = AGENTS_SEEDED_CONFIGS.find((doc) => doc.key === '.claude/skills/canvas-design/SKILL.md');
    expect(canvas?.content).toContain('Modified by Codeflare');
  });

  it('REQ-AGENT-134: uses an independently authored Codeflare frontend skill', () => {
    const frontend = AGENTS_SEEDED_CONFIGS.find((doc) => doc.key === '.claude/skills/frontend-design/SKILL.md');
    expect(frontend).toBeDefined();
    expect(frontend!.content).toContain('Codeflare-owned');
    expect(frontend!.content).not.toContain('Complete terms in LICENSE.txt');
  });

  it('retains pinned provenance and emits no unsupported Copilot skill lane', () => {
    const uiOrigin = docsFor('/skills/ui-ux-pro-max/ORIGIN.md');
    expect(uiOrigin).toHaveLength(TARGET_PREFIXES.length);
    expect(uiOrigin.every((doc) => doc.content.includes('97eb2a20032f0833e3d317162208a60385b0f96e'))).toBe(true);

    const canvasOrigin = docsFor('/skills/canvas-design/ORIGIN.md');
    expect(canvasOrigin).toHaveLength(TARGET_PREFIXES.length);
    expect(canvasOrigin.every((doc) => doc.content.includes('f17010c9bb483898c1d9c9f42dde2b3a98889434'))).toBe(true);

    expect(AGENTS_SEEDED_CONFIGS.some((doc) => doc.key.startsWith('.copilot/skills/'))).toBe(false);
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
