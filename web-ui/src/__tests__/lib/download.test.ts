import { describe, it, expect, vi, beforeEach } from 'vitest';
import { downloadFile } from '../../lib/download';

// Isolate the helper: a fixed download URL, and a quiet logger (the failure path logs).
vi.mock('../../api/storage', () => ({
  getDownloadUrl: (key: string) => `https://example.test/download?key=${encodeURIComponent(key)}`,
}));
vi.mock('../../lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('downloadFile (REQ-ENTERPRISE-019 view-only backstop)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:mock');
    globalThis.URL.revokeObjectURL = vi.fn();
  });

  it("returns 'blocked' on a 403 carrying code DOWNLOADS_DISABLED (so callers show the notice, never a raw failure)", async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(403, { error: 'x', code: 'DOWNLOADS_DISABLED' }));
    expect(await downloadFile('docs/readme.md')).toBe('blocked');
  });

  it("returns 'failed' on a 403 WITHOUT the DOWNLOADS_DISABLED code (a generic/auth forbidden is not mislabeled as view-only)", async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(403, { error: 'x', code: 'FORBIDDEN' }));
    expect(await downloadFile('docs/readme.md')).toBe('failed');
  });

  it("returns 'failed' on a non-403 error (e.g. 500)", async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 500 }));
    expect(await downloadFile('docs/readme.md')).toBe('failed');
  });

  it("returns 'ok' and triggers a blob download on 200", async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('content', { status: 200 }));
    expect(await downloadFile('docs/readme.md')).toBe('ok');
    expect(globalThis.URL.createObjectURL).toHaveBeenCalled();
  });
});
