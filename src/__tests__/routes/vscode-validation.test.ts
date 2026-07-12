import { describe, it, expect } from 'vitest';
import { validateVscodeRoute } from '../../routes/vscode-validation';

function req(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://codeflare.ch${path}`, { headers: new Headers(headers) });
}

const SID = 'abcdef1234567890'; // 16-char session id (matches SESSION_ID_PATTERN)

describe('validateVscodeRoute (REQ-IDE-001, REQ-IDE-002)', () => {
  it('REQ-IDE-001: parses /api/vscode/:sid/... as an HTTP route with the remaining path', () => {
    const r = validateVscodeRoute(req(`/api/vscode/${SID}/stable/out/main.js`));
    expect(r.isVscodeRoute).toBe(true);
    expect(r.sessionId).toBe(SID);
    expect(r.remainingPath).toBe('/stable/out/main.js');
    expect(r.isWebSocket).toBe(false);
    expect(r.errorResponse).toBeUndefined();
  });

  it('REQ-IDE-001: classifies a WebSocket upgrade (the VS Code server protocol)', () => {
    const r = validateVscodeRoute(req(`/api/vscode/${SID}/vscode-remote-resource`, { Upgrade: 'websocket' }));
    expect(r.isWebSocket).toBe(true);
    expect(r.sessionId).toBe(SID);
  });

  it('REQ-IDE-001: handles a case-insensitive Upgrade header', () => {
    const r = validateVscodeRoute(req(`/api/vscode/${SID}/x`, { Upgrade: 'WebSocket' }));
    expect(r.isWebSocket).toBe(true);
  });

  it('REQ-IDE-001: preserves a deep remaining path verbatim', () => {
    const r = validateVscodeRoute(req(`/api/vscode/${SID}/static/sources/foo/bar.ts`));
    expect(r.remainingPath).toBe('/static/sources/foo/bar.ts');
  });

  it('REQ-IDE-001: returns isVscodeRoute=false for non-vscode paths', () => {
    expect(validateVscodeRoute(req('/api/vault/abcdef12/x')).isVscodeRoute).toBe(false);
    expect(validateVscodeRoute(req('/api/terminal/abcdef12/ws')).isVscodeRoute).toBe(false);
    expect(validateVscodeRoute(req('/api/sessions')).isVscodeRoute).toBe(false);
  });

  it('REQ-IDE-001: rejects a bare /api/vscode/:sid with no trailing path', () => {
    expect(validateVscodeRoute(req(`/api/vscode/${SID}`)).isVscodeRoute).toBe(false);
  });

  it('REQ-IDE-001: rejects a first segment that fails SESSION_ID_PATTERN with a 400', () => {
    const r = validateVscodeRoute(req('/api/vscode/BAD-ID/x'));
    expect(r.isVscodeRoute).toBe(true);
    expect(r.errorResponse).toBeDefined();
    expect(r.errorResponse?.status).toBe(400);
  });

  // REQ-IDE-002: session-keyed ONLY. Unlike the Vault (REQ-VAULT-021), a
  // 32-hex bucket-token-shaped first segment is NOT a special serving path --
  // it simply fails SESSION_ID_PATTERN (too long) and is rejected, and the
  // result never carries a bucketToken. The sessionId is the sole selector,
  // which is what isolates each session's editor.
  it('REQ-IDE-002: a 32-hex bucket-token-shaped segment is rejected, not routed as a bucket path', () => {
    const token = 'a'.repeat(32);
    const r = validateVscodeRoute(req(`/api/vscode/${token}/notes`));
    expect(r.isVscodeRoute).toBe(true);
    expect(r.errorResponse?.status).toBe(400);
    expect((r as unknown as Record<string, unknown>).bucketToken).toBeUndefined();
    expect(r.sessionId).toBeUndefined();
  });

  it('REQ-IDE-002: a valid route result carries a sessionId and never a bucketToken', () => {
    const r = validateVscodeRoute(req(`/api/vscode/${SID}/x`));
    expect(r.sessionId).toBe(SID);
    expect((r as unknown as Record<string, unknown>).bucketToken).toBeUndefined();
  });
});
