import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { preparePrimaryDashboard } from '../../image/chat/primary-identity.mjs';

const homes = [];
afterEach(() => { for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true }); });
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-chat-startup-'));
  homes.push(home);
  return { home, directory: path.join(home, '.pi/dashboard'), file: path.join(home, '.pi/dashboard/config.json') };
}
function existing(value, mode = 0o600) {
  const result = fixture();
  fs.mkdirSync(result.directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(result.file, value, { mode });
  fs.chmodSync(result.file, mode);
  return result;
}

describe('REQ-AGENT-224 AC3: managed primary public Dashboard startup configuration', () => {
  it('writes the public standalone auto-start policy without creating Pi settings', () => {
    const { home, directory, file } = fixture();
    preparePrimaryDashboard(home);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { autoStart: false });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    assert.equal(fs.existsSync(path.join(home, '.pi/agent/settings.json')), false);
    assert.deepEqual(fs.readdirSync(directory), ['config.json']);
  });

  for (const mode of [0o600, 0o400]) {
    it(`preserves unrelated public fields and restrictive ${mode.toString(8)} permissions across repeated preparation`, () => {
      const prior = { autoStart: true, port: 8000, bridge: { enabled: false },
        auth: { providers: { example: { enabled: true } } }, unknownFutureOption: { values: [1, null, 'keep'] } };
      const { home, file } = existing(JSON.stringify(prior), mode);
      preparePrimaryDashboard(home);
      preparePrimaryDashboard(home);
      assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { ...prior, autoStart: false });
      assert.equal(fs.statSync(file).mode & 0o777, mode);
    });
  }

  it('does not widen a preexisting config and keeps its contents private', () => {
    const { home, file } = existing('{"autoStart":true,"port":8123}', 0o640);
    preparePrimaryDashboard(home);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { autoStart: false, port: 8123 });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });

  it('retains an already configured document byte-for-byte', () => {
    const text = '{\n  "autoStart": false, "future": [true]\n}\n';
    const { home, file } = existing(text);
    preparePrimaryDashboard(home);
    assert.equal(fs.readFileSync(file, 'utf8'), text);
  });

  for (const text of ['{"privateValue":"not-for-diagnostics",', 'null', '[]', 'false', '"not-for-diagnostics"']) {
    it('refuses invalid/non-object config without replacing it or exposing its contents', () => {
      const { home, file } = existing(text);
      assert.throws(() => preparePrimaryDashboard(home), error => {
        assert.equal(error.message, 'Codeflare: private Chat startup configuration could not be prepared');
        return true;
      });
      assert.equal(fs.readFileSync(file, 'utf8'), text);
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.deepEqual(fs.readdirSync(path.dirname(file)), ['config.json']);
    });
  }

  it('does not follow a linked config or modify its target', () => {
    const { home, directory, file } = fixture();
    fs.mkdirSync(directory, { recursive: true });
    const target = path.join(home, 'unrelated.json');
    const text = '{"autoStart":true,"unrelated":true}';
    fs.writeFileSync(target, text, { mode: 0o600 });
    fs.symlinkSync(target, file);
    assert.throws(() => preparePrimaryDashboard(home));
    assert.equal(fs.lstatSync(file).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(target, 'utf8'), text);
  });

  it('does not follow a linked Dashboard directory', () => {
    const { home, directory } = fixture();
    fs.mkdirSync(path.join(home, '.pi'));
    const target = path.join(home, 'unrelated'); fs.mkdirSync(target);
    fs.symlinkSync(target, directory);
    assert.throws(() => preparePrimaryDashboard(home));
    assert.deepEqual(fs.readdirSync(target), []);
  });
});
