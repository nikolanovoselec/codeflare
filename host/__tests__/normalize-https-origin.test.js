import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
