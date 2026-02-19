import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createActivityTracker } from '../activity-tracker.js';

describe('activity-tracker', () => {
  let tracker;

  beforeEach(() => {
    tracker = createActivityTracker();
  });

  it('initial state: disconnectedForMs close to 0, hasActiveConnections false', () => {
    const sessionManager = { clients: new Map(), sessions: new Map() };
    const info = tracker.getActivityInfo(sessionManager);
    assert.equal(info.hasActiveConnections, false);
    assert.equal(typeof info.disconnectedForMs, 'number');
    assert.ok(info.disconnectedForMs < 100, 'disconnectedForMs should be close to 0 initially');
  });

  it('after recordClientConnected: disconnectedForMs is null when clients > 0', () => {
    tracker.recordClientConnected();
    const sessionManager = { clients: new Map([['ws1', {}]]), sessions: new Map() };
    const info = tracker.getActivityInfo(sessionManager);
    assert.equal(info.hasActiveConnections, true);
    assert.equal(info.disconnectedForMs, null);
  });

  it('after recordAllClientsDisconnected: disconnectedForMs grows over time', async () => {
    tracker.recordClientConnected();
    tracker.recordAllClientsDisconnected();
    await new Promise(r => setTimeout(r, 50));
    const sessionManager = { clients: new Map(), sessions: new Map() };
    const info = tracker.getActivityInfo(sessionManager);
    assert.equal(info.hasActiveConnections, false);
    assert.ok(info.disconnectedForMs >= 40, 'disconnectedForMs should have grown');
  });

  it('reconnect clears timer: disconnect then connect makes disconnectedForMs null', () => {
    tracker.recordAllClientsDisconnected();
    tracker.recordClientConnected();
    const sessionManager = { clients: new Map([['ws1', {}]]), sessions: new Map() };
    const info = tracker.getActivityInfo(sessionManager);
    assert.equal(info.disconnectedForMs, null);
  });

  it('multiple attach/detach cycles: timer only starts on last client leaving', () => {
    // Two clients connect
    tracker.recordClientConnected();
    tracker.recordClientConnected();
    // One disconnects but global count not zero — no recordAllClientsDisconnected called
    // Second disconnects — now recordAllClientsDisconnected is called
    tracker.recordAllClientsDisconnected();

    const sessionManager = { clients: new Map(), sessions: new Map() };
    const info = tracker.getActivityInfo(sessionManager);
    assert.equal(info.hasActiveConnections, false);
    assert.equal(typeof info.disconnectedForMs, 'number');
    assert.ok(info.disconnectedForMs < 100);
  });

  it('returns activeSessions count from sessionManager', () => {
    const mockSession1 = { ptyProcess: {} };
    const mockSession2 = { ptyProcess: null };
    const sessionManager = {
      clients: new Map(),
      sessions: new Map([['s1', mockSession1], ['s2', mockSession2]]),
    };
    const info = tracker.getActivityInfo(sessionManager);
    assert.equal(info.activeSessions, 1);
  });

  it('handles null sessionManager gracefully', () => {
    const info = tracker.getActivityInfo(null);
    assert.equal(info.hasActiveConnections, false);
    assert.equal(info.connectedClients, 0);
    assert.equal(info.activeSessions, 0);
  });

  it('response has NO lastUserInputMs or lastAgentFileActivityMs', () => {
    const sessionManager = { clients: new Map(), sessions: new Map() };
    const info = tracker.getActivityInfo(sessionManager);
    assert.equal('lastUserInputMs' in info, false);
    assert.equal('lastAgentFileActivityMs' in info, false);
    assert.equal('lastPtyOutputMs' in info, false);
    assert.equal('lastWsActivityMs' in info, false);
  });
});
