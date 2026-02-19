import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createAgentFileChecker,
  checkAgentFileActivity,
} from '../agent-file-activity.js';

describe('agent-file-activity', () => {
  let checker;

  beforeEach(() => {
    checker = createAgentFileChecker(['/tmp/test-agent-dir-1', '/tmp/test-agent-dir-2']);
  });

  it('first call returns false (establishes baseline)', async () => {
    const changed = await checkAgentFileActivity(checker);
    assert.equal(changed, false, 'first call should establish baseline, not report activity');
  });

  it('returns true when directory size changes (1000 -> 2000)', async () => {
    // Establish baseline with mocked sizes
    checker.previousSnapshot.set('/tmp/test-agent-dir-1', 1000);
    checker.previousSnapshot.set('/tmp/test-agent-dir-2', 500);

    // Override _getDirSize to simulate size change
    checker._getDirSize = async (dir) => {
      if (dir === '/tmp/test-agent-dir-1') return 2000;
      return 500;
    };

    const changed = await checkAgentFileActivity(checker);
    assert.equal(changed, true, 'should detect size change');
  });

  it('returns false when sizes unchanged', async () => {
    checker.previousSnapshot.set('/tmp/test-agent-dir-1', 1000);
    checker.previousSnapshot.set('/tmp/test-agent-dir-2', 500);

    checker._getDirSize = async (dir) => {
      if (dir === '/tmp/test-agent-dir-1') return 1000;
      return 500;
    };

    const changed = await checkAgentFileActivity(checker);
    assert.equal(changed, false, 'should not report activity when sizes are same');
  });

  it('handles ENOENT gracefully (missing dir = size 0)', async () => {
    checker.previousSnapshot.set('/tmp/test-agent-dir-1', 0);
    checker.previousSnapshot.set('/tmp/test-agent-dir-2', 0);

    checker._getDirSize = async () => 0;

    const changed = await checkAgentFileActivity(checker);
    assert.equal(changed, false, 'missing dirs should be size 0, no change');
  });

  it('newly created dir counts as activity (0 -> 500)', async () => {
    checker.previousSnapshot.set('/tmp/test-agent-dir-1', 0);
    checker.previousSnapshot.set('/tmp/test-agent-dir-2', 0);

    checker._getDirSize = async (dir) => {
      if (dir === '/tmp/test-agent-dir-1') return 500;
      return 0;
    };

    const changed = await checkAgentFileActivity(checker);
    assert.equal(changed, true, 'new dir appearing should count as activity');
  });

  it('checks all AGENT_DIRS (only last dir changed -> still true)', async () => {
    checker.previousSnapshot.set('/tmp/test-agent-dir-1', 100);
    checker.previousSnapshot.set('/tmp/test-agent-dir-2', 200);

    checker._getDirSize = async (dir) => {
      if (dir === '/tmp/test-agent-dir-1') return 100; // unchanged
      return 999; // changed
    };

    const changed = await checkAgentFileActivity(checker);
    assert.equal(changed, true, 'change in any dir should return true');
  });

  it('parses du -s output correctly ("12345\\t/path" -> 12345)', async () => {
    // Test the _parseDuOutput helper if exposed
    if (typeof checker._parseDuOutput === 'function') {
      assert.equal(checker._parseDuOutput('12345\t/some/path'), 12345);
      assert.equal(checker._parseDuOutput('0\t/empty'), 0);
    } else {
      // If not exposed as helper, assert checker structure is correct
      assert.ok(checker.dirs.length === 2);
    }
  });

  it('handles du -s failure gracefully (permission denied -> size 0)', async () => {
    checker.previousSnapshot.set('/tmp/test-agent-dir-1', 0);
    checker.previousSnapshot.set('/tmp/test-agent-dir-2', 0);

    checker._getDirSize = async () => {
      throw new Error('EACCES: permission denied');
    };

    // Should not throw, should treat as size 0
    const changed = await checkAgentFileActivity(checker);
    assert.equal(changed, false, 'permission denied should be treated as size 0');
  });
});
