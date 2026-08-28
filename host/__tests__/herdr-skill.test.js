import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const skill = readFileSync(join(root, 'preseed/agents/pi/skills/herdr/SKILL.md'), 'utf8');

function bashBlock(heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = skill.match(new RegExp(`## ${escaped}\\n[\\s\\S]*?\\n\\x60\\x60\\x60bash\\n([\\s\\S]*?)\\n\\x60\\x60\\x60`));
  assert.ok(match, `missing bash block for ${heading}`);
  return match[1];
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
  tab\\ create*) printf '%s\\n' '{"result":{"root_pane":{"pane_id":"w9:p4"}}}' ;;
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

describe('Pi Herdr orchestration skill', () => {
  it('REQ-AGENT-173: executes the documented Herdr orchestration flow', () => {
    const { dir, herdr, log } = fixture();
    const outsideEnv = { ...process.env, HERDR_TEST_LOG: log };
    delete outsideEnv.HERDR_ENV;
    delete outsideEnv.HERDR_PANE_ID;
    delete outsideEnv.HERDR_SOCKET_PATH;
    delete outsideEnv.HERDR_BIN_PATH;
    const outside = run(bashBlock('Gate'), outsideEnv, dir);
    assert.notEqual(outside.status, 0);
    assert.match(outside.stdout, /not running inside Herdr/);

    const env = {
      ...process.env,
      HERDR_ENV: '1',
      HERDR_PANE_ID: 'w1:p1',
      HERDR_SOCKET_PATH: join(dir, 'herdr.sock'),
      HERDR_BIN_PATH: herdr,
      HERDR_TEST_LOG: log,
      HERDR: herdr,
      PWD: dir,
    };
    assert.equal(run(bashBlock('Gate'), env, dir).status, 0);
    assert.equal(run(bashBlock('Start a helper in a new tab'), env, dir).status, 0);
    assert.equal(run(bashBlock('Give a settled agent work'), env, dir).status, 0);
    assert.equal(run(bashBlock('Steer a working agent'), env, dir).status, 0);
    const read = run(bashBlock('Read results'), env, dir);
    assert.equal(read.status, 0);
    assert.match(read.stdout, /helper result/);

    const calls = readFileSync(log, 'utf8').trim().split('\n');
    assert.deepEqual(calls, [
      'pane current --current',
      `tab create --cwd ${dir} --label helper --no-focus`,
      'agent start helper --kind pi --pane w9:p4 --timeout 60000',
      'agent wait helper --until idle --until done --timeout 120000',
      'agent prompt helper Implement the focused task and report changed paths --wait --until idle --until done --until blocked --timeout 120000',
      'agent prompt helper Adjust the current work using this new constraint',
      'agent read helper --source recent-unwrapped --lines 200',
    ]);
  });
});
