import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../../scripts/browser-ide-ui-state.py', import.meta.url));
const roots = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'codeflare-ide-state-'));
  roots.push(root);
  const workspace = join(root, 'workspace');
  const dataRoot = join(root, 'live');
  const snapshot = join(root, 'persistent', 'ide-ui-state.json');
  mkdirSync(join(workspace, 'src'), { recursive: true });
  writeFileSync(join(workspace, 'src', 'app.ts'), 'export const app = true;\n');
  return { root, workspace, dataRoot, snapshot };
}

function python(source, ...args) {
  return execFileSync('python3', ['-c', source, ...args], { encoding: 'utf8' });
}

function seedState(dataRoot, workspace) {
  python(String.raw`
import json, pathlib, sqlite3, sys
root, workspace = map(pathlib.Path, sys.argv[1:])
storage = root / 'data' / 'User' / 'workspaceStorage' / 'fixture'
storage.mkdir(parents=True)
(storage / 'workspace.json').write_text(json.dumps({'folder': workspace.as_uri()}))
db = sqlite3.connect(storage / 'state.vscdb')
db.execute('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)')
rows = {
  'memento/workbench.parts.editor': json.dumps({'editorpart.state': {'resource': (workspace / 'src' / 'app.ts').as_uri()}}),
  'editors.mru': json.dumps([{'resource': (workspace / 'src' / 'app.ts').as_uri()}]),
  'workbench.explorer.treeViewState': json.dumps({'expanded': [(workspace / 'src').as_uri()]}),
  'secret.storage.canary': 'must-not-persist',
}
db.executemany('INSERT INTO ItemTable(key,value) VALUES (?,?)', rows.items())
db.commit(); db.close()
settings = root / 'data' / 'User' / 'settings.json'
settings.write_text(json.dumps({
  'workbench.colorTheme': 'Default Light Modern',
  'workbench.iconTheme': 'vs-seti',
  'github.copilot.token': 'must-not-persist',
}))
`, dataRoot, workspace);
}

function vscodeWorkspaceHash(value) {
  let result = 149417;
  for (let index = 0; index < value.length; index += 1) {
    result = ((result * 31) + value.charCodeAt(index)) | 0;
  }
  return result.toString(16);
}

