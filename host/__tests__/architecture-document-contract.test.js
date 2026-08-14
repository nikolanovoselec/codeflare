import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');
const ARCHITECTURE = join(ROOT, 'documentation/lanes/architecture.md');

const LEGACY_FRAGMENTS = [
  'architecture',
  'contents',
  'architecture-overview',
  'system-components',
  'worker-hono-router',
  'container-do-container',
  'llminterceptor-enterprise-mode',
  'egresscontroller-strict-gateway-egress-enterprise-mode',
  'cloudflarebrowserinterceptor-non-enterprise-oauth-mode',
  'github-integration',
  'browser-ide-native-agents-req-ide-005-req-ide-006-req-ide-007-req-ide-008',
  'browser-ide-native-agents-req-ide-002-req-ide-005-req-ide-006-req-ide-007-req-ide-008-req-ide-010-req-ide-011-req-ide-013-req-ide-014-req-ide-015-req-ide-016-req-ide-017',
  'browser-ide-native-agents-req-ide-002-req-ide-005-req-ide-006-req-ide-007-req-ide-008-req-ide-010-req-ide-011-req-ide-013-req-ide-014-req-ide-015-req-ide-016-req-ide-017-req-ide-019-req-ide-020',
  'browser-ide-native-agents-req-ide-002-req-ide-005-req-ide-006-req-ide-007-req-ide-008-req-ide-010-req-ide-011-req-ide-013-req-ide-014-req-ide-015-req-ide-016-req-ide-017-req-ide-019-req-ide-020-req-ide-021',
  'browser-ide-native-agents-req-ide-002-req-ide-005-req-ide-006-req-ide-007-req-ide-008-req-ide-010-req-ide-011-req-ide-013-req-ide-014-req-ide-015-req-ide-016-req-ide-017-req-ide-019-req-ide-020-req-ide-021-req-ide-022',
  'browser-ide-native-agents-req-ide-002-req-ide-005-req-ide-006-req-ide-007-req-ide-008-req-ide-010-req-ide-011-req-ide-013-req-ide-014-req-ide-015-req-ide-016-req-ide-017-req-ide-019-req-ide-020-req-ide-021-req-ide-022-req-ide-024',
  'terminal-server-node-pty',
  'landing-astro-prerendered',
  'frontend-solidjs--xtermjs',
  'visible-terminal-workspace-and-multiview',
  'dashboard-ws-disconnect-flow',
  'three-color-session-status',
  'data-flow',
  'session-creation-to-terminal-connection',
  'startup-status-stages-req-session-015',
  'startup-status-stages-req-session-017',
  'session-lifecycle-state-machine-req-session-018',
  'metrics-data-flow',
  'contact-relay-data-flow-req-landing-002',
  'onboarding-access-request-flow-req-auth-020',
  'onboarding-access-request-flow-req-auth-021',
  'github-clone-data-flow-req-github-004',
  'enterprise-llm-routing',
  'strict-gateway-egress',
  'pi-memory-and-vault-extraction-data-flow',
  'pi-pr-boundary-review-data-flow',
  'user-invoked-review-and-sdd-ownership',
  'pi-ci-monitoring-data-flow',
  'module-level-caches',
  'design-rationale',
  'landing-composition-implementation',
  'page-composition',
  'content-model',
  'shared-sections',
  'shared-terminals',
  'proof-animation',
  'feature-reels',
  'reveal-motion',
  'scramble-motion',
  'orchestration-proof',
  'design-tokens',
  'navigation-and-trust',
  'specification-coverage',
  'related-documentation',
  'bucket-creation-and-seeding',
  'container-reference',
  'manual-verification-checklist',
  'mobile-reference',
  'preseed-reference',
  'storage-and-sync-reference',
  'vault-reference',
];

const REQUIRED_H2 = [
  'Contents',
  'Purpose, Audience, and Ownership',
  'System at a Glance',
  'System Components',
  'Architectural Invariants',
  'State Ownership and Durability',
  'Data Flow',
  'Failure Domains and Recovery Ownership',
  'Observability and Operator Signals',
  'Capacity, Caching, and Performance Assumptions',
  'Security and Privacy Boundaries',
  'Decision and Requirement Map',
  'Related Documentation',
];

const REQUIRED_COMPONENTS = [
  'Worker',
  'Container DO',
  'LlmInterceptor',
  'EgressController',
  'CloudflareBrowserInterceptor',
  'GitHub Integration',
  'Browser IDE',
  'Terminal Server',
  'Landing',
  'Frontend',
  'KV',
  'R2',
  'Timekeeper',
];

function outsideFences(markdown) {
  const lines = [];
  let fence = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*```/.test(line)) {
      fence = !fence;
      continue;
    }
    if (!fence) lines.push(line);
  }
  return lines;
}

function visibleHeadingText(source) {
  let value = source;
  let previous;
  do {
    previous = value;
    value = value.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');
  } while (value !== previous);
  return value
    .replace(/<[^>]+>/g, '')
    .replace(/[`*_\\]/g, '')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>');
}

function githubSlug(source, seen) {
  const base = [...visibleHeadingText(source).toLowerCase()]
    .filter((char) => /[\p{L}\p{N}_ -]/u.test(char))
    .join('')
    .replaceAll(' ', '-');
  const count = seen.get(base) ?? 0;
  seen.set(base, count + 1);
  return count === 0 ? base : `${base}-${count}`;
}

function parseDocument(markdown) {
  const headings = [];
  const ids = [];
  const seen = new Map();
  for (const line of outsideFences(markdown)) {
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      headings.push({ level: heading[1].length, title: visibleHeadingText(heading[2]), id: githubSlug(heading[2], seen) });
    }
    for (const match of line.matchAll(/<a\s+[^>]*id=["']([^"']+)["'][^>]*>/gi)) ids.push(match[1]);
  }
  return { headings, ids };
}

