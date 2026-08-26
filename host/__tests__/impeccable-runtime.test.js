import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../..');
const skillRoots = [
  'preseed/agents/claude/skills/impeccable',
  'preseed/agents/pi/skills/impeccable',
];

function runSkill(skillRoot, script, args, cwd) {
  return spawnSync(process.execPath, [resolve(root, skillRoot, 'scripts', script), ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 5000,
  });
}

describe('REQ-AGENT-163: Impeccable browser-question lifecycle', () => {
  it('keeps wait clients alive throughout the configured idle grace', () => {
    for (const skillRoot of skillRoots) {
      const cwd = mkdtempSync(join(tmpdir(), 'codeflare-impeccable-wait-'));
      try {
        const questions = join(cwd, '.impeccable', 'questions');
        mkdirSync(questions, { recursive: true });
        writeFileSync(join(questions, 'choice.state.json'), JSON.stringify({
          pid: process.pid,
          lastBeat: Date.now() - 20_000,
        }));

        const result = runSkill(skillRoot, 'serve-question.mjs', [
          '--wait', '--key', 'choice', '--poll', '0.1', '--idle-grace', '60',
        ], cwd);

        assert.equal(result.signal, null, result.stderr);
        assert.equal(result.status, 3, result.stderr || result.stdout);
        assert.match(result.stdout, /WAITING: no answer yet/);
        assert.doesNotMatch(result.stdout, /PAGE CLOSED/);

        const expired = runSkill(skillRoot, 'serve-question.mjs', [
          '--wait', '--key', 'choice', '--poll', '0.1', '--idle-grace', '0.01',
        ], cwd);
        assert.equal(expired.signal, null, expired.stderr);
        assert.equal(expired.status, 4, expired.stderr || expired.stdout);
        assert.match(expired.stdout, /PAGE CLOSED/);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    }
  });

  it('delivers a validated next hand and bounds its closed-page grace', () => {
    for (const skillRoot of skillRoots) {
      const cwd = mkdtempSync(join(tmpdir(), 'codeflare-impeccable-update-'));
      try {
        const questions = join(cwd, '.impeccable', 'questions');
        mkdirSync(questions, { recursive: true });
        writeFileSync(join(questions, 'choice.state.json'), JSON.stringify({
          pid: process.pid,
          lastBeat: Date.now() - 20_000,
        }));
        const payload = join(cwd, 'next.json');
        const nextFile = join(questions, 'choice.next.json');
        writeFileSync(payload, JSON.stringify({ options: [] }));
        const rejected = runSkill(skillRoot, 'serve-question.mjs', [
          '--update', '--key', 'choice', '--payload', payload,
        ], cwd);
        assert.equal(rejected.status, 1, rejected.stderr || rejected.stdout);
        assert.match(rejected.stderr, /payload needs an options array/);
        assert.equal(existsSync(nextFile), false);

        writeFileSync(payload, JSON.stringify({ options: [{ id: 'next', label: 'Next' }] }));
        const delivered = runSkill(skillRoot, 'serve-question.mjs', [
          '--update', '--key', 'choice', '--payload', payload,
        ], cwd);
        assert.equal(delivered.status, 0, delivered.stderr || delivered.stdout);
        assert.match(delivered.stdout, /next round delivered/);

        const protectedWait = runSkill(skillRoot, 'serve-question.mjs', [
          '--wait', '--key', 'choice', '--poll', '0.1', '--idle-grace', '0.01',
        ], cwd);
        assert.equal(protectedWait.status, 3, protectedWait.stderr || protectedWait.stdout);
        assert.match(protectedWait.stdout, /WAITING: no answer yet/);

        const expiredAt = new Date(Date.now() - 20_000);
        utimesSync(nextFile, expiredAt, expiredAt);
        const expiredWait = runSkill(skillRoot, 'serve-question.mjs', [
          '--wait', '--key', 'choice', '--poll', '0.1', '--idle-grace', '0.01',
        ], cwd);
        assert.equal(expiredWait.status, 4, expiredWait.stderr || expiredWait.stdout);
        assert.match(expiredWait.stdout, /PAGE CLOSED/);

        rmSync(nextFile);
        writeFileSync(join(questions, 'choice.state.json'), JSON.stringify({
          pid: process.pid,
          lastBeat: Date.now() - 20_000,
          claimedAt: Date.now(),
        }));
        const claimedWait = runSkill(skillRoot, 'serve-question.mjs', [
          '--wait', '--key', 'choice', '--poll', '0.1', '--idle-grace', '0.01',
        ], cwd);
        assert.equal(claimedWait.status, 3, claimedWait.stderr || claimedWait.stdout);
        assert.match(claimedWait.stdout, /WAITING: no answer yet/);

        writeFileSync(join(questions, 'choice.state.json'), JSON.stringify({
          pid: process.pid,
          lastBeat: Date.now() - 20_000,
          claimedAt: Date.now() - 20_000,
        }));
        const expiredClaim = runSkill(skillRoot, 'serve-question.mjs', [
          '--wait', '--key', 'choice', '--poll', '0.1', '--idle-grace', '0.01',
        ], cwd);
        assert.equal(expiredClaim.status, 4, expiredClaim.stderr || expiredClaim.stdout);
        assert.match(expiredClaim.stdout, /PAGE CLOSED/);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    }
  });
});

describe('REQ-AGENT-164: Impeccable prompt-metadata audit', () => {
  it('skips broken and cyclic symlinks while retaining missing-metadata exit status', () => {
    for (const skillRoot of skillRoots) {
      const cwd = mkdtempSync(join(tmpdir(), 'codeflare-impeccable-scan-'));
      try {
        const assets = join(cwd, 'assets');
        mkdirSync(assets);
        writeFileSync(join(assets, 'missing.png'), Buffer.from('not-a-png'));
        const nested = join(assets, 'nested');
        mkdirSync(nested);
        const png = join(nested, 'provenanced.png');
        const jpeg = join(nested, 'provenanced.jpg');
        const webp = join(nested, 'provenanced.webp');
        writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
        writeFileSync(jpeg, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
        writeFileSync(webp, Buffer.from('RIFF'));
        for (const raster of [png, jpeg, webp]) {
          const embedded = runSkill(skillRoot, 'embed-prompt.mjs', [raster, '--prompt', 'source intent'], cwd);
          assert.equal(embedded.status, 0, embedded.stderr || embedded.stdout);
        }
        mkdirSync(join(assets, '.hidden'));
        writeFileSync(join(assets, '.hidden', 'ignored.png'), Buffer.from('not-a-png'));
        mkdirSync(join(assets, 'node_modules'));
        writeFileSync(join(assets, 'node_modules', 'ignored.webp'), Buffer.from('RIFF'));
        symlinkSync('absent.png', join(assets, 'broken.png'));
        symlinkSync('.', join(assets, 'cycle'));

        const result = runSkill(skillRoot, 'embed-prompt.mjs', ['--scan', assets], cwd);

        assert.equal(result.signal, null, result.stderr);
        assert.equal(result.status, 3, result.stderr || result.stdout);
        assert.equal(result.stderr, '');
        assert.match(result.stdout, /MISSING: .*missing\.png/);
        assert.doesNotMatch(result.stdout, /provenanced\.(png|jpe?g|webp)/);
        assert.match(result.stdout, /SCAN: 4 rasters, 1 missing/);

        const rootLink = join(cwd, 'linked-assets');
        symlinkSync(assets, rootLink);
        const linked = runSkill(skillRoot, 'embed-prompt.mjs', ['--scan', rootLink], cwd);
        assert.equal(linked.status, 1, linked.stderr || linked.stdout);
        assert.match(linked.stderr, /scan target cannot be a symbolic link/);

        const invalid = runSkill(skillRoot, 'embed-prompt.mjs', [
          '--scan', join(cwd, 'absent'),
        ], cwd);
        assert.equal(invalid.status, 1, invalid.stderr || invalid.stdout);
        assert.match(invalid.stderr, /no such path/);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    }
  });
});
