import { describe, expect, it } from 'vitest';

import { AGENTS_SEEDED_CONFIGS } from '../../lib/agent-seed.generated';

const PI_RULE_SKILLS = [
  'codeflare-cloudflare-workers',
  'codeflare-go',
  'codeflare-python',
  'codeflare-swift',
  'codeflare-typescript',
] as const;

const COVERED_RULES = new Map([
  ['documentation-discipline', 'doc-enforce'],
  ['frontend-components', 'frontend-components'],
  ['spec-discipline', 'spec-driven-development'],
  ['tdd-discipline', 'tdd-enforce'],
  ['vault-note-capture', 'vault-note-capture'],
]);

const HIDDEN_INTERNAL_SKILLS = [
  'doc-enforce',
  'doc-enforce-lanes',
  'doc-enforce-shape',
  'doc-enforce-truth',
  'git-review-pipeline',
  'review',
  'review-scope',
  'sdd-clean',
  'sdd-init',
  'spec-driven-development',
  'spec-enforce',
  'spec-enforce-ac',
  'spec-enforce-truth',
  'tdd-enforce',
] as const;

const PROACTIVE_SKILLS = [
  'browser-run',
  'cloudflare',
  'cloudflare-stack',
  'frontend-components',
  'graphify',
  'impeccable',
  'pr-workflow',
  'search-first',
  'ship',
  'vault-note-capture',
] as const;

function docs(key: string, mode: 'default' | 'advanced') {
  return AGENTS_SEEDED_CONFIGS.filter((doc) => doc.key === key && doc.modes.includes(mode));
}

function frontmatter(content: string): Record<string, string> {
  return Object.fromEntries(
    (content.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '')
      .split('\n')
      .map((line) => {
        const separator = line.indexOf(':');
        return separator < 0 ? [] : [line.slice(0, separator), line.slice(separator + 1).trim()];
      })
      .filter((parts) => parts.length === 2),
  );
}

function skillDescription(content: string): string {
  const raw = frontmatter(content).description ?? '';
  if (!raw.startsWith('"')) return raw;
  return JSON.parse(raw) as string;
}

function skillDoc(name: string, mode: 'default' | 'advanced' = 'advanced') {
  return docs(`.pi/agent/skills/${name}/SKILL.md`, mode)[0];
}

function visibleSkillCatalogChars(mode: 'default' | 'advanced'): number {
  return AGENTS_SEEDED_CONFIGS
    .filter((doc) => doc.key.startsWith('.pi/agent/skills/') && doc.key.endsWith('/SKILL.md') && doc.modes.includes(mode))
    .filter((doc) => frontmatter(doc.content)['disable-model-invocation'] !== 'true')
    .reduce((total, doc) => {
      const metadata = frontmatter(doc.content);
      const entry = [
        '<skill>',
        `<name>${metadata.name ?? ''}</name>`,
        `<description>${metadata.description ?? ''}</description>`,
        `<location>~/${doc.key}</location>`,
        '</skill>',
      ].join('\n');
      return total + entry.length;
    }, 0);
}

describe('REQ-AGENT-007/REQ-AGENT-095: compact Pi context generated from the Claude canon', () => {
  it('emits one grouped Pi skill for each path-scoped canonical rule family', () => {
    for (const name of PI_RULE_SKILLS) {
      const entries = docs(`.pi/agent/skills/${name}/SKILL.md`, 'advanced');
      expect(entries).toHaveLength(1);
      expect(frontmatter(entries[0]!.content).name).toBe(name);
    }
  });

  it('keeps every canonical path-rule body in its one grouped Pi skill', () => {
    const canonicalRules = AGENTS_SEEDED_CONFIGS.filter(
      (doc) => doc.key.startsWith('.claude/rules/') && doc.key.endsWith('.md') && /^---\n[\s\S]*?^paths:/m.test(doc.content),
    );
    const groupForRule = (key: string): string => {
      if (key.endsWith('/cloudflare-workers.md')) return 'codeflare-cloudflare-workers';
      const family = key.match(/\.claude\/rules\/(golang|python|swift|typescript)\//)?.[1];
      return `codeflare-${family === 'golang' ? 'go' : family}`;
    };

    for (const rule of canonicalRules) {
      const canonicalBody = rule.content
        .replace(/^---\n[\s\S]*?\n---\n/, '')
        .trim()
        .replaceAll('~/.claude/', '~/.pi/agent/');
      const generatedBody = skillDoc(groupForRule(rule.key))!.content;
      expect(generatedBody.split(canonicalBody), rule.key).toHaveLength(2);
    }
  });

  it('uses one existing canonical skill instead of generating duplicate covered rules', () => {
    for (const [ruleName, ownerSkill] of COVERED_RULES) {
      expect(skillDoc(ownerSkill)).toBeTruthy();
      expect(skillDoc(`codeflare-${ruleName}`)).toBeUndefined();
    }
  });

  it('hides command/event/reviewer internals while keeping proactive skills visible', () => {
    for (const name of HIDDEN_INTERNAL_SKILLS) {
      const doc = skillDoc(name);
      expect(doc, `${name} should be seeded`).toBeTruthy();
      expect(frontmatter(doc!.content)['disable-model-invocation']).toBe('true');
    }
    for (const name of PROACTIVE_SKILLS) {
      const doc = skillDoc(name);
      expect(doc, `${name} should be seeded`).toBeTruthy();
      expect(frontmatter(doc!.content)['disable-model-invocation']).not.toBe('true');
    }
  });

  it('keeps model-visible Pi descriptions within the compact catalog budget', () => {
    const visibleSkills = AGENTS_SEEDED_CONFIGS.filter(
      (doc) => doc.key.startsWith('.pi/agent/skills/')
        && doc.key.endsWith('/SKILL.md')
        && doc.modes.includes('advanced')
        && frontmatter(doc.content)['disable-model-invocation'] !== 'true',
    );

    for (const doc of visibleSkills) {
      const name = frontmatter(doc.content).name;
      if (name === 'pi-mcp-adapter') continue;
      expect(skillDescription(doc.content).length, `${name} description length`).toBeLessThanOrEqual(80);
    }
  });

  it('keeps Codeflare-controlled Pi startup text below the normal-turn seed budget', () => {
    for (const mode of ['default', 'advanced'] as const) {
      const instructions = docs('.pi/agent/AGENTS.md', mode);
      expect(instructions).toHaveLength(1);
      const managedChars = instructions[0]!.content.length + visibleSkillCatalogChars(mode);
      expect(Math.ceil(managedChars / 4), `${mode} managed seed text tokens`).toBeLessThan(6_500);
    }
  });
});
