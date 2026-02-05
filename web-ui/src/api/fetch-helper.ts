import { ZodType } from 'zod';

export class ApiError extends Error {
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
    try {
      if (body) {
        const parsed = JSON.parse(body);
        if (parsed.error) errorMessage = parsed.error;
      }
    } catch {
      // Not JSON, use raw text
    }
    throw new ApiError(
      errorMessage,
      response.status,
      response.statusText,
      body
    );
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
