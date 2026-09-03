#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUNDLE_URL = 'https://impeccable.style/api/download/bundle/universal';
const repoRoot = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const CODEFLARE_IMPECCABLE_DESCRIPTION = 'Critique, audit, harden, adapt, animate, or apply bounded polish to an existing interface whose direction remains intact. Use for accessibility, responsive behavior, performance, UX copy, interaction detail, visual finishing, and explicit impeccable commands. For greenfield creation or any change to the visual thesis, the applicable platform design owner controls art direction; use Impeccable afterward for critique or finishing. Not for backend-only or non-UI tasks.';
const CODEFLARE_IMPECCABLE_BOUNDARY = `## Codeflare routing boundary

Impeccable owns interface critique, finishing, and its explicitly invoked commands. For a general greenfield or full-redesign request, the applicable platform design owner establishes the visual thesis before Impeccable audits or refines it. When another skill routes here as support, load only the requested critique or finishing playbook; the later general/new-work path applies only after explicit Impeccable invocation. Explicit Impeccable commands keep their documented behavior.`;

export async function updateImpeccableSkill() {
  const tempRoot = mkdtempSync(join(tmpdir(), 'impeccable-skill-'));
  const bundlePath = join(tempRoot, 'bundle.zip');
  const outDir = join(tempRoot, 'out');
  try {
    const response = await fetch(BUNDLE_URL, { headers: { 'user-agent': 'codeflare-shadow-pin-bot' } });
    if (!response.ok) throw new Error(`download failed: ${response.status} ${response.statusText}`);
    writeFileSync(bundlePath, Buffer.from(await response.arrayBuffer()));
    execFileSync('unzip', ['-q', bundlePath, '-d', outDir]);

    const source = join(outDir, '.claude', 'skills', 'impeccable');
    const sourceSkill = join(source, 'SKILL.md');
    const skillText = readFileSync(sourceSkill, 'utf8');
    const version = skillText.match(/^version:\s*(.+)$/m)?.[1];
    if (!version) throw new Error('downloaded Impeccable skill has no version frontmatter');

    const targets = [
      { agent: 'claude', root: join(repoRoot, 'preseed/agents/claude/skills/impeccable'), runtimePath: '~/.claude/skills/impeccable' },
      { agent: 'pi', root: join(repoRoot, 'preseed/agents/pi/skills/impeccable'), runtimePath: '~/.pi/agent/skills/impeccable' },
    ];
    replaceImpeccableTargets(source, skillText, targets);
    for (const target of targets) syncManifest(target.agent, target.root);

    console.log(`Updated Impeccable preseed skill to ${version}`);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

export function replaceImpeccableTargets(source, skillText, targets) {
  const transformedSkill = applyCodeflareRoutingBoundary(skillText);
  for (const target of targets) {
    rmSync(target.root, { recursive: true, force: true });
    cpSync(source, target.root, { recursive: true });
    rewriteFiles(target.root, target.runtimePath, transformedSkill);
  }
}

function rewriteFiles(root, runtimePath, transformedSkill) {
  for (const file of walkFiles(root)) {
    if (!/\.(css|html|js|json|md|mjs|ts|tsx|txt)$/.test(file)) continue;
    let text = file === join(root, 'SKILL.md')
      ? transformedSkill
      : readFileSync(file, 'utf8');
    text = text.replaceAll('.claude/skills/impeccable', runtimePath);

    // hook-admin manages project-local hook manifests. Those commands must stay
    // project-relative even though the preseed skill itself lives in the user's
    // global agent config directory.
    if (file.endsWith('/scripts/hook-admin.mjs')) {
      text = text
        .replaceAll(`skillRel: '${runtimePath}'`, `skillRel: '.claude/skills/impeccable'`)
        .replaceAll(`node "${'${CLAUDE_PROJECT_DIR}'}/${runtimePath}/scripts/hook.mjs"`, 'node "${CLAUDE_PROJECT_DIR}/.claude/skills/impeccable/scripts/hook.mjs"');
    }
    writeFileSync(file, text);
  }
}

export function applyCodeflareRoutingBoundary(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) throw new Error('downloaded Impeccable skill has malformed frontmatter');
  const descriptions = match[1].match(/^description:.*$/gm) ?? [];
  if (descriptions.length !== 1) {
    throw new Error('downloaded Impeccable skill must have exactly one frontmatter description');
  }
  const frontmatter = match[1]
    .replace(
      /^description:.*$/m,
      `description: ${CODEFLARE_IMPECCABLE_DESCRIPTION}`,
    )
    .replace(/^\s*- Bash\(npx impeccable \*\)\s*$/m, '');
  const body = text.slice(match[0].length);
  return `---\n${frontmatter}\n---\n\n${CODEFLARE_IMPECCABLE_BOUNDARY}\n${body}`;
}

function syncManifest(agent, skillRoot) {
  const manifestPath = join(repoRoot, `preseed/agents/${agent}/manifest.json`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const files = [...walkFiles(skillRoot)]
    .map((file) => file.slice(join(repoRoot, `preseed/agents/${agent}/`).length).replaceAll('\\', '/'))
    .sort();
  const next = {};
  let inserted = false;
  for (const [key, value] of Object.entries(manifest)) {
    if (key.startsWith('skills/impeccable/')) {
      if (!inserted) {
        for (const file of files) next[file] = { modes: ['advanced'] };
        inserted = true;
      }
      continue;
    }
    next[key] = value;
  }
  if (!inserted) {
    for (const file of files) next[file] = { modes: ['advanced'] };
  }
  writeFileSync(manifestPath, JSON.stringify(next, null, 2) + '\n');
}

function* walkFiles(dir) {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) yield* walkFiles(full);
    else if (stat.isFile()) yield full;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await updateImpeccableSkill();
}
