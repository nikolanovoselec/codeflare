import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { queryHerdrScroll } from '../dist/herdr-scroll-query.js';

function response(offset) {
  return JSON.stringify({
    id: 'codeflare-scroll',
    result: {
      type: 'pane_current',
      pane: {
        pane_id: 'w1:p1',
        scroll: {
          offset_from_bottom: offset,
          max_offset_from_bottom: 100,
          viewport_rows: 24,
        },
      },
    },
  }) + '\n';
}

async function withSocket(handler, test) {
  const dir = mkdtempSync(join(tmpdir(), 'codeflare-herdr-query-'));
  const socketPath = join(dir, 'herdr.sock');
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    await test(socketPath);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('Herdr focused-pane scroll query', () => {
  it('parses a fragmented pane.current response', async () => {
    await withSocket((socket) => {
      socket.once('data', (request) => {
        assert.deepEqual(JSON.parse(request.toString().trim()), {
          id: 'codeflare-scroll', method: 'pane.current', params: {},
        });
        const line = response(7);
        socket.write(line.slice(0, 19));
        socket.end(line.slice(19));
      });
    }, async (socketPath) => {
      assert.equal(await queryHerdrScroll(socketPath), true);
    });
  });

  it('returns bottom state and fails open on malformed or unavailable responses', async () => {
    await withSocket((socket) => socket.once('data', () => socket.end(response(0))), async (socketPath) => {
      assert.equal(await queryHerdrScroll(socketPath), false);
    });
    await withSocket((socket) => socket.once('data', () => socket.end('{bad}\n')), async (socketPath) => {
      assert.equal(await queryHerdrScroll(socketPath), null);
    });
    assert.equal(await queryHerdrScroll('/missing/herdr.sock', 10), null);
  });
});
