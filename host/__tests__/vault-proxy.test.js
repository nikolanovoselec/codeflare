// Real behavioral tests for REQ-VAULT-005 AC5 (in-container HTTP /vault
// prefix-strip branch + WS passthrough scoped to vault paths).
//
// The prefix-strip is the load-bearing transform shared by both the HTTP
// proxy branch and the WebSocket upgrade passthrough in server.ts. It was
// extracted into the pure host/src/vault-proxy.ts module (server.ts boots a
// listening server on import, so it cannot be imported into a unit test —
// exactly why auth-check.ts was extracted). We import the compiled module and
// assert the upstream path SilverBullet actually receives for each shape.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { stripVaultPrefix } from '../dist/vault-proxy.js';

describe('stripVaultPrefix / REQ-VAULT-005 AC5 (/vault prefix-strip before forwarding to SilverBullet)', () => {
  it('bare /vault maps to root /', () => {
    assert.equal(stripVaultPrefix('/vault'), '/');
  });

  it('trailing-slash /vault/ maps to root /', () => {
    assert.equal(stripVaultPrefix('/vault/'), '/');
  });

  it('strips the /vault prefix from a nested path', () => {
    assert.equal(stripVaultPrefix('/vault/index/foo'), '/index/foo');
  });

  it('preserves a leading dot-segment after the strip (SilverBullet client assets)', () => {
    assert.equal(stripVaultPrefix('/vault/.client/client.js'), '/.client/client.js');
  });

  it('preserves the canonical service-worker path after the strip', () => {
    assert.equal(stripVaultPrefix('/vault/service_worker.js'), '/service_worker.js');
  });

  it('does NOT strip a non-vault prefix (only the literal /vault segment)', () => {
    // "/vaulting/x" -> slice(6) -> "ing/x". This documents that the strip is a
    // raw prefix slice; the server-side guard (pathname === '/vault' ||
    // startsWith('/vault/')) is what scopes the branch, not this helper.
    assert.equal(stripVaultPrefix('/vaulting/x'), 'ing/x');
  });

  it('null pathname falls back to root / (WS upgrade with unparsable url)', () => {
    assert.equal(stripVaultPrefix(null), '/');
  });

  it('undefined pathname falls back to root /', () => {
    assert.equal(stripVaultPrefix(undefined), '/');
  });
});
