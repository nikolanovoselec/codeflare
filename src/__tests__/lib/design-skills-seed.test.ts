// REQ-AGENT-134: advanced sessions receive one design entry point plus its
// licensed specialists through the canonical multi-agent preseed pipeline.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
const canonicalSkillsRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../preseed/agents/claude/skills',
);
const canonicalSkill = (relativePath: string) => readFileSync(join(canonicalSkillsRoot, relativePath), 'utf8');

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

  it('REQ-AGENT-134: preserves the canonical compact router artifact', () => {
    const canonical = canonicalSkill('design/SKILL.md');
    const routers = docsFor('/skills/design/SKILL.md');
    expect(routers).toHaveLength(TARGET_PREFIXES.length);
    expect(routers.every((document) => document.content === canonical)).toBe(true);
    expect(routers.every((document) => document.modes.length === 1 && document.modes[0] === 'advanced')).toBe(true);
    for (const specialist of [
      'ui-ux-pro-max',
      'canvas-design',
      'frontend-design',
      'impeccable',
      'design-taste-frontend',
      'frontend-components',
      'frontend-patterns',
      'emil-design-eng',
    ]) {
      expect(canonical).toContain(specialist);
    }
    expect(canonical.length).toBeLessThan(6000);
  });

  it('REQ-AGENT-134: ships upstream licenses and marks the adapted Canvas file', () => {
    const uiLicense = docsFor('/skills/ui-ux-pro-max/LICENSE');
    const canonicalUiLicense = canonicalSkill('ui-ux-pro-max/LICENSE');
    expect(uiLicense).toHaveLength(TARGET_PREFIXES.length);
    expect(uiLicense.every((document) => document.content === canonicalUiLicense)).toBe(true);
    expect(canonicalUiLicense).toContain('MIT License');
    expect(uiLicense.every((document) => document.modes.length === 1 && document.modes[0] === 'advanced')).toBe(true);

    const canvasLicense = docsFor('/skills/canvas-design/LICENSE.txt');
    const canonicalCanvasLicense = canonicalSkill('canvas-design/LICENSE.txt');
    expect(canvasLicense).toHaveLength(TARGET_PREFIXES.length);
    expect(canvasLicense.every((document) => document.content === canonicalCanvasLicense)).toBe(true);
    expect(canonicalCanvasLicense).toContain('Apache License');
    expect(canvasLicense.every((document) => document.modes.length === 1 && document.modes[0] === 'advanced')).toBe(true);

    const canvas = AGENTS_SEEDED_CONFIGS.find((document) => document.key === '.claude/skills/canvas-design/SKILL.md');
    const canonicalCanvas = canonicalSkill('canvas-design/SKILL.md');
    expect(canvas?.content).toBe(canonicalCanvas);
    expect(canonicalCanvas).toContain('Modified by Codeflare');
  });

  it('REQ-AGENT-134: preserves canonical provenance artifacts and omits a Copilot skill lane', () => {
    const uiOrigin = docsFor('/skills/ui-ux-pro-max/ORIGIN.md');
    const canonicalUiOrigin = canonicalSkill('ui-ux-pro-max/ORIGIN.md');
    expect(uiOrigin).toHaveLength(TARGET_PREFIXES.length);
    expect(uiOrigin.every((document) => document.content === canonicalUiOrigin)).toBe(true);
    expect(canonicalUiOrigin).toContain('97eb2a20032f0833e3d317162208a60385b0f96e');

    const canvasOrigin = docsFor('/skills/canvas-design/ORIGIN.md');
    const canonicalCanvasOrigin = canonicalSkill('canvas-design/ORIGIN.md');
    expect(canvasOrigin).toHaveLength(TARGET_PREFIXES.length);
    expect(canvasOrigin.every((document) => document.content === canonicalCanvasOrigin)).toBe(true);
    expect(canonicalCanvasOrigin).toContain('f17010c9bb483898c1d9c9f42dde2b3a98889434');

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