function readRows(dataRoot) {
  return JSON.parse(python(String.raw`
import glob, json, sqlite3, sys
paths = glob.glob(sys.argv[1] + '/data/User/workspaceStorage/*/state.vscdb')
assert len(paths) == 1, paths
db = sqlite3.connect(paths[0])
print(json.dumps(dict(db.execute('SELECT key,value FROM ItemTable'))))
`, dataRoot));
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('REQ-IDE-002: captures and restores only allowlisted theme, editor, and Explorer state', () => {
  const { workspace, dataRoot, snapshot, root } = fixture();
  seedState(dataRoot, workspace);

  execFileSync('python3', [SCRIPT, 'capture', '--data-root', dataRoot, '--snapshot', snapshot, '--workspace', workspace]);
  const capturedText = readFileSync(snapshot, 'utf8');
  const captured = JSON.parse(capturedText);
  assert.equal(captured.version, 1);
  assert.deepEqual(captured.settings, {
    'workbench.colorTheme': 'Default Light Modern',
    'workbench.iconTheme': 'vs-seti',
  });
  assert.deepEqual(Object.keys(captured.workspaceState).sort(), [
    'editors.mru',
    'memento/workbench.parts.editor',
    'workbench.explorer.treeViewState',
  ]);
  assert.doesNotMatch(capturedText, /must-not-persist|copilot|secret\.storage/);

  const restoredRoot = join(root, 'restored');
  execFileSync('python3', [SCRIPT, 'restore', '--data-root', restoredRoot, '--snapshot', snapshot, '--workspace', workspace]);
  assert.deepEqual(Object.keys(readRows(restoredRoot)).sort(), Object.keys(captured.workspaceState).sort());
  assert.deepEqual(JSON.parse(readFileSync(join(restoredRoot, 'data', 'User', 'settings.json'), 'utf8')), captured.settings);
  const workspaceUri = new URL(`file://${workspace}`).toString().replace(/\/$/, '');
  const restoredStorage = join(restoredRoot, 'data', 'User', 'workspaceStorage', vscodeWorkspaceHash(workspaceUri));
  assert.equal(existsSync(join(restoredStorage, 'state.vscdb')), true, 'restore uses Code OSS single-folder workspace identity');
  assert.deepEqual(
    readdirSync(restoredStorage).sort(),
    ['state.vscdb', 'workspace.json'],
    'restore never persists a live WAL or shared-memory database companion',
  );
});

test('REQ-IDE-002: excludes allowlisted rows whose file resources escape directly or through a symlink', () => {
  const { workspace, dataRoot, snapshot, root } = fixture();
  seedState(dataRoot, workspace);
  const outside = join(root, 'outside.ts');
  const alias = join(workspace, 'src', 'outside-alias.ts');
  writeFileSync(outside, 'private outside state\n');
  symlinkSync(outside, alias);
  python(String.raw`
import glob, json, pathlib, sqlite3, sys
root, alias = sys.argv[1:]
path = glob.glob(root + '/data/User/workspaceStorage/*/state.vscdb')[0]
db = sqlite3.connect(path)
db.execute('UPDATE ItemTable SET value=? WHERE key=?', (json.dumps({'editorpart.state': {'resource': 'file:///etc/passwd'}}), 'memento/workbench.parts.editor'))
db.execute('UPDATE ItemTable SET value=? WHERE key=?', (json.dumps([{'resource': pathlib.Path(alias).as_uri()}]), 'editors.mru'))
db.commit(); db.close()
`, dataRoot, alias);

  execFileSync('python3', [SCRIPT, 'capture', '--data-root', dataRoot, '--snapshot', snapshot, '--workspace', workspace]);
  const captured = JSON.parse(readFileSync(snapshot, 'utf8'));
  assert.equal(captured.workspaceState['memento/workbench.parts.editor'], undefined);
  assert.equal(captured.workspaceState['editors.mru'], undefined);
  assert.ok(captured.workspaceState['workbench.explorer.treeViewState']);
});

test('REQ-IDE-002: excludes unknown fields and opaque strings from allowlisted state rows', () => {
  const { workspace, dataRoot, snapshot } = fixture();
  seedState(dataRoot, workspace);
  python(String.raw`
import glob, json, pathlib, sqlite3, sys
root, workspace = sys.argv[1:]
resource = (pathlib.Path(workspace) / 'src' / 'app.ts').as_uri()
path = glob.glob(root + '/data/User/workspaceStorage/*/state.vscdb')[0]
db = sqlite3.connect(path)
rows = {
  'memento/workbench.parts.editor': {'editorpart.state': {'resource': resource, 'label': 'secret-token'}},
  'editors.mru': [{'resource': resource, 'credential': 'secret-token'}],
  'workbench.explorer.treeViewState': {'expanded': [resource], 'opaque': 'secret-token'},
}
for key, value in rows.items():
  db.execute('UPDATE ItemTable SET value=? WHERE key=?', (json.dumps(value), key))
db.commit(); db.close()
`, dataRoot, workspace);

  execFileSync('python3', [SCRIPT, 'capture', '--data-root', dataRoot, '--snapshot', snapshot, '--workspace', workspace]);
  const capturedText = readFileSync(snapshot, 'utf8');
  const captured = JSON.parse(capturedText);
  assert.deepEqual(captured.workspaceState, {});
  assert.doesNotMatch(capturedText, /secret-token|credential|opaque/);
});

test('REQ-IDE-002: ignores malformed and oversized snapshots instead of importing attacker-controlled state', () => {
  for (const body of ['{not-json', JSON.stringify({ version: 1, settings: { 'workbench.colorTheme': 'x'.repeat(1_100_000) }, workspaceState: {} })]) {
    const { workspace, dataRoot, snapshot } = fixture();
    mkdirSync(join(snapshot, '..'), { recursive: true });
    writeFileSync(snapshot, body);
    execFileSync('python3', [SCRIPT, 'restore', '--data-root', dataRoot, '--snapshot', snapshot, '--workspace', workspace]);
    assert.equal(readFileSync(snapshot, 'utf8'), body);
    assert.throws(() => readFileSync(join(dataRoot, 'data', 'User', 'settings.json'), 'utf8'), { code: 'ENOENT' });
  }
});
