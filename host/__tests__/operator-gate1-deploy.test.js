import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('Gate 1 fixture deployment', () => {
  it('Wrangler resolves and bundles the stateless fixture configuration', () => {
    const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeflare-gate1-dry-run-'));
    try {
      const result = spawnSync('npx', ['--no-install', 'wrangler', 'deploy', '--dry-run',
        '--config', 'fixtures/operator-gate1/wrangler.toml', '--outdir', outdir], {
        cwd: root, encoding: 'utf8', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
      });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const emitted = fs.readdirSync(outdir, { recursive: true }).map(String);
      assert.ok(emitted.some(file => file.endsWith('.js')), `No Worker bundle emitted: ${emitted.join(', ')}`);
      assert.match(`${result.stdout}\n${result.stderr}`, /No bindings found/i);
    } finally {
      fs.rmSync(outdir, { recursive: true, force: true });
    }
  });
});
