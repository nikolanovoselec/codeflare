// REQ-OPS-005: the weekly pentest's legacy-TLS check must report on the server,
// not on whatever the runner's TLS library is willing to offer.
//
// Each case stands up a TCP server that answers a real ClientHello with one of
// the four things a server can do, and asserts the probe's exit code. The two
// that matter are opposites: a refusing server must pass, and an ACCEPTING
// server must fail. Without the accepting case a probe that always printed PASS
// would look correct, which is exactly how this check shipped broken twice.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROBE = resolve(__dirname, '../../scripts/ci/tls-legacy-probe.py');

const EXIT = { refused: 0, accepted: 1, inconclusive: 2 };

// A fatal alert record: content type 21, TLS 1.0, level fatal, protocol_version.
const ALERT_PROTOCOL_VERSION = Buffer.from([0x15, 0x03, 0x01, 0x00, 0x02, 0x02, 0x46]);
// A handshake record whose body is a ServerHello: the server agreed to speak it.
const SERVER_HELLO = Buffer.from([0x16, 0x03, 0x01, 0x00, 0x04, 0x02, 0x00, 0x00, 0x00]);

/** Serve one canned reply, or close on null, then stop. */
function serveOnce(reply) {
  const server = net.createServer((socket) => {
    socket.once('data', () => {
      if (reply) socket.write(reply);
      socket.end();
    });
  });
  return new Promise((ready) => server.listen(0, '127.0.0.1', () => ready(server)));
}

function runProbe(port, version = '1.0') {
  // The probe resolves its own port from the host argument's suffix so the
  // test can point it at an ephemeral listener without a second parameter.
  return spawnSync('python3', [PROBE, `127.0.0.1:${port}`, version], { encoding: 'utf8' });
}

describe('REQ-OPS-005: legacy-TLS probe reports the server answer', () => {
  let servers = [];
  after(() => servers.forEach((s) => s.close()));

  it('passes when the server refuses the version with an alert', async () => {
    const server = await serveOnce(ALERT_PROTOCOL_VERSION);
    servers.push(server);
    const result = runProbe(server.address().port);
    assert.equal(result.status, EXIT.refused, result.stdout + result.stderr);
    assert.match(result.stdout, /^PASS:/);
  });

  it('fails when the server accepts the version and returns a ServerHello', async () => {
    const server = await serveOnce(SERVER_HELLO);
    servers.push(server);
    const result = runProbe(server.address().port);
    assert.equal(result.status, EXIT.accepted, result.stdout + result.stderr);
    assert.match(result.stdout, /^FAIL:/);
  });

  it('passes when the server refuses by closing without answering', async () => {
    const server = await serveOnce(null);
    servers.push(server);
    const result = runProbe(server.address().port);
    assert.equal(result.status, EXIT.refused, result.stdout + result.stderr);
  });

  it('is inconclusive, never a pass, when nothing is listening', () => {
    const result = runProbe(1);
    assert.equal(result.status, EXIT.inconclusive, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout, /^PASS:/);
  });

  it('is inconclusive, never a pass, on a record it cannot classify', async () => {
    const server = await serveOnce(Buffer.from([0x99, 0x03, 0x01, 0x00, 0x02, 0x00, 0x00]));
    servers.push(server);
    const result = runProbe(server.address().port);
    assert.equal(result.status, EXIT.inconclusive, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout, /^PASS:/);
  });

  it('rejects a version it has no ClientHello for', () => {
    const result = spawnSync('python3', [PROBE, '127.0.0.1:443', '1.2'], { encoding: 'utf8' });
    assert.equal(result.status, EXIT.inconclusive);
  });
});
