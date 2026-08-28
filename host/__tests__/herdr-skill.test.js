import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const skill = readFileSync(join(root, 'preseed/agents/pi/skills/herdr/SKILL.md'), 'utf8');

function bashBlocks(heading, level = 2) {
  const marker = `${'#'.repeat(level)} ${heading}\n`;
  const start = skill.indexOf(marker);
  assert.notEqual(start, -1, `missing section ${heading}`);
  const afterMarker = skill.slice(start + marker.length);
  const nextHeading = afterMarker.search(new RegExp(`\\n#{1,${level}} `));
  const section = nextHeading === -1 ? afterMarker : afterMarker.slice(0, nextHeading);
  const blocks = [...section.matchAll(/```bash\n([\s\S]*?)\n```/g)].map((match) => match[1]);
  assert.ok(blocks.length > 0, `missing bash block for ${heading}`);
  return blocks;
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'codeflare-herdr-skill-'));
  const log = join(dir, 'herdr.log');
  const herdr = join(dir, 'herdr');
  writeFileSync(herdr, `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$HERDR_TEST_LOG"
case "$*" in
  'pane current --current') printf '%s\\n' '{"result":{"pane":{"pane_id":"w1:p1"}}}' ;;
  'tab list') printf '%s\\n' '{"result":{"tabs":[{"number":2,"tab_id":"w1:t2"}]}}' ;;
  'pane list') printf '{"result":{"panes":[{"pane_id":"%s","focused":true}]}}\\n' "\${HERDR_TEST_FOCUSED_PANE:-w1:p2}" ;;
  'agent list')
    if [ "\${HERDR_TEST_INVALID_AGENT_LIST:-}" = "1" ]; then
      printf '%s\\n' 'not-json'
    else
      printf '%s\\n' '{"result":{"agents":[{"name":"pi2"}]}}'
    fi
    ;;
  tab\\ create*) printf '%s\\n' '{"result":{"tab":{"tab_id":"w1:t2"},"root_pane":{"pane_id":"w9:p4"}}}' ;;
  agent\\ read*) printf '%s\\n' 'helper result' ;;
  *) printf '%s\\n' '{"result":{"agent":{"name":"helper"}}}' ;;
esac
`, { mode: 0o755 });
  chmodSync(herdr, 0o755);
  return { dir, herdr, log };
}

function run(block, env, cwd) {
  return spawnSync('bash', ['-c', block], { encoding: 'utf8', cwd, env });
}

function runBlocks(blocks, env, cwd) {
  for (const block of blocks) {
    const result = run(block, env, cwd);
    assert.equal(result.status, 0, result.stderr);
  }
}

describe('Pi Herdr control skill', () => {
  it('REQ-AGENT-173 + REQ-AGENT-174: executes documented Herdr control flows', () => {
    const { dir, herdr, log } = fixture();
    const outsideEnv = { ...process.env, HERDR_TEST_LOG: log };
    delete outsideEnv.HERDR_ENV;
    delete outsideEnv.HERDR_PANE_ID;
    delete outsideEnv.HERDR_SOCKET_PATH;
    delete outsideEnv.HERDR_BIN_PATH;
    const outside = run(bashBlocks('Gate')[0], outsideEnv, dir);
    assert.notEqual(outside.status, 0);
    assert.match(outside.stdout, /not running inside Herdr/);
    assert.equal(existsSync(log), false);

    const env = {
      ...process.env,
      HERDR_ENV: '1',
      HERDR_PANE_ID: 'w1:p1',
      HERDR_SOCKET_PATH: join(dir, 'herdr.sock'),
      HERDR_BIN_PATH: herdr,
      HERDR_TEST_LOG: log,
      PWD: dir,
    };
    delete env.HERDR;
    runBlocks(bashBlocks('Gate'), env, dir);
    runBlocks([bashBlocks('Fast UI operations')[0]], env, dir);
    runBlocks(bashBlocks('Tabs', 3), env, dir);
    runBlocks(bashBlocks('Splits', 3), env, dir);
    runBlocks(bashBlocks('Agent orchestration'), env, dir);

    const calls = readFileSync(log, 'utf8').trim().split('\n');
    assert.deepEqual(calls, [
      'pane current --current',
      'tab list',
      'pane list',
      'agent list',
      `tab create --cwd ${dir} --label pi`,
      'agent start pi3 --kind pi --pane w9:p4 --timeout 60000',
      'tab list',
      'tab focus w1:t2',
      `pane split --current --direction right --cwd ${dir} --focus`,
      `pane split --current --direction down --cwd ${dir} --focus`,
      'pane list',
      `pane split --pane w1:p2 --direction right --cwd ${dir} --focus`,
      'pane list',
      'pane close w1:p2',
      'agent list',
      `tab create --cwd ${dir} --label helper --no-focus`,
      'agent start helper --kind pi --pane w9:p4 --timeout 60000',
      'agent wait helper --until idle --until done --timeout 120000',
      'agent prompt helper Implement focused task and report changed paths --wait --until idle --until done --until blocked --timeout 120000',
      'agent prompt helper Adjust current work using this new constraint',
      'agent read helper --source recent-unwrapped --lines 200',
    ]);
    assert.doesNotMatch(calls[19], /--wait/);
  });

  it('REQ-AGENT-174: rejects invalid agent inventory before creating a tab', () => {
    const { dir, herdr, log } = fixture();
    const env = {
      ...process.env,
      HERDR_ENV: '1',
      HERDR_PANE_ID: 'w1:p1',
      HERDR_SOCKET_PATH: join(dir, 'herdr.sock'),
      HERDR_BIN_PATH: herdr,
      HERDR_TEST_LOG: log,
      HERDR_TEST_INVALID_AGENT_LIST: '1',
      PWD: dir,
    };
    delete env.HERDR;
    const result = run(bashBlocks('Tabs', 3)[0], env, dir);
    assert.notEqual(result.status, 0);
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), ['agent list']);
  });

  it('REQ-AGENT-174: refuses to close the current Pi pane', () => {
    const { dir, herdr, log } = fixture();
    const env = {
      ...process.env,
      HERDR_ENV: '1',
      HERDR_PANE_ID: 'w1:p1',
      HERDR_SOCKET_PATH: join(dir, 'herdr.sock'),
      HERDR_BIN_PATH: herdr,
      HERDR_TEST_LOG: log,
      HERDR_TEST_FOCUSED_PANE: 'w1:p1',
      PWD: dir,
    };
    delete env.HERDR;
    const closeFocused = bashBlocks('Splits', 3)[2];
    const result = run(closeFocused, env, dir);
    assert.notEqual(result.status, 0);
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), ['pane list']);
  });
});
