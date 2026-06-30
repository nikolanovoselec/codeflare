#!/usr/bin/env node
/**
 * Measure the ALWAYS-ON token budget the agent seed contributes to a Claude/Pi session,
 * per mode (REQ-ENTERPRISE token-hygiene). Progressive disclosure means only skill/command
 * DESCRIPTIONS and rules WITHOUT `paths:` frontmatter are always-on; skill bodies, command
 * bodies, references, and path-scoped rules load on demand (≈0 until triggered).
 *
 * Usage: node scripts/measure-seed-tokens.mjs
 * Approximation: ~4 chars/token (good enough to compare before/after, not for billing).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const claudeDir = path.join(__dirname, '..', 'preseed/agents/claude');
const manifest = JSON.parse(fs.readFileSync(path.join(claudeDir, 'manifest.json'), 'utf8'));
const tok = (chars) => Math.round(chars / 4);

function frontmatter(file) {
  const txt = fs.readFileSync(path.join(claudeDir, file), 'utf8');
  const m = txt.match(/^---\n([\s\S]*?)\n---/);
  return m ? m[1] : '';
}
function descChars(file) {
  const fm = frontmatter(file);
  const m = fm.match(/^description:\s*(.*)$/m);
  return m ? m[1].replace(/^["']|["']$/g, '').length : 0;
}
function hasPaths(file) {
  return /^\s*paths:/m.test(frontmatter(file));
}

for (const mode of ['default', 'advanced']) {
  const inMode = (entry) => entry.modes.includes(mode);
  let skillDesc = 0, cmdDesc = 0, alwaysRules = 0, condRules = 0;
  const fat = [];
  for (const [file, entry] of Object.entries(manifest)) {
    if (!inMode(entry)) continue;
    if (file.endsWith('/SKILL.md')) {
      const c = descChars(file); skillDesc += c;
      fat.push([file.replace('skills/', '').replace('/SKILL.md', ''), c]);
    } else if (file.startsWith('commands/') && file.endsWith('.md')) {
      cmdDesc += descChars(file);
    } else if (file.startsWith('rules/') && file.endsWith('.md')) {
      const bytes = fs.statSync(path.join(claudeDir, file)).size;
      if (hasPaths(file)) condRules += bytes; else alwaysRules += bytes;
    }
  }
  const alwaysOn = skillDesc + cmdDesc + alwaysRules;
  console.log(`\n=== mode: ${mode} ===`);
  console.log(`  skill descriptions (always-on): ${skillDesc} chars  ~${tok(skillDesc)} tok`);
  console.log(`  command descriptions (always-on): ${cmdDesc} chars  ~${tok(cmdDesc)} tok`);
  console.log(`  rules WITHOUT paths: (always-on): ${alwaysRules} bytes  ~${tok(alwaysRules)} tok`);
  console.log(`  rules WITH paths: (on-demand):    ${condRules} bytes  ~${tok(condRules)} tok  (NOT always-on)`);
  console.log(`  --> ALWAYS-ON seed total: ~${tok(alwaysOn)} tok`);
  if (mode === 'advanced') {
    fat.sort((a, b) => b[1] - a[1]);
    console.log(`  fattest skill descriptions:`);
    for (const [n, c] of fat.slice(0, 10)) console.log(`     ${n.padEnd(28)} ${c} chars ~${tok(c)} tok`);
  }
}
