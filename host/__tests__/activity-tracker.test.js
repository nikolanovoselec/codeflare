import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createActivityTracker } from '../activity-tracker.js';

describe('activity-tracker', () => {
  let tracker;

  beforeEach(() => {
    tracker = createActivityTracker();
  });

  it('initial timestamps are Date.now() (within 100ms)', () => {
    const now = Date.now();
    assert.ok(
      Math.abs(tracker.lastUserInputTimestamp - now) < 100,
      'lastUserInputTimestamp should be close to Date.now()',
    );
    assert.ok(
      Math.abs(tracker.lastAgentFileActivityTimestamp - now) < 100,
      'lastAgentFileActivityTimestamp should be close to Date.now()',
    );
  });

  it('recordUserInput updates lastUserInputTimestamp', async () => {
    const before = tracker.lastUserInputTimestamp;
    await new Promise((r) => setTimeout(r, 10));
    tracker.recordUserInput();
    assert.ok(
      tracker.lastUserInputTimestamp > before,
      'lastUserInputTimestamp should advance after recordUserInput()',
    );
  });

  it('recordUserInput does NOT update lastAgentFileActivityTimestamp', async () => {
    const before = tracker.lastAgentFileActivityTimestamp;
    await new Promise((r) => setTimeout(r, 10));
    tracker.recordUserInput();
    assert.equal(
      tracker.lastAgentFileActivityTimestamp,
      before,
      'lastAgentFileActivityTimestamp should not change on user input',
    );
  });

  it('getActivityInfo returns lastUserInputMs', () => {
    const sessionManager = { clients: new Map() };
    const info = tracker.getActivityInfo(sessionManager);
    assert.ok(
      'lastUserInputMs' in info,
      'response must include lastUserInputMs',
    );
    assert.equal(typeof info.lastUserInputMs, 'number');
  });

  it('getActivityInfo returns lastAgentFileActivityMs', () => {
    const sessionManager = { clients: new Map() };
    const info = tracker.getActivityInfo(sessionManager);
    assert.ok(
      'lastAgentFileActivityMs' in info,
      'response must include lastAgentFileActivityMs',
    );
    assert.equal(typeof info.lastAgentFileActivityMs, 'number');
  });

  it('getActivityInfo returns hasActiveConnections true when clients > 0', () => {
    const sessionManager = { clients: new Map([['ws1', {}]]) };
    const info = tracker.getActivityInfo(sessionManager);
    assert.equal(info.hasActiveConnections, true);
  });

  it('getActivityInfo returns hasActiveConnections false when clients = 0', () => {
    const sessionManager = { clients: new Map() };
    const info = tracker.getActivityInfo(sessionManager);
    assert.equal(info.hasActiveConnections, false);
  });

  it('response has NO lastPtyOutputMs or lastWsActivityMs', () => {
    const sessionManager = { clients: new Map() };
    const info = tracker.getActivityInfo(sessionManager);
    assert.equal(
      'lastPtyOutputMs' in info,
      false,
      'response must NOT include lastPtyOutputMs (old field)',
    );
    assert.equal(
      'lastWsActivityMs' in info,
      false,
      'response must NOT include lastWsActivityMs (old field)',
    );
  });
});
