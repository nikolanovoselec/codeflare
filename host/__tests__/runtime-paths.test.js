import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  CODEFLARE_RUNTIME_ROOT,
  OPENVSCODE_REQUEST_TRIGGER,
  OPENVSCODE_RUNTIME_DIR,
  SERVICES_RUNTIME_DIR,
  SYNC_DAEMON_PID_FILE,
  SYNC_LOG_FILE,
  SYNC_RUNTIME_DIR,
  SYNC_STATUS_FILE,
} from '../dist/runtime-paths.js';

describe('REQ-OPS-047: cleanup-safe container runtime state', () => {
  it('keeps required host runtime paths outside disposable /tmp', () => {
    assert.equal(CODEFLARE_RUNTIME_ROOT, '/run/codeflare');
    for (const path of [
      SYNC_RUNTIME_DIR,
      SERVICES_RUNTIME_DIR,
      OPENVSCODE_RUNTIME_DIR,
      SYNC_DAEMON_PID_FILE,
      SYNC_STATUS_FILE,
      SYNC_LOG_FILE,
      OPENVSCODE_REQUEST_TRIGGER,
    ]) {
      assert.ok(path.startsWith(`${CODEFLARE_RUNTIME_ROOT}/`), `${path} must be process-lifetime state`);
      assert.ok(!path.startsWith('/tmp/'), `${path} must survive disposable /tmp cleanup`);
    }
  });
});
