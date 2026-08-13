// REQ-AGENT-134: advanced sessions receive one design entry point plus its
// licensed specialists through the canonical multi-agent preseed pipeline.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
const skillScripts = resolve('preseed/agents/claude/skills/ui-ux-pro-max/scripts');
const temporaryDirectories: string[] = [];

function runPython(args: string[]) {
  return spawnSync('python3', args, { encoding: 'utf8', timeout: 15_000 });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

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

  it('REQ-AGENT-134: executes search, design generation, bounded persistence, and data validation', () => {
    const search = runPython([join(skillScripts, 'search.py'), 'saas software', '--domain', 'product', '--json']);
    expect(search.status, search.stderr).toBe(0);
    const searchResult = JSON.parse(search.stdout);
    expect(searchResult.domain).toBe('product');
    expect(searchResult.count).toBeGreaterThan(0);
    expect(searchResult.results.some((result: Record<string, string>) => result['Product Type'] === 'SaaS (General)')).toBe(true);

    const outputRoot = mkdtempSync(join(tmpdir(), 'design-skill-'));
    temporaryDirectories.push(outputRoot);
    const designArgs = [
      join(skillScripts, 'search.py'), 'saas analytics dashboard', '--design-system', '--json',
      '--project-name', '../../Customer Portal', '--persist', '--page', '../overview', '--output-dir', outputRoot,
    ];
    const generated = runPython(designArgs);
    expect(generated.status, generated.stderr).toBe(0);
    const generatedResult = JSON.parse(generated.stdout);
    expect(generatedResult.design_system.pattern).toBeDefined();
    expect(generatedResult.persistence.status).toBe('success');
    const master = join(outputRoot, 'design-system', 'customer-portal', 'MASTER.md');
    const page = join(outputRoot, 'design-system', 'customer-portal', 'pages', 'overview.md');
    expect(readFileSync(master, 'utf8').length).toBeGreaterThan(0);
    expect(readFileSync(page, 'utf8').length).toBeGreaterThan(0);

    writeFileSync(master, 'preserve prior decisions\n');
    const repeated = runPython(designArgs);
    expect(repeated.status, repeated.stderr).toBe(0);
    expect(JSON.parse(repeated.stdout).persistence.status).toBe('skipped_exists');
    expect(readFileSync(master, 'utf8')).toBe('preserve prior decisions\n');

    const invalidCsv = join(outputRoot, 'invalid.csv');
    writeFileSync(invalidCsv, 'No,Decision_Rules\n1,{bad json}\n1,{}\n');
    const validation = runPython([
      '-c',
      'import json,sys; from pathlib import Path; sys.path.insert(0,sys.argv[1]); from validate_data import _check_file; p=[]; _check_file("fixture",Path(sys.argv[2]),["No"],["No","Decision_Rules"],p); print(json.dumps(p))',
      skillScripts,
      invalidCsv,
    ]);
    expect(validation.status, validation.stderr).toBe(0);
    const problems = JSON.parse(validation.stdout);
    expect(problems.some((problem: string) => problem.includes("duplicate 'No' value"))).toBe(true);
    expect(problems.some((problem: string) => problem.includes('is not valid JSON'))).toBe(true);
  });
});
