// REQ-AGENT-075: the official Cloudflare skills (github.com/cloudflare/skills, Apache-2.0) are
// bundled into the ADVANCED-mode agent seed — all 11 skills + 2 commands + a path-scoped Workers
// rule — with the cloudflare mega-skill's references/ tree SLIMMED OUT (retrieval-first; agents
// fetch live docs via WebFetch). Behavioral: gut the bundling and these fail.
//
// No mocking — asserts against the real committed AGENTS_SEEDED_CONFIGS.
import { describe, it, expect } from 'vitest';
import { AGENTS_SEEDED_CONFIGS } from '../../lib/agent-seed.generated';

const CF_SKILLS = [
  'cloudflare', 'cloudflare-one', 'cloudflare-one-migrations', 'wrangler',
  'workers-best-practices', 'durable-objects', 'agents-sdk', 'sandbox-sdk',
  'turnstile-spin', 'cloudflare-email-service', 'web-perf',
];

const docFor = (key: string) => AGENTS_SEEDED_CONFIGS.find((d) => d.key === key);
const has = (key: string) => AGENTS_SEEDED_CONFIGS.some((d) => d.key === key);
const advancedOnly = (key: string) => {
  const docs = AGENTS_SEEDED_CONFIGS.filter((d) => d.key === key);
  return docs.length > 0 && docs.every((d) => d.modes.length === 1 && d.modes[0] === 'advanced');
};

describe('REQ-AGENT-075: Cloudflare platform skills bundled into the advanced seed', () => {
  it('all 11 Cloudflare skills are seeded to Claude and are advanced-only', () => {
    for (const s of CF_SKILLS) {
      const key = `.claude/skills/${s}/SKILL.md`;
      expect(has(key), `${key} must be bundled`).toBe(true);
      expect(advancedOnly(key), `${key} must be advanced-only (Pro)`).toBe(true);
    }
  });

  it('includes the cloudflare-one Zero Trust / SASE skill (enterprise Codeflare is Cloudflare One)', () => {
    const doc = docFor('.claude/skills/cloudflare-one/SKILL.md');
    expect(doc).toBeDefined();
    expect(doc!.content).toMatch(/Zero Trust|Access|Gateway|WARP/i);
  });

  it('SLIMS the cloudflare mega-skill: SKILL.md is kept, the references/ tree is NOT bundled', () => {
    expect(has('.claude/skills/cloudflare/SKILL.md'), 'mega-skill decision tree must remain').toBe(true);
    const refs = AGENTS_SEEDED_CONFIGS.filter((d) => d.key.startsWith('.claude/skills/cloudflare/references/'));
    expect(refs.length, 'the 319-file references/ tree must be slimmed out (retrieval-first via WebFetch)').toBe(0);
    // the SKILL.md must no longer carry the dangling references: frontmatter list
    expect(docFor('.claude/skills/cloudflare/SKILL.md')!.content).not.toMatch(/^references:/m);
  });

  it('carries the upstream Apache-2.0 LICENSE alongside the vendored skills (attribution)', () => {
    const lic = docFor('.claude/skills/cloudflare/LICENSE');
    expect(lic, 'Apache-2.0 LICENSE must travel with the vendored skills').toBeDefined();
    expect(lic!.content).toMatch(/Apache License/);
    expect(advancedOnly('.claude/skills/cloudflare/LICENSE')).toBe(true);
  });

  it('bundles the 2 Cloudflare commands (advanced-only)', () => {
    for (const c of ['cloudflare-build-agent', 'cloudflare-build-mcp']) {
      const key = `.claude/commands/${c}.md`;
      expect(has(key), `${key} must be bundled`).toBe(true);
      expect(advancedOnly(key)).toBe(true);
    }
  });

  it('the Workers retrieval rule is path-conditional (not always-on) and WebFetch-oriented', () => {
    const doc = docFor('.claude/rules/cloudflare-workers.md');
    expect(doc, 'rules/cloudflare-workers.md must be bundled').toBeDefined();
    expect(advancedOnly('.claude/rules/cloudflare-workers.md')).toBe(true);
    // `paths:` frontmatter => loaded only when Workers files are touched (progressive, not always-on)
    expect(doc!.content).toMatch(/^paths:/m);
    expect(doc!.content).toMatch(/developers\.cloudflare\.com/);
    // the bundled MCP server config is intentionally excluded (strict-egress + OAuth); WebFetch instead
    expect(doc!.content).not.toMatch(/docs\.mcp\.cloudflare\.com/);
  });

  it('does NOT bundle the upstream .mcp.json (strict-egress + OAuth incompatible)', () => {
    expect(AGENTS_SEEDED_CONFIGS.some((d) => d.key.endsWith('.mcp.json') && d.key.includes('cloudflare'))).toBe(false);
  });

  it('is seeded to non-Claude agents too (not Claude-only) — e.g. Pi gets the cloudflare skill', () => {
    expect(AGENTS_SEEDED_CONFIGS.some((d) => d.key === '.pi/agent/skills/cloudflare/SKILL.md')).toBe(true);
  });

  it('default mode receives NONE of the Cloudflare skills (advanced/Pro-only)', () => {
    const cfDocs = AGENTS_SEEDED_CONFIGS.filter(
      (d) => CF_SKILLS.some((s) => d.key.includes(`/skills/${s}/`)) ||
        d.key.includes('cloudflare-build-agent') || d.key.includes('cloudflare-build-mcp') ||
        d.key.endsWith('rules/cloudflare-workers.md')
    );
    expect(cfDocs.length, 'expected CF docs to assert against').toBeGreaterThan(0);
    for (const d of cfDocs) {
      expect(d.modes, `${d.key} must not be delivered in default mode`).not.toContain('default');
    }
  });
});
