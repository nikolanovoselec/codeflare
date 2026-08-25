import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const entrypoint = readFileSync(resolve(__dirname, '../../entrypoint.sh'), 'utf8');

function startupPrefix() {
  const end = entrypoint.indexOf('\n# Track sync status\n');
  assert.ok(end > 0, 'entrypoint startup prefix boundary is missing');
  return entrypoint.slice(0, end);
}

function observeBridgeIdleEnv(inherited) {
  const home = mkdtempSync(join(tmpdir(), 'entrypoint-context-mode-'));
  const imageCache = join(home, 'opt/codeflare/jiti-cache');
  const runtimeRoot = join(home, 'run');
  mkdirSync(imageCache, { recursive: true });
  const prefix = startupPrefix()
    .replace('export CODEFLARE_RUNTIME_ROOT="/run/codeflare"', `export CODEFLARE_RUNTIME_ROOT=${JSON.stringify(runtimeRoot)}`)
    .replace('USER_HOME="/home/user"', `USER_HOME=${JSON.stringify(home)}`)
    .replace(
      '\nconfigure_pi_jiti_runtime_cache\n',
      `\nconfigure_pi_jiti_runtime_cache ${JSON.stringify(home)}\n`,
    );
  const script = `${prefix}\nprintf 'BRIDGE_IDLE=%s\\n' "\${CONTEXT_MODE_BRIDGE_IDLE_MS-unset}"\nenv -u NODE_OPTIONS node -e 'console.log("NODE_TMPDIR=" + require("node:os").tmpdir())'`;
  const env = { ...process.env, USER_TIMEZONE: '' };
  if (inherited === undefined) delete env.CONTEXT_MODE_BRIDGE_IDLE_MS;
  else env.CONTEXT_MODE_BRIDGE_IDLE_MS = inherited;
  return spawnSync('bash', ['-c', script], { encoding: 'utf8', env });
}

describe('REQ-AGENT-076 AC7: entrypoint preserves context-mode bridge idle reaping', () => {
  it('REQ-AGENT-076 AC7: preserves an inherited nonzero timeout through the real startup prefix', () => {
    const result = observeBridgeIdleEnv('180000');

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /BRIDGE_IDLE=180000/);
  });

  it('REQ-OPS-047: routes context-mode preload scratch through protected runtime TMPDIR', () => {
    const result = observeBridgeIdleEnv(undefined);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /NODE_TMPDIR=.*\/run\/pi-tmp/);
  });

  it('REQ-AGENT-076 AC7: creates no global override when the container environment omits one', () => {
    const result = observeBridgeIdleEnv(undefined);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /BRIDGE_IDLE=unset/);
  });
});
