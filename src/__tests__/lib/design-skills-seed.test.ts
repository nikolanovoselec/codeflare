// REQ-AGENT-134: advanced sessions receive one design entry point plus its
// specialists through the canonical multi-agent preseed pipeline.
import { describe, expect, it } from 'vitest';
import { AGENTS_SEEDED_CONFIGS } from '../../lib/agent-seed.generated';

const SKILLS = ['design', 'ui-ux-pro-max', 'canvas-design', 'frontend-design', 'native-mobile-design'];
const FRONTEND_DESIGN_REFERENCES = [
  'art-direction.md',
  'new-work.md',
  'redesign.md',
  'assets-and-motion.md',
  'visual-qa.md',
  'astro-cloudflare.md',
  'operate-and-dashboards.md',
  'component-systems.md',
  'complex-motion.md',
];
const DESIGN_REFERENCES = ['external-dependencies.md'];
const NATIVE_MOBILE_REFERENCES = ['platform-behavior.md'];
const TARGET_PREFIXES = [
  '.claude/skills',
  '.codex/skills',
  '.gemini/skills',
  '.config/opencode/skills',
  '.pi/agent/skills',
];

const docsFor = (suffix: string) => AGENTS_SEEDED_CONFIGS.filter((doc) => doc.key.endsWith(suffix));

describe('REQ-AGENT-134: advanced design skill suite', () => {
  it('REQ-AGENT-134: delivers the master router and four specialists to every skill-capable agent', () => {
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

    const canvasLicense = docsFor('/skills/_licenses/anthropic-skills-Apache-2.0.txt');
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

  // These assertions cover emitted seed contracts; manual REQ evidence owns model routing behavior.
  it('REQ-AGENT-179: projects one bounded advanced Pi visual-routing entry', () => {
    const rule = AGENTS_SEEDED_CONFIGS.find(
      (document) => document.key === '.pi/agent/rules/design-routing.md',
    );
    expect(rule?.modes).toEqual(['advanced']);
    expect(rule?.content.trim().split(/\s+/).length).toBeLessThanOrEqual(35);
    expect(rule?.content).toContain('[design](../skills/design/SKILL.md)');

    const advancedInstructions = AGENTS_SEEDED_CONFIGS.find(
      (document) => document.key === '.pi/agent/AGENTS.md' && document.modes.includes('advanced'),
    );
    expect(advancedInstructions?.content).toContain('[design](skills/design/SKILL.md)');
  });

  it('REQ-AGENT-180: projects one portable frontend design authority and its focused references', () => {
    const canonical = AGENTS_SEEDED_CONFIGS.find(
      (document) => document.key === '.claude/skills/frontend-design/SKILL.md',
    );
    expect(canonical).toBeDefined();

    const body = (content: string | undefined) => content?.replace(/^---\n[\s\S]*?\n---\n/, '');
    for (const prefix of TARGET_PREFIXES) {
      const skill = AGENTS_SEEDED_CONFIGS.find(
        (document) => document.key === `${prefix}/frontend-design/SKILL.md`,
      );
      expect(body(skill?.content)).toBe(body(canonical?.content));
      for (const reference of FRONTEND_DESIGN_REFERENCES) {
        const key = `${prefix}/frontend-design/references/${reference}`;
        expect(AGENTS_SEEDED_CONFIGS.find((document) => document.key === key), `${key} must be generated`).toBeDefined();
      }
    }
  });

  it('REQ-AGENT-182: projects native-mobile authority and progressive cross-cutting references', () => {
    const canonical = AGENTS_SEEDED_CONFIGS.find(
      (document) => document.key === '.claude/skills/native-mobile-design/SKILL.md',
    );
    expect(canonical).toBeDefined();

    const body = (content: string | undefined) => content?.replace(/^---\n[\s\S]*?\n---\n/, '');
    for (const prefix of TARGET_PREFIXES) {
      const skill = AGENTS_SEEDED_CONFIGS.find(
        (document) => document.key === `${prefix}/native-mobile-design/SKILL.md`,
      );
      expect(body(skill?.content)).toBe(body(canonical?.content));
      for (const reference of NATIVE_MOBILE_REFERENCES) {
        const key = `${prefix}/native-mobile-design/references/${reference}`;
        expect(AGENTS_SEEDED_CONFIGS.find((document) => document.key === key), `${key} must be generated`).toBeDefined();
      }
      for (const reference of DESIGN_REFERENCES) {
        const key = `${prefix}/design/references/${reference}`;
        expect(AGENTS_SEEDED_CONFIGS.find((document) => document.key === key), `${key} must be generated`).toBeDefined();
      }
    }
  });

  it('REQ-AGENT-180/182: keeps portable design guidance free of runtime-specific assumptions', () => {
    const portableKeys = [
      '/skills/design/SKILL.md',
      ...DESIGN_REFERENCES.map((reference) => `/skills/design/references/${reference}`),
      '/skills/design-taste-frontend/SKILL.md',
      '/skills/frontend-design/SKILL.md',
      ...FRONTEND_DESIGN_REFERENCES.map((reference) => `/skills/frontend-design/references/${reference}`),
      '/skills/native-mobile-design/SKILL.md',
      ...NATIVE_MOBILE_REFERENCES.map((reference) => `/skills/native-mobile-design/references/${reference}`),
    ];
    const forbidden = /AGENTS\.md|Claude Code|ChatGPT|\bCodex\b|~\/\.claude|~\/\.codex|\$skill-creator/;

    for (const suffix of portableKeys) {
      const documents = docsFor(suffix);
      expect(documents.length, `${suffix} must be projected`).toBe(TARGET_PREFIXES.length);
      for (const document of documents) {
        expect(document.content, `${document.key} must stay runtime-neutral`).not.toMatch(forbidden);
      }
    }
  });

  it('REQ-AGENT-181: projects a compact compatibility entry that targets frontend-design', () => {
    for (const prefix of TARGET_PREFIXES) {
      const document = AGENTS_SEEDED_CONFIGS.find(
        (candidate) => candidate.key === `${prefix}/design-taste-frontend/SKILL.md`,
      );
      expect(document).toBeDefined();
      expect(document!.content).toContain('frontend-design');
      expect(document!.content.length).toBeLessThan(3_000);
    }
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
