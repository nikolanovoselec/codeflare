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

const REPRESENTATIVE_SKILLS = [
  'cloudflare',
  'frontend-patterns',
  'impeccable',
  'safe-local-checks',
  'ship',
] as const;

const ALIGNED_CURATED_SKILLS = new Map([
  ['systematic-debugging', { modes: ['default', 'advanced'], indexed: true }],
  ['skill-authoring', { modes: ['advanced'], indexed: false }],
] as const);

const EXPLICIT_ONLY_SKILLS = new Set([
  'advisor',
  'code-review-checklist',
  'consult-llm',
  'doc-enforce',
  'doc-enforce-lanes',
  'doc-enforce-shape',
  'doc-enforce-truth',
  'git-review-pipeline',
  'review',
  'review-scope',
  'rpiv-ask-user-question',
  'rpiv-todo',
  'sandbox-migrate-to-next',
  'sdd-clean',
  'sdd-init',
  'skill-authoring',
  'spec-driven-development',
  'spec-enforce',
  'spec-enforce-ac',
  'spec-enforce-truth',
  'tdd-enforce',
]);

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

function compactPurpose(description: string): string {
  if (description.length <= 32) return description;
  const prefix = description.slice(0, 29).replace(/\s+\S*$/, '').trimEnd();
  return `${prefix}…`;
}

function skillDoc(name: string, mode: 'default' | 'advanced' = 'advanced') {
  return docs(`.pi/agent/skills/${name}/SKILL.md`, mode)[0];
}

function skillDocuments(mode: 'default' | 'advanced') {
  return AGENTS_SEEDED_CONFIGS.filter(
    (doc) => doc.key.startsWith('.pi/agent/skills/')
      && doc.key.endsWith('/SKILL.md')
      && doc.modes.includes(mode),
  );
}

function indexedSkills(mode: 'default' | 'advanced') {
  const instructions = docs('.pi/agent/AGENTS.md', mode);
  expect(instructions).toHaveLength(1);
  const section = instructions[0]!.content.match(
    /<!-- pi-skill-index:start -->\n([\s\S]*?)\n<!-- pi-skill-index:end -->/,
  )?.[1];
  expect(section, `${mode} compact skill index`).toBeTruthy();
  return [...section!.matchAll(/^- `([a-z0-9-]+)` — (.+)$/gm)].map((match) => ({
    name: match[1]!,
    purpose: match[2]!,
  }));
}

function visibleSkillCatalogChars(mode: 'default' | 'advanced'): number {
  return skillDocuments(mode)
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

  it('indexes every model-invocable seed skill exactly once per mode without removing its file', () => {
    for (const mode of ['default', 'advanced'] as const) {
      const skillDocs = skillDocuments(mode);
      const installedNames = skillDocs.map((doc) => frontmatter(doc.content).name).sort();
      const expectedIndexNames = installedNames.filter((name) => !EXPLICIT_ONLY_SKILLS.has(name));
      const index = indexedSkills(mode);
      const indexNames = index.map(({ name }) => name);

      expect(new Set(installedNames).size).toBe(installedNames.length);
      expect(indexNames).toEqual(expectedIndexNames);
      expect(new Set(indexNames).size).toBe(indexNames.length);
      for (const { name, purpose } of index) {
        expect(skillDoc(name, mode), `${name} conventional path`).toBeTruthy();
        expect(purpose.length, `${name} compact purpose`).toBeGreaterThan(0);
        expect(purpose.length, `${name} compact purpose`).toBeLessThanOrEqual(32);
      }
    }
  });

  it('retains the reviewed curated skill additions in their intended modes', () => {
    for (const [name, expectation] of ALIGNED_CURATED_SKILLS) {
      const documents = AGENTS_SEEDED_CONFIGS.filter(
        (doc) => doc.key === `.pi/agent/skills/${name}/SKILL.md`,
      );
      expect(documents).toHaveLength(1);
      expect(documents[0]?.modes).toEqual(expectation.modes);
      for (const mode of expectation.modes) {
        expect(indexedSkills(mode).some((entry) => entry.name === name)).toBe(expectation.indexed);
      }
    }
  });

  it('keeps indexed skills explicitly invocable while omitting duplicate native XML entries', () => {
    for (const mode of ['default', 'advanced'] as const) {
      for (const doc of skillDocuments(mode)) {
        expect(frontmatter(doc.content)['disable-model-invocation'], doc.key).toBe('true');
      }
      const names = new Set(indexedSkills(mode).map(({ name }) => name));
      for (const name of REPRESENTATIVE_SKILLS) {
        if (skillDoc(name, mode)) expect(names.has(name), `${mode} index contains ${name}`).toBe(true);
      }
    }
  });

  it('derives every compact index purpose from installed skill metadata', () => {
    for (const mode of ['default', 'advanced'] as const) {
      for (const { name, purpose } of indexedSkills(mode)) {
        const document = skillDoc(name, mode)!;
        expect(purpose, document.key).toBe(compactPurpose(skillDescription(document.content)));
      }
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
