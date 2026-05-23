import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createActivityTracker } from '../dist/activity-tracker.js';

describe('activity-tracker / REQ-SESSION-005 (idle/active state transitions with debounced HTTP notify to DO)', () => {
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

  it('lastHeartbeatAt is null initially', () => {
    const sessionManager = { clients: new Map(), sessions: new Map() };
    const info = tracker.getActivityInfo(sessionManager);
    assert.equal(info.lastHeartbeatAt, null);
  });

  it('recordHeartbeat sets lastHeartbeatAt to current time', () => {
    const before = Date.now();
    tracker.recordHeartbeat();
    const after = Date.now();
    const sessionManager = { clients: new Map(), sessions: new Map() };
    const info = tracker.getActivityInfo(sessionManager);
    assert.ok(info.lastHeartbeatAt >= before);
    assert.ok(info.lastHeartbeatAt <= after);
  });

  it('recordHeartbeat does NOT affect lastInputAt', () => {
    tracker.recordHeartbeat();
    const sessionManager = { clients: new Map(), sessions: new Map() };
    const info = tracker.getActivityInfo(sessionManager);
    assert.equal(info.lastInputAt, null, 'lastInputAt should remain null');
    assert.notEqual(info.lastHeartbeatAt, null, 'lastHeartbeatAt should be set');
  });

  it('recordInput does NOT affect lastHeartbeatAt', () => {
    tracker.recordInput();
    const sessionManager = { clients: new Map(), sessions: new Map() };
    const info = tracker.getActivityInfo(sessionManager);
    assert.notEqual(info.lastInputAt, null, 'lastInputAt should be set');
    assert.equal(info.lastHeartbeatAt, null, 'lastHeartbeatAt should remain null');
  });

  it('multiple recordHeartbeat calls update timestamp', async () => {
    tracker.recordHeartbeat();
    const sessionManager = { clients: new Map(), sessions: new Map() };
    const first = tracker.getActivityInfo(sessionManager).lastHeartbeatAt;
    await new Promise(r => setTimeout(r, 50));
    tracker.recordHeartbeat();
    const second = tracker.getActivityInfo(sessionManager).lastHeartbeatAt;
    assert.ok(second > first, 'second heartbeat should have later timestamp');
  });
});
