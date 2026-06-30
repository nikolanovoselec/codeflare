import { ZodType } from 'zod';

export class ApiError extends Error {
  public steps?: Array<{ step: string; status: string; error?: string }>;
  /** Error code from backend (e.g., QUOTA_EXCEEDED, PENDING, BLOCKED) */
  public code?: string;
  /** Set when this 401 already triggered a redirect to sign-in. The UI should
   *  render a calm "redirecting" state rather than an error page, and callers
   *  must still let the rejection settle (never hang) — REQ-AUTH-022 AC1. */
  public authRedirect?: boolean;

  constructor(
    message: string,
    public status: number,
    public statusText: string,
    public body?: unknown
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface BaseFetchOptions {
  credentials?: RequestCredentials;
  schema?: ZodType;
  basePath?: string;
}

export async function baseFetch<T>(
  url: string,
  init: RequestInit,
  options: BaseFetchOptions = {}
): Promise<T> {
  const finalUrl = options.basePath ? `${options.basePath}${url}` : url;
  const response = await fetch(finalUrl, {
    ...init,
    credentials: options.credentials ?? 'include',
    redirect: 'manual',
    headers: {
      'X-Requested-With': 'XMLHttpRequest',
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });

  // Detect CF Access auth redirects: when a session cookie expires, CF Access
  // returns a 302 to its login page. With redirect:'manual' this surfaces as a
  // 3xx (or status 0 for opaque redirects) instead of silently following to HTML
  // — which previously caused JSON parse failures and, with CF Access's injected
  // scripts, a full page reload.
  if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
    throw new ApiError(
      'Authentication redirect detected — session may have expired',
      401,
      'Unauthorized'
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => undefined);
    let errorMessage = body || `HTTP ${response.status}`;
    let steps: Array<{ step: string; status: string; error?: string }> | undefined;

    // Detect HTML error pages (e.g., CF Access login page returned as 403).
    // Show a clean auth message instead of dumping raw HTML into the UI.
    if (body && /^\s*<!doctype\s|^\s*<html[\s>]/i.test(body)) {
      throw new ApiError(
        'Authentication expired — please refresh the page to log in again',
        401,
        'Unauthorized'
      );
    }

    // Auto-redirect to login on 401 (expired session cookie).
    // Only redirect from authenticated pages (/app/*, /admin/*).
    // Login page (/, /login) and public pages handle 401 in their own error flow.
    // REQ-AUTH-022 AC1: redirect via location.replace (not href, so Back does not
    // return to the dead page) AND throw an authRedirect-tagged ApiError. The old
    // never-resolving promise hung the bootstrap promise, leaving the SPA stuck on
    // its loading shell = the blank/white page on return-from-background.
    if (response.status === 401) {
      const path = window.location.pathname;
      if (path.startsWith('/app/') || path.startsWith('/admin/')) {
        try { window.location.replace('/'); } catch { /* non-browser/test env */ }
        const redirectErr = new ApiError(
          'Session expired — redirecting to sign in',
          401,
          'Unauthorized',
          body
        );
        redirectErr.authRedirect = true;
        throw redirectErr;
      }
    }

    let code: string | undefined;
    try {
      if (body) {
        const parsed = JSON.parse(body);
        if (parsed.error) errorMessage = parsed.error;
        if (Array.isArray(parsed.steps)) steps = parsed.steps;
        if (typeof parsed.code === 'string') code = parsed.code;
      }
    } catch {
      // Not JSON, use raw text
    }
    const apiError = new ApiError(
      errorMessage,
      response.status,
      response.statusText,
      body
    );
    if (steps) apiError.steps = steps;
    if (code) apiError.code = code;
    throw apiError;
  }

  const text = await response.text();
  if (!text) {
    if (options.schema) {
      throw new ApiError(
        'Expected response body but received empty response',
        response.status,
        response.statusText
      );
    }
    return undefined as T;
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ApiError(
      'Invalid JSON response from server',
      response.status,
      response.statusText
    );
  }

  if (options.schema) {
    return options.schema.parse(data) as T;
  }
  return data as T;
}
