// REQ-VAULT-008 AC7: preseed CONFIG.md declares treeview exclusions
// that hide agent-derived / system entries from the SB tree pane:
// Library/, graphify-out/, and the top-level preseed pages CONFIG,
// Index, README, STYLES. `.silverbullet/` is dotted and SB hides
// dot-prefixed entries by default.
//
// Why this test exists (and why it does what it does): the previous
// version was text-matching theater - it asserted that the literal
// strings "treeview", "graphify-out", etc. appeared anywhere in the
// file. That passed even when the surrounding config used the WRONG
// schema (`config.set("plug.treeview", { exclude = {...} })` instead
// of the upstream `config.set { treeview = { exclusions = {...} } }`).
// The plug silently dropped every rule and the treeview showed
// everything in production. Code-reviewer / tdd-discipline calls this
// out as a HIGH antipattern: deleting the implementation would not
// fail the test.
//
// This rewrite parses the space-lua block, extracts the regex rules,
// and verifies the actual behaviour: each rule must match the entries
// that should be hidden AND must not match entries that should stay
// visible. Mutating any rule string to one that no longer matches the
// hidden entry will fail. Reverting to the wrong schema (no
// `exclusions` array) will fail. Deleting the block will fail.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, '..', '..', 'preseed', 'silverbullet', 'CONFIG.md');

function loadSpaceLuaBlock() {
  const body = fs.readFileSync(CONFIG_PATH, 'utf8');
  const m = body.match(/```space-lua\n([\s\S]*?)\n```/);
  if (!m) throw new Error('preseed CONFIG.md missing a ```space-lua``` block');
  return m[1];
}

function stripLuaComments(lua) {
  // space-lua uses `-- ...` line comments. Strip them before schema
  // checks so prose mentioning legacy keys (e.g. "NOT plug.treeview")
  // does not trip the legacy-schema guard.
  return lua.replace(/--[^\n]*/g, '');
}

function extractTreeviewRegexRules(lua) {
  // We are not running a Lua interpreter; we just need the regex rules
  // out of `treeview = { exclusions = { { type = "regex", rule = "<X>" }, ... } }`.
  // Reject the legacy wrong schemas explicitly so they cannot silently
  // re-appear.
  const code = stripLuaComments(lua);
  if (/plug\.treeview/.test(code)) {
    throw new Error('treeview config uses the wrong top-level key "plug.treeview" - upstream schema is "treeview"');
  }
  if (/exclude\s*=\s*\{[^}]*"/.test(code) && !/exclusions\s*=/.test(code)) {
    throw new Error('treeview config uses the wrong field name "exclude" - upstream schema is "exclusions"');
  }
  const m = code.match(/treeview\s*=\s*\{[\s\S]*?exclusions\s*=\s*\{([\s\S]*?)\n\s*\}\s*,?\s*\n\s*\}/);
  if (!m) {
    throw new Error('treeview.exclusions block not found in space-lua');
  }
  const rules = [];
  const ruleRe = /type\s*=\s*"regex"\s*,\s*rule\s*=\s*"((?:[^"\\]|\\.)*)"/g;
  let r;
  while ((r = ruleRe.exec(m[1])) !== null) {
    rules.push(r[1]);
  }
  if (rules.length === 0) {
    throw new Error('treeview.exclusions contains no { type = "regex", rule = ... } entries');
  }
  return rules;
}

function matchesAny(rules, candidate) {
  for (const r of rules) {
    if (new RegExp(r).test(candidate)) return true;
  }
  return false;
}

test('CONFIG.md has a treeview.exclusions block with the upstream schema (REQ-VAULT-008 AC7)', () => {
  const lua = loadSpaceLuaBlock();
  const rules = extractTreeviewRegexRules(lua);
  assert.ok(rules.length >= 1, 'must declare at least one exclusion rule');
});

test('treeview rules hide every entry that should be hidden (REQ-VAULT-008 AC7)', () => {
  const rules = extractTreeviewRegexRules(loadSpaceLuaBlock());
  for (const hidden of [
    'CONFIG',
    'Index',
    'README',
    'STYLES',
    'Library/Codeflare/treeview.plug.js',
    'Library/Std/Config',
    'Repositories/Std/Pages/Library Manager',
    'Repositories/silverbulletmd/silverbullet-pdf',
    'graphify-out/graph.json',
    'graphify-out/vault-graph.json',
  ]) {
    assert.ok(matchesAny(rules, hidden), `expected at least one rule to match "${hidden}", got rules: ${JSON.stringify(rules)}`);
  }
});

test('treeview rules do NOT hide entries the user should see (REQ-VAULT-008 AC7)', () => {
  const rules = extractTreeviewRegexRules(loadSpaceLuaBlock());
  for (const visible of [
    'Notes/MyNote',
    'Inbox/Quick Note 2026-05-18',
    'Raw/Sessions/2026-05-18T18-00-13+0000-f549328a',
    'Raw/Pasted/Screenshot 2026-05-18',
    'Journal/Today',
  ]) {
    assert.ok(!matchesAny(rules, visible), `did not expect any rule to match "${visible}", rules: ${JSON.stringify(rules)}`);
  }
});
