// REQ-OPS-005: the weekly pentest's legacy-TLS check must report on the server,
// not on whatever the runner's TLS library is willing to offer.
//
// Each case stands up a TCP server that answers a real ClientHello with one of
// the four things a server can do, and asserts the probe's exit code. The two
// that matter are opposites: a refusing server must pass, and an ACCEPTING
// server must fail. Without the accepting case a probe that always printed PASS
// would look correct, which is exactly how this check shipped broken twice.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROBE = resolve(__dirname, '../../scripts/ci/tls-legacy-probe.py');

const EXIT = { refused: 0, accepted: 1, inconclusive: 2 };

// A fatal alert record: content type 21, TLS 1.0, level fatal, protocol_version.
const ALERT_PROTOCOL_VERSION = Buffer.from([0x15, 0x03, 0x01, 0x00, 0x02, 0x02, 0x46]);
// The same record shape carrying handshake_failure(40) instead. This is what a
// server that DOES speak the version answers when it likes none of the offered
// suites, so it must never be read as a refusal of the version.
const ALERT_HANDSHAKE_FAILURE = Buffer.from([0x15, 0x03, 0x01, 0x00, 0x02, 0x02, 0x28]);
// A handshake record whose body is a ServerHello: the server agreed to speak it.
// The record layer says 3.3 and the ServerHello says 3.1 ON PURPOSE. Servers set
// the record-layer version for compatibility and it is routinely not what was
// negotiated, so a probe reading the wrong one reports a version the server
// never chose. Only the body's 3.1 may reach the verdict message.
const SERVER_HELLO = Buffer.from([
  0x16, 0x03, 0x03, 0x00, 0x06, // record: handshake, layer version 3.3, length 6
  0x02, 0x00, 0x00, 0x02, // handshake: ServerHello, body length 2
  0x03, 0x01, // negotiated version: 3.1
]);

/**
 * Serve one canned reply, or close on null, then stop.
 *
 * The probe hangs up the moment it has its verdict, which resets a connection
 * this side has not finished with. That arrives as an 'error' event, and an
 * unhandled one on a socket takes down the whole runner -- so the expected
 * hangup is swallowed here rather than left to crash every later case.
 */
function serveOnce(reply) {
  return new Promise((ready, fail) => {
    const server = net.createServer((socket) => {
      socket.on('error', () => {});
      socket.once('data', () => {
        if (reply) socket.write(reply);
        socket.end();
      });
    });
    // Only the per-connection hangup above is expected. A listen failure is
    // not, and swallowing it here would leave this promise unsettled so the
    // case hung to the runner timeout instead of naming its cause.
    server.on('error', fail);
    server.listen(0, '127.0.0.1', () => ready(server));
  });
}

/**
 * Run the probe against a listener in THIS process, so it must not block the
 * event loop: a synchronous spawn would stop the server above from ever
 * accepting the connection, and every case would time out rather than being
 * answered. The probe resolves its own port from the host argument's suffix.
 */
function runProbeArgs(args) {
  return new Promise((settle) => {
    execFile('python3', [PROBE, ...args], { encoding: 'utf8' }, (error, stdout, stderr) => {
      // error.code is the exit status on a normal exit, but 'ENOENT' when
      // python3 is missing and undefined when the child is signalled. Both of
      // those produce empty output, so the reason is carried in `detail` or the
      // case fails as a bare value mismatch with nothing to go on.
      const status = error ? (error.code ?? `signal:${error.signal}`) : 0;
      settle({ status, stdout, stderr, detail: error ? String(error) : '' });
    });
  });
}

function runProbe(port, version = '1.0') {
  return runProbeArgs([`127.0.0.1:${port}`, version]);
}

describe('REQ-OPS-005: legacy-TLS probe reports the server answer', () => {
  let servers = [];
  after(() => servers.forEach((s) => s.close()));

  it('passes when the server refuses the version with an alert', async () => {
    const server = await serveOnce(ALERT_PROTOCOL_VERSION);
    servers.push(server);
    const result = await runProbe(server.address().port);
    assert.equal(result.status, EXIT.refused, result.stdout + result.stderr + result.detail);
    assert.match(result.stdout, /^PASS:/);
  });

  it('fails when the server accepts the version and returns a ServerHello', async () => {
    const server = await serveOnce(SERVER_HELLO);
    servers.push(server);
    const result = await runProbe(server.address().port);
    assert.equal(result.status, EXIT.accepted, result.stdout + result.stderr + result.detail);
    assert.match(result.stdout, /^FAIL:/);
    // The version reported must be the one the ServerHello negotiated, not the
    // record layer's -- the fixture makes them differ so this can fail.
    assert.match(result.stdout, /\b3\.1\b/);
    assert.doesNotMatch(result.stdout, /\b3\.3\b/);
  });

  it('is inconclusive, never a pass, on an alert that is not about the version', async () => {
    const server = await serveOnce(ALERT_HANDSHAKE_FAILURE);
    servers.push(server);
    const result = await runProbe(server.address().port);
    assert.equal(result.status, EXIT.inconclusive, result.stdout + result.stderr + result.detail);
    assert.doesNotMatch(result.stdout, /^PASS:/);
  });

  it('is inconclusive, never a pass, when the server closes without answering', async () => {
    const server = await serveOnce(null);
    servers.push(server);
    const result = await runProbe(server.address().port);
    assert.equal(result.status, EXIT.inconclusive, result.stdout + result.stderr + result.detail);
    assert.doesNotMatch(result.stdout, /^PASS:/);
  });

  it('is inconclusive, never a pass, when nothing is listening', async () => {
    const result = await runProbe(1);
    assert.equal(result.status, EXIT.inconclusive, result.stdout + result.stderr + result.detail);
    assert.doesNotMatch(result.stdout, /^PASS:/);
  });

  it('is inconclusive, never a pass, on a record it cannot classify', async () => {
    const server = await serveOnce(Buffer.from([0x99, 0x03, 0x01, 0x00, 0x02, 0x00, 0x00]));
    servers.push(server);
    const result = await runProbe(server.address().port);
    assert.equal(result.status, EXIT.inconclusive, result.stdout + result.stderr + result.detail);
    assert.doesNotMatch(result.stdout, /^PASS:/);
  });

  it('rejects a version it has no ClientHello for', async () => {
    const result = await runProbeArgs(['127.0.0.1:443', '1.2']);
    assert.equal(result.status, EXIT.inconclusive);
  });
});
