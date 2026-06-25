import { describe, it, expect } from 'vitest';
import { validateVaultRoute } from '../../routes/vault-validation';
import { readVaultSidCookie } from '../../routes/vault-html';

const TOKEN = 'a'.repeat(32); // 32-hex bucket token
const SID = 'abcdef1234567890'; // 16-char session id

function req(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://codeflare.ch${path}`, { headers: new Headers(headers) });
}

// REQ-VAULT-021: the first path segment selects the path shape. A 32-hex token →
// bucket-stable serving path (session id from cookie); an 8-24 char sid → the
// session-keyed entry/status path.
describe('validateVaultRoute bucket-stable dispatch (REQ-VAULT-021)', () => {
  it('parses a 32-hex first segment as the bucket token serving path', () => {
    const r = validateVaultRoute(req(`/api/vault/${TOKEN}/notes/foo.md`));
    expect(r.isVaultRoute).toBe(true);
    expect(r.bucketToken).toBe(TOKEN);
    expect(r.sessionId).toBeUndefined();
    expect(r.remainingPath).toBe('/notes/foo.md');
  });

  it('parses a session id first segment as the session-keyed path', () => {
    const r = validateVaultRoute(req(`/api/vault/${SID}/index.html`));
    expect(r.isVaultRoute).toBe(true);
    expect(r.sessionId).toBe(SID);
    expect(r.bucketToken).toBeUndefined();
    expect(r.remainingPath).toBe('/index.html');
  });

  it('rejects a first segment that is neither a session id nor a bucket token', () => {
    const r = validateVaultRoute(req('/api/vault/BAD..ID/x'));
    expect(r.isVaultRoute).toBe(true);
    expect(r.errorResponse?.status).toBe(400);
  });

  it('classifies a WebSocket upgrade on the bucket-stable path', () => {
    const r = validateVaultRoute(req(`/api/vault/${TOKEN}/.client/ws`, { Upgrade: 'websocket' }));
    expect(r.bucketToken).toBe(TOKEN);
    expect(r.isWebSocket).toBe(true);
  });
});

describe('readVaultSidCookie (REQ-VAULT-021 routing cookie)', () => {
  it('extracts the cf_vault_sid value from among other cookies', () => {
    expect(readVaultSidCookie(req('/x', { Cookie: `foo=1; cf_vault_sid=${SID}; bar=2` }))).toBe(SID);
  });

  it('returns null when the cookie or header is absent', () => {
    expect(readVaultSidCookie(req('/x', { Cookie: 'foo=1' }))).toBeNull();
    expect(readVaultSidCookie(req('/x'))).toBeNull();
  });
});