function fragmentCounts(parsed) {
  const counts = new Map();
  for (const id of [...parsed.headings.map((heading) => heading.id), ...parsed.ids]) {
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

function componentSections(markdown) {
  const lines = outsideFences(markdown);
  const components = new Map();
  let inComponents = false;
  let current = null;
  for (const line of lines) {
    const h2 = /^##\s+(.+?)\s*$/.exec(line);
    if (h2) {
      inComponents = visibleHeadingText(h2[1]) === 'System Components';
      current = null;
      continue;
    }
    if (!inComponents) continue;
    const h3 = /^###\s+(.+?)\s*$/.exec(line);
    if (h3) {
      current = visibleHeadingText(h3[1]);
      components.set(current, []);
      continue;
    }
    if (current) components.get(current).push(line);
  }
  return components;
}

function architectureLinks(path) {
  const markdown = readFileSync(path, 'utf8');
  const links = [];
  for (const line of outsideFences(markdown)) {
    for (const match of line.matchAll(/\[[^\]]*\]\(([^)]*architecture\.md)(?:#([^)]+))?\)/g)) {
      if (!match[1].includes('://')) links.push({ target: resolve(dirname(path), match[1]), fragment: match[2] });
    }
    for (const match of line.matchAll(/href=["']([^"']*architecture\.md)(?:#([^"']+))?["']/gi)) {
      if (!match[1].includes('://')) links.push({ target: resolve(dirname(path), match[1]), fragment: match[2] });
    }
  }
  return links;
}

function trackedMarkdownFiles() {
  return execFileSync('git', ['ls-files', '*.md'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .map((path) => join(ROOT, path));
}

function localMarkdownLinks(path) {
  const links = [];
  for (const line of outsideFences(readFileSync(path, 'utf8'))) {
    for (const match of line.matchAll(/\[[^\]]*\]\(([^)]+\.md)(?:#([^)]+))?\)/g)) {
      if (!match[1].includes('://')) links.push({ target: resolve(dirname(path), match[1]), fragment: match[2] });
    }
  }
  return links;
}

function mermaidBlocks(markdown) {
  return [...markdown.matchAll(/```mermaid\s*\n([\s\S]*?)```/g)].map((match) => match[1]);
}

function hasBlock(blocks, required) {
  return blocks.some((block) => required.every((token) => block.includes(token)));
}

describe('Architecture documentation contract', () => {
  const markdown = readFileSync(ARCHITECTURE, 'utf8');
  const parsed = parseDocument(markdown);

  it('preserves every published and historical Architecture fragment exactly once', () => {
    const counts = fragmentCounts(parsed);
    for (const fragment of LEGACY_FRAGMENTS) {
      assert.equal(counts.get(fragment), 1, `expected exactly one Architecture target for #${fragment}`);
    }
  });

  it('exposes the operator-grade system-map sections', () => {
    const h2 = new Set(parsed.headings.filter((heading) => heading.level === 2).map((heading) => heading.title));
    for (const title of REQUIRED_H2) assert.ok(h2.has(title), `missing Architecture section: ${title}`);
  });

  it('keeps every runtime component evidence-bearing', () => {
    const components = componentSections(markdown);
    for (const required of REQUIRED_COMPONENTS) {
      const entry = [...components.entries()].find(([name]) => name === required || name.startsWith(`${required} (`));
      assert.ok(entry, `missing component: ${required}`);
      const body = entry[1].join('\n');
      for (const field of ['Responsibility', 'Inputs', 'Outputs', 'State owned', 'Does not own', 'Source', 'Requirements', 'Decisions', 'Detailed documentation']) {
        assert.match(body, new RegExp(`\\*\\*${field}:\\*\\*`), `${required} missing ${field}`);
      }
    }
  });

  it('keeps every repository link into Architecture resolvable', () => {
    const files = trackedMarkdownFiles();
    const counts = fragmentCounts(parsed);
    for (const path of files) {
      for (const link of architectureLinks(path)) {
        assert.equal(link.target, ARCHITECTURE, `unexpected Architecture target from ${path}`);
        if (link.fragment) assert.equal(counts.get(link.fragment), 1, `unresolved ${link.fragment} from ${path}`);
      }
    }
  });

  it('keeps every local Architecture owner and evidence link resolvable', () => {
    for (const link of localMarkdownLinks(ARCHITECTURE)) {
      assert.ok(existsSync(link.target), `missing Architecture link target: ${link.target}`);
      if (!link.fragment) continue;
      const counts = fragmentCounts(parseDocument(readFileSync(link.target, 'utf8')));
      assert.equal(counts.get(link.fragment), 1, `unresolved or duplicate ${link.fragment} in ${link.target}`);
    }
  });

  it('retains the load-bearing cross-component diagram semantics', () => {
    const blocks = mermaidBlocks(markdown);
    assert.ok(hasBlock(blocks, ['Browser', 'Worker', 'Container', 'R2']), 'missing system context flow');
    assert.ok(hasBlock(blocks, ['Browser', 'KV', 'Container DO', 'WebSocket']), 'missing session start flow');
    assert.ok(hasBlock(blocks, ['stopped', 'initializing', 'running', 'shutdownRequested']), 'missing lifecycle authority flow');
    assert.ok(hasBlock(blocks, ['Container', 'LlmInterceptor', 'AI Gateway']), 'missing enterprise LLM boundary');
    assert.ok(hasBlock(blocks, ['env.EGRESS', 'Cloudflare Gateway', 'own-account']), 'missing strict egress boundary');
    assert.ok(hasBlock(blocks, ['Root Pi session', 'Extraction agent', 'graph', 'native terminal notification']), 'missing extraction ownership flow');
  });
});
