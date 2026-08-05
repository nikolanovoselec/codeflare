import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const SCRIPT = join(ROOT, 'scripts', 'ci', 'normalize-https-origin.mjs');

function normalize(input) {
  return spawnSync(process.execPath, [SCRIPT, input], { encoding: 'utf8' });
}

describe('pentest target normalization', () => {
  it('canonicalizes a bare or HTTP hostname to one HTTPS origin', () => {
    for (const [input, expected] of [
      ['codeflare.ch', 'https://codeflare.ch'],
      ['http://Codeflare.ch', 'https://codeflare.ch'],
      ['https://integration.example.com:8443/', 'https://integration.example.com:8443'],
    ]) {
      const result = normalize(input);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), expected);
    }
  });

  it('writes a validated named workflow output when requested', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'normalized-origin-'));
    const output = join(cwd, 'github-output');
    try {
      const result = spawnSync(process.execPath, [SCRIPT, 'http://Codeflare.ch', 'target'], {
        encoding: 'utf8',
        env: { ...process.env, GITHUB_OUTPUT: output },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, '');
      assert.equal(readFileSync(output, 'utf8'), 'target=https://codeflare.ch\n');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('rejects invalid output contracts', () => {
    for (const [name, env] of [
      ['bad-name', { GITHUB_OUTPUT: '/tmp/output' }],
      ['target', { GITHUB_OUTPUT: '' }],
    ]) {
      const result = spawnSync(process.execPath, [SCRIPT, 'https://codeflare.ch', name], {
        encoding: 'utf8',
        env: { ...process.env, ...env },
      });
      assert.notEqual(result.status, 0);
    }
  });

  it('rejects values that are not a plain public HTTPS origin', () => {
    for (const input of [
      '',
      'https://example.com/api',
      'https://user:pass@example.com',
      'https://example.com?next=evil',
      'https://example.com#fragment',
      'https://example.com\nNODE_OPTIONS=--require=/tmp/evil',
      'https://localhost',
      'https://127.0.0.1',
      'https://example.com:0',
      'ftp://example.com',
    ]) {
      const result = normalize(input);
      assert.notEqual(result.status, 0, input);
      assert.equal(result.stdout, '', input);
    }
  });
});
