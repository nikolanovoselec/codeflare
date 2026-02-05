/**
 * Shared mock factories for frontend tests.
 *
 * Provides factory functions that return fully valid default objects with
 * optional partial overrides via spread merging.
 */
import type { Session, UserInfo, TabConfig } from '../../types';

// ── Mock Session ──────────────────────────────────────────────────────────────

/**
 * Create a mock Session object with sensible defaults.
 *
 * @example
 *   createMockSession()                                 // default running session
 *   createMockSession({ status: 'stopped' })            // stopped session
 *   createMockSession({ id: 'abc', name: 'My Sess' })  // custom session
 */
export function createMockSession(overrides?: Partial<Session>): Session {
  const now = new Date().toISOString();
  return {
    id: 'test-session-1',
    name: 'Test Session',
    createdAt: now,
    lastAccessedAt: now,
    status: 'running',
    ...overrides,
  };
}

// ── Mock UserInfo ─────────────────────────────────────────────────────────────

/**
 * Create a mock UserInfo object.
 *
 * @example
 *   createMockUserInfo()
 *   createMockUserInfo({ role: 'admin' })
 */
export function createMockUserInfo(overrides?: Partial<UserInfo>): UserInfo {
  return {
    email: 'test@example.com',
    authenticated: true,
    bucketName: 'test-bucket',
    ...overrides,
  };
}

// ── Mock Fetch Response ───────────────────────────────────────────────────────

/**
 * Create a mock fetch Response with JSON body.
 *
 * @example
 *   createMockFetchResponse({ objects: [], prefixes: [], isTruncated: false })
 *   createMockFetchResponse({ error: 'Forbidden' }, 403)
 */
export function createMockFetchResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Create a mock error fetch Response.
 *
 * @example
 *   createMockErrorResponse('Not found', 404)
 */
export function createMockErrorResponse(error: string, status: number): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ── Mock Tab Config ───────────────────────────────────────────────────────────

/**
 * Create a mock TabConfig entry.
 */
export function createMockTabConfig(overrides?: Partial<TabConfig>): TabConfig {
  return {
    id: '1',
    command: '',
    label: 'Terminal 1',
    ...overrides,
  };
}

// ── Mock File Preview Data ────────────────────────────────────────────────────

interface PreviewFile {
  key: string;
  type: 'text' | 'image' | 'binary';
  content?: string;
  url?: string;
  size: number;
  lastModified: string;
}

/**
 * Create a mock file preview object for FilePreview component tests.
 *
 * @example
 *   createMockPreviewFile()                                    // text file
 *   createMockPreviewFile({ type: 'image', url: '...' })       // image file
 *   createMockPreviewFile({ type: 'binary', size: 1048576 })   // binary file
 */
export function createMockPreviewFile(overrides?: Partial<PreviewFile>): PreviewFile {
  return {
    key: 'workspace/test.txt',
    type: 'text',
    content: 'Hello, world!',
    size: 13,
    lastModified: '2025-01-15T10:30:00Z',
    ...overrides,
  };
}
