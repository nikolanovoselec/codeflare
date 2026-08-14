import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, it } from 'node:test';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const scriptsDir = join(repoRoot, 'preseed/agents/claude/skills/turnstile-spin/scripts');
const fixtures = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'turnstile-spin-'));
  fixtures.push(root);
  return root;
}

function executable(path, source) {
  writeFileSync(path, source);
  chmodSync(path, 0o755);
}

function run(script, { args = [], env = {}, input = '' } = {}) {
  return spawnSync('bash', [join(scriptsDir, script), ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    input,
    env: {
      ...process.env,
      WRANGLER_BIN: '',
      WRANGLER_VERSION: '',
      PROJECT_ROOT: '',
      ...env,
    },
  });
}

function curlFixture(source) {
  const root = fixture();
  const bin = join(root, 'bin');
  mkdirSync(bin);
  executable(join(bin, 'curl'), source);
  return { root, path: `${bin}:${process.env.PATH}` };
}

afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Turnstile Spin shell boundaries', () => {
  it('rejects malformed authentication input before making a request', () => {
    const { root, path } = curlFixture(`#!/usr/bin/env bash
: > "$CURL_CALLED_MARKER"
exit 99
`);
    const marker = join(root, 'curl-called');
    const result = run('auth-probe.sh', {
      env: {
        PATH: path,
        CURL_CALLED_MARKER: marker,
        CLOUDFLARE_API_TOKEN: 'invalid token',
        CLOUDFLARE_ACCOUNT_ID: 'account',
      },
    });

    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout).status, 'missing_token');
    assert.match(result.stderr, /invalid format/);
    assert.equal(existsSync(marker), false);
  });

  it('classifies Cloudflare code 10000 over HTTP 400 as missing scope', () => {
    const { path } = curlFixture(`#!/usr/bin/env bash
printf '%s\\n%s\\n' '{"success":false,"errors":[{"code":10000}]}' '400'
`);
    const result = run('auth-probe.sh', {
      env: { PATH: path, CLOUDFLARE_API_TOKEN: 'valid_token', CLOUDFLARE_ACCOUNT_ID: 'account' },
    });

    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout).status, 'missing_scope');
  });

  it('fails closed on malformed probe responses', () => {
    const { path } = curlFixture(`#!/usr/bin/env bash
printf '%s\\n%s\\n' 'not-json' '400'
`);
    const result = run('auth-probe.sh', {
      env: { PATH: path, CLOUDFLARE_API_TOKEN: 'valid_token', CLOUDFLARE_ACCOUNT_ID: 'account' },
    });

    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout).status, 'upstream_failure');
  });

  it('bounds the auth probe and reports curl timeout failure', () => {
    const { root, path } = curlFixture(`#!/usr/bin/env bash
printf '%s' "$*" > "$CURL_ARGS_LOG"
exit 28
`);
    const argsLog = join(root, 'curl-args');
    const result = run('auth-probe.sh', {
      env: {
        PATH: path,
        CURL_ARGS_LOG: argsLog,
        CLOUDFLARE_API_TOKEN: 'valid_token',
        CLOUDFLARE_ACCOUNT_ID: 'account',
      },
    });

    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout).status, 'network_failure');
    assert.match(readFileSync(argsLog, 'utf8'), /--connect-timeout 10/);
    assert.match(readFileSync(argsLog, 'utf8'), /--max-time 30/);
  });

  it('bounds cleanup after an unexpected widget creation', () => {
    const { root, path } = curlFixture(`#!/usr/bin/env bash
count=$(cat "$CURL_COUNT_FILE" 2>/dev/null || printf '0')
count=$((count + 1))
printf '%s' "$count" > "$CURL_COUNT_FILE"
if [[ "$count" == 1 ]]; then
  printf '%s\\n%s\\n' '{"success":true,"result":{"sitekey":"created-sitekey"}}' '200'
  exit 0
fi
printf '%s' "$*" > "$CURL_ARGS_LOG"
exit 28
`);
    const argsLog = join(root, 'curl-args');
    const result = run('auth-probe.sh', {
      env: {
        PATH: path,
        CURL_ARGS_LOG: argsLog,
        CURL_COUNT_FILE: join(root, 'curl-count'),
        CLOUDFLARE_API_TOKEN: 'valid_token',
        CLOUDFLARE_ACCOUNT_ID: 'account',
      },
    });

    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout).status, 'ok');
    assert.match(result.stderr, /cleanup DELETE.*FAILED/);
    assert.match(readFileSync(argsLog, 'utf8'), /-X DELETE/);
    assert.match(readFileSync(argsLog, 'utf8'), /--connect-timeout 10/);
    assert.match(readFileSync(argsLog, 'utf8'), /--max-time 30/);
  });

  it('bounds widget creation and returns structured network failure', () => {
    const { root, path } = curlFixture(`#!/usr/bin/env bash
printf '%s' "$*" > "$CURL_ARGS_LOG"
exit 28
`);
    const argsLog = join(root, 'curl-args');
    const result = run('widget-create.sh', {
      args: ['--account-id', 'account', '--name', 'widget', '--domains', 'example.com'],
      env: { PATH: path, CURL_ARGS_LOG: argsLog, CLOUDFLARE_API_TOKEN: 'valid_token' },
    });

    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stdout), {
      status: 'error', code: 0, message: 'Cloudflare API request failed',
    });
    assert.match(readFileSync(argsLog, 'utf8'), /--connect-timeout 10/);
    assert.match(readFileSync(argsLog, 'utf8'), /--max-time 30/);
  });

  it('bounds widget metadata validation requests', () => {
    const { root, path } = curlFixture(`#!/usr/bin/env bash
printf '%s' "$*" > "$CURL_ARGS_LOG"
exit 28
`);
    executable(join(root, 'bin', 'jq'), '#!/usr/bin/env bash\nexit 0\n');
    const argsLog = join(root, 'curl-args');
    const result = run('validate.sh', {
      args: ['--sitekey', 'sitekey', '--account-id', 'account', '--expected-domains', '["example.com"]'],
      env: { PATH: path, CURL_ARGS_LOG: argsLog, CLOUDFLARE_API_TOKEN: 'valid_token' },
      input: 'widget_secret',
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /metadata lookup failed/);
    assert.match(readFileSync(argsLog, 'utf8'), /--connect-timeout 10/);
    assert.match(readFileSync(argsLog, 'utf8'), /--max-time 30/);
  });

  it('bounds dummy-token Siteverify requests', () => {
    const { root, path } = curlFixture(`#!/usr/bin/env bash
count=$(cat "$CURL_COUNT_FILE" 2>/dev/null || printf '0')
count=$((count + 1))
printf '%s' "$count" > "$CURL_COUNT_FILE"
if [[ "$count" == 1 ]]; then
  printf '%s' '{"success":true,"result":{"sitekey":"sitekey","secret":"widget_secret","clearance_level":"managed","domains":["example.com"]}}'
  exit 0
fi
printf '%s' "$*" > "$CURL_ARGS_LOG"
exit 28
`);
    executable(join(root, 'bin', 'jq'), `#!/usr/bin/env bash
if [[ "$*" == *'.result.secret'* ]]; then printf '%s\\n' 'widget_secret'; fi
exit 0
`);
    const argsLog = join(root, 'curl-args');
    const result = run('validate.sh', {
      args: ['--sitekey', 'sitekey', '--account-id', 'account', '--expected-domains', '["example.com"]'],
      env: {
        PATH: path,
        CURL_ARGS_LOG: argsLog,
        CURL_COUNT_FILE: join(root, 'curl-count'),
        CLOUDFLARE_API_TOKEN: 'valid_token',
      },
      input: 'widget_secret',
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /dummy-token siteverify request failed/);
    assert.match(readFileSync(argsLog, 'utf8'), /turnstile\/v0\/siteverify/);
    assert.match(readFileSync(argsLog, 'utf8'), /--connect-timeout 10/);
    assert.match(readFileSync(argsLog, 'utf8'), /--max-time 30/);
  });

  it('removes its temporary clone after persistence fails', () => {
    const root = fixture();
    const bin = join(root, 'bin');
    mkdirSync(bin);
    executable(join(bin, 'git'), '#!/usr/bin/env bash\nexit 1\n');
    const project = join(root, 'project');
    mkdirSync(project);
    const result = spawnSync('bash', [join(scriptsDir, 'persist-skill.sh'), '--path', 'skills/turnstile-spin/SKILL.md'], {
      cwd: project,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: root, GITHUB_TOKEN: 'must-not-survive' },
    });

    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).reason, 'clone_failed');
    assert.deepEqual(readdirSync(root).filter((name) => name.startsWith('turnstile-spin-persist.')), []);
  });
});
