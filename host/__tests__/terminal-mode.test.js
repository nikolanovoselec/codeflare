import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isPrewarmTimeoutReady, resolveHostTerminalConfig } from '../dist/terminal-mode.js';

describe('host terminal mode', () => {
  it('defaults missing and invalid values to classic login Bash', () => {
    assert.deepEqual(resolveHostTerminalConfig({}), {
      mode: 'classic', command: '/bin/bash', args: '-l',
    });
    assert.equal(resolveHostTerminalConfig({ CODEFLARE_TERMINAL_MODE: 'invalid' }).mode, 'classic');
  });

  it('selects the fixed Herdr launcher without shell arguments', () => {
    assert.deepEqual(resolveHostTerminalConfig({ CODEFLARE_TERMINAL_MODE: 'herdr' }), {
      mode: 'herdr', command: '/usr/local/bin/codeflare-herdr-terminal', args: '',
    });
  });

  it('retains explicit test and development command overrides', () => {
    assert.deepEqual(resolveHostTerminalConfig({
      CODEFLARE_TERMINAL_MODE: 'herdr', TERMINAL_COMMAND: '/tmp/fake', TERMINAL_ARGS: '--test',
    }), { mode: 'herdr', command: '/tmp/fake', args: '--test' });
  });

  it('REQ-TERM-035 AC2: timeout never reports Herdr ready before bootstrap', () => {
    assert.equal(isPrewarmTimeoutReady('classic', false), true);
    assert.equal(isPrewarmTimeoutReady('herdr', false), false);
    assert.equal(isPrewarmTimeoutReady('herdr', true), true);
  });
});
