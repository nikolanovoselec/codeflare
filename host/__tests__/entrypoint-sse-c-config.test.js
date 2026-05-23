// Real behavioral test for REQ-SEC-005 AC4: when ENCRYPTION_KEY is set,
// the entrypoint's create_rclone_config function appends sse_customer_key_base64
// and sse_customer_algorithm to ~/.config/rclone/rclone.conf so all rclone
// operations transparently use R2 SSE-C encryption.
//
// Strategy: extract the create_rclone_config function body from entrypoint.sh,
// wrap it in a harness that sets a temp USER_HOME and exports the required
// R2_* + ENCRYPTION_KEY vars, run it in a bash subshell, then read back the
// generated rclone.conf and assert on the actual file contents.
//
// Same approach as entrypoint-bisync-behavior.test.js — exercise the real
// shell function, not a text-match of the source.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENTRYPOINT = resolve(__dirname, '../../entrypoint.sh');

function extractCreateRcloneConfigBody() {
  const src = readFileSync(ENTRYPOINT, 'utf8');
  const lines = src.split('\n');
  let start = -1;
  let end = -1;
  for (let i = 0; i < lines.length; i++) {
    if (start === -1 && /^create_rclone_config\(\) \{/.test(lines[i])) {
      start = i;
    } else if (start !== -1 && /^\}$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  if (start === -1 || end === -1) {
    throw new Error('Could not locate create_rclone_config() in entrypoint.sh');
  }
  return lines.slice(start, end + 1).join('\n');
}

function runHarness({ encryptionKey, accessKeyId = 'abcdef0123456789', secretAccessKey = 'fedcba9876543210' }) {
  const dir = mkdtempSync(join(tmpdir(), 'rclone-config-harness-'));
  const body = extractCreateRcloneConfigBody();
  const envExports = [
    `export USER_HOME='${dir}'`,
    `export R2_ACCESS_KEY_ID='${accessKeyId}'`,
    `export R2_SECRET_ACCESS_KEY='${secretAccessKey}'`,
    `export R2_BUCKET_NAME='test-bucket'`,
    `export R2_ENDPOINT='https://test-account.r2.cloudflarestorage.com'`,
  ];
  if (encryptionKey !== undefined) {
    envExports.push(`export ENCRYPTION_KEY='${encryptionKey}'`);
  }
  const script = [
    '#!/usr/bin/env bash',
    'set -e',
    ...envExports,
    body,
    'create_rclone_config',
  ].join('\n');
  const scriptPath = join(dir, 'harness.sh');
  writeFileSync(scriptPath, script, { mode: 0o755 });
  const result = spawnSync('bash', [scriptPath], { encoding: 'utf8', timeout: 10_000 });
  return { dir, result };
}

describe('entrypoint.sh create_rclone_config / REQ-SEC-005 AC4 (entrypoint appends sse_customer_key_base64 + sse_customer_algorithm to rclone.conf when ENCRYPTION_KEY is set)', () => {
  it('appends sse_customer_key_base64 and sse_customer_algorithm = AES256 when ENCRYPTION_KEY is exported', () => {
    const { dir, result } = runHarness({ encryptionKey: 'YXNkZmFzZGZhc2RmYXNkZmFzZGZhc2RmYXNkZg==' });
    assert.equal(result.status, 0, `create_rclone_config exited non-zero: ${result.stderr}`);
    const conf = readFileSync(join(dir, '.config/rclone/rclone.conf'), 'utf8');
    assert.match(conf, /^sse_customer_key_base64 = YXNkZmFzZGZhc2RmYXNkZmFzZGZhc2RmYXNkZg==$/m,
      'sse_customer_key_base64 line must be appended with the exact ENCRYPTION_KEY value');
    assert.match(conf, /^sse_customer_algorithm = AES256$/m,
      'sse_customer_algorithm = AES256 line must be appended');
  });

  it('does NOT append SSE-C lines when ENCRYPTION_KEY is unset (no code path changes per AC7)', () => {
    const { dir, result } = runHarness({ encryptionKey: undefined });
    assert.equal(result.status, 0, `create_rclone_config exited non-zero: ${result.stderr}`);
    const conf = readFileSync(join(dir, '.config/rclone/rclone.conf'), 'utf8');
    assert.doesNotMatch(conf, /sse_customer_key_base64/,
      'sse_customer_key_base64 must NOT appear when ENCRYPTION_KEY is unset');
    assert.doesNotMatch(conf, /sse_customer_algorithm/,
      'sse_customer_algorithm must NOT appear when ENCRYPTION_KEY is unset');
  });

  it('does NOT append SSE-C lines when ENCRYPTION_KEY is exported but empty (REQ-SEC-005 AC7 no-op path)', () => {
    const { dir, result } = runHarness({ encryptionKey: '' });
    assert.equal(result.status, 0, `create_rclone_config exited non-zero: ${result.stderr}`);
    const conf = readFileSync(join(dir, '.config/rclone/rclone.conf'), 'utf8');
    assert.doesNotMatch(conf, /sse_customer_key_base64/);
    assert.doesNotMatch(conf, /sse_customer_algorithm/);
  });

  it('writes the base [r2] config block with substituted access_key_id / secret_access_key / endpoint regardless of ENCRYPTION_KEY (REQ-SEC-005 AC7 base path)', () => {
    const { dir, result } = runHarness({ encryptionKey: undefined, accessKeyId: 'deadbeefcafebabe', secretAccessKey: 'aaaaaaaaaaaaaaaa' });
    assert.equal(result.status, 0, `create_rclone_config exited non-zero: ${result.stderr}`);
    const conf = readFileSync(join(dir, '.config/rclone/rclone.conf'), 'utf8');
    assert.match(conf, /^\[r2\]$/m);
    assert.match(conf, /^access_key_id = deadbeefcafebabe$/m);
    assert.match(conf, /^secret_access_key = aaaaaaaaaaaaaaaa$/m);
    assert.match(conf, /^endpoint = https:\/\/test-account\.r2\.cloudflarestorage\.com$/m);
  });
});
