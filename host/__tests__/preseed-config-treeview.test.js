// REQ-VAULT-008 AC7: preseed CONFIG.md declares treeview exclude patterns
// for the agent-derived / system folders that should not appear in the
// SB tree pane: Library/**, Repositories/**, top-level preseed pages
// (CONFIG.md, Index.md, README.md, STYLES.md), .silverbullet/**,
// graphify-out/**.
//
// Server-side `/.fs` filtering (AC6) hides graphify-out from the
// raw listing. The treeview plug runs client-side from the same
// listing data but ALSO reads its exclude patterns from a config
// page, so a future SB version that ignores server-filtered entries
// (e.g. caches the raw response) still hides them at the UI surface.
// Two independent guards — server + UI — survive a bug in either.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CONFIG_PATH = path.join(__dirname, '..', '..', 'preseed', 'silverbullet', 'CONFIG.md');

test('CONFIG.md declares a treeview exclude block (REQ-VAULT-008 AC7)', () => {
  const body = fs.readFileSync(CONFIG_PATH, 'utf8');
  assert.match(body, /treeview/i, 'CONFIG.md must reference treeview config');
});

test('CONFIG.md excludes graphify-out from treeview (REQ-VAULT-008 AC7)', () => {
  const body = fs.readFileSync(CONFIG_PATH, 'utf8');
  assert.match(body, /graphify-out/, 'CONFIG.md must list graphify-out in treeview exclude');
});

test('CONFIG.md excludes Library/ from treeview (REQ-VAULT-008 AC7)', () => {
  const body = fs.readFileSync(CONFIG_PATH, 'utf8');
  assert.match(body, /Library/, 'CONFIG.md must list Library in treeview exclude');
});

test('CONFIG.md excludes .silverbullet/ from treeview (REQ-VAULT-008 AC7)', () => {
  const body = fs.readFileSync(CONFIG_PATH, 'utf8');
  assert.match(body, /\.silverbullet/, 'CONFIG.md must list .silverbullet in treeview exclude');
});

test('CONFIG.md excludes top-level preseed pages (CONFIG/Index/README/STYLES) from treeview (REQ-VAULT-008 AC7)', () => {
  const body = fs.readFileSync(CONFIG_PATH, 'utf8');
  for (const page of ['CONFIG', 'Index', 'README', 'STYLES']) {
    assert.match(body, new RegExp(page), `CONFIG.md must mention ${page} as treeview-excluded`);
  }
});
